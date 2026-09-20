<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as moonbitMode from "@moonbit/moonpad-monaco";
import * as monaco from "monaco-editor-core";
import MonacoEditorWorker from "monaco-editor-core/esm/vs/editor/editor.worker?worker";
import { checkMocketProjectInBrowser, type MoonBitDiagnostic } from "../lib/moonbitCompiler";
import { getMocketJavaScriptArtifacts } from "../lib/mocketArtifacts";

type TraceEvent =
  | { kind: "success"; filePath: string; output: string }
  | { kind: "error"; filePath: string; message: string };

const props = defineProps<{
  modelValue: string;
  filePath: string;
  projectFiles: Record<string, string>;
  dependencyAware: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  trace: [event: TraceEvent];
  ready: [];
}>();

const host = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let model: monaco.editor.ITextModel | undefined;
let muted = false;
let traceTimer: ReturnType<typeof setTimeout> | undefined;
let latestTrace = 0;

// Moonpad registers MoonBit tokens, language configuration, diagnostics and the
// in-browser compiler. Version 0.2.0 does not ship a Monaco completion provider.
moonbitMode.init({
  onigWasmUrl: new URL("@moonbit/moonpad-monaco/onig.wasm", import.meta.url).toString(),
});
const trace = moonbitMode.traceCommandFactory();

(self as typeof globalThis & { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker: () => new MonacoEditorWorker(),
};

function isMoonBitFile(path: string) {
  return path.endsWith(".mbt");
}

function languageForPath(path: string) {
  return isMoonBitFile(path) ? "moonbit" : "plaintext";
}

function pathMatchesModel(path: string | undefined, currentModel: monaco.editor.ITextModel) {
  if (!path) return true;
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const modelPath = currentModel.uri.path.replace(/^\/+/, "");
  const filename = normalized.split("/").at(-1);
  return (
    normalized === modelPath ||
    normalized.endsWith(`/${modelPath}`) ||
    modelPath.endsWith(`/${normalized}`) ||
    filename === modelPath.split("/").at(-1)
  );
}

function markerForDiagnostic(
  diagnostic: MoonBitDiagnostic,
  currentModel: monaco.editor.ITextModel,
): monaco.editor.IMarkerData {
  const maxLine = currentModel.getLineCount();
  const startLineNumber = Math.max(1, Math.min(diagnostic.start?.line ?? 1, maxLine));
  const endLineNumber = Math.max(
    startLineNumber,
    Math.min(diagnostic.end?.line ?? startLineNumber, maxLine),
  );
  const startColumn = Math.max(
    1,
    Math.min(diagnostic.start?.col ?? 1, currentModel.getLineMaxColumn(startLineNumber)),
  );
  const endColumn = Math.max(
    startColumn + 1,
    Math.min(diagnostic.end?.col ?? startColumn + 1, currentModel.getLineMaxColumn(endLineNumber)),
  );
  return {
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
    message: diagnostic.message,
    code: diagnostic.errorCode?.toString(),
    source: "MoonBit",
    severity:
      diagnostic.level === "warning"
        ? monaco.MarkerSeverity.Warning
        : diagnostic.level === "info"
          ? monaco.MarkerSeverity.Info
          : monaco.MarkerSeverity.Error,
  };
}

function isMocketCompilerEntrypointNoise(diagnostic: MoonBitDiagnostic) {
  return (
    diagnostic.errorCode === 67 ||
    /Main function is already defined at .*main\.mbt:1:1\.$/.test(diagnostic.message)
  );
}

function setDependencyMarkers(
  currentModel: monaco.editor.ITextModel,
  diagnostics: MoonBitDiagnostic[],
) {
  const markers = diagnostics
    .filter((diagnostic) => pathMatchesModel(diagnostic.path, currentModel))
    .map((diagnostic) => markerForDiagnostic(diagnostic, currentModel));
  monaco.editor.setModelMarkers(currentModel, "moonbit", []);
  monaco.editor.setModelMarkers(currentModel, "moonbit-mocket", markers);
}

function clearDependencyMarkers(currentModel: monaco.editor.ITextModel) {
  monaco.editor.setModelMarkers(currentModel, "moonbit-mocket", []);
}

/**
 * moonpad-monaco currently supplies compiler diagnostics but does not expose a
 * `moon fmt` API. Keep this deliberately conservative: it normalizes leading
 * indentation only and never rewrites MoonBit expressions or comments.
 */
function formatMoonBitIndentation(source: string) {
  let level = 0;
  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (/^[})\]]/.test(trimmed)) level = Math.max(0, level - 1);
      const formatted = `${"  ".repeat(level)}${trimmed}`;
      const openings = (trimmed.match(/[({[]/g) ?? []).length;
      const closings = (trimmed.match(/[)}\]]/g) ?? []).length;
      level = Math.max(0, level + openings - closings);
      return formatted;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function scheduleTrace(delay = 220) {
  if (!model || !isMoonBitFile(props.filePath)) return;
  if (traceTimer) clearTimeout(traceTimer);
  traceTimer = setTimeout(() => void traceCurrentModel(), delay);
}

async function checkDependencyAwareProject(
  currentModel: monaco.editor.ITextModel,
  traceId: number,
  version: number,
  filePath: string,
) {
  const projectFiles = { ...props.projectFiles, [filePath]: currentModel.getValue() };
  const result = await checkMocketProjectInBrowser({
    files: projectFiles,
    artifacts: await getMocketJavaScriptArtifacts(),
  });
  const isCurrent =
    traceId === latestTrace &&
    currentModel === model &&
    version === currentModel.getVersionId() &&
    filePath === props.filePath;
  if (!isCurrent) return undefined;

  // moonpad's private buildPackage call has no moon.pkg input. For an
  // executable async fn main it can emit compiler error 67 even though the
  // same source links and runs through linkMocketProject. Suppress only that
  // bridge artifact; Mocket and async package diagnostics remain visible.
  const diagnostics = result.diagnostics.filter(
    (diagnostic) => !isMocketCompilerEntrypointNoise(diagnostic),
  );
  setDependencyMarkers(currentModel, diagnostics);
  const hasActionableError = diagnostics.some((diagnostic) => diagnostic.level === "error");
  if (result.kind === "error" && hasActionableError) {
    const message =
      diagnostics.map((diagnostic) => diagnostic.message).join("\n") || result.message;
    emit("trace", { kind: "error", filePath, message });
    return undefined;
  }

  const warningCount = diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
  emit("trace", {
    kind: "success",
    filePath,
    output: warningCount
      ? `Mocket + async workspace check passed with ${warningCount} warning${warningCount === 1 ? "" : "s"}.`
      : "Mocket + async workspace check passed.",
  });
  return "";
}

async function traceCurrentModel() {
  if (!model || !isMoonBitFile(props.filePath)) return undefined;
  const traceId = ++latestTrace;
  const currentModel = model;
  const version = currentModel.getVersionId();
  const filePath = props.filePath;
  try {
    // Moonpad's public trace service is strictly single-file. For a Mocket
    // project, call its bundled compiler primitive with the same injected .mi
    // interfaces used by Run, then publish diagnostics back to Monaco.
    if (props.dependencyAware) {
      return await checkDependencyAwareProject(currentModel, traceId, version, filePath);
    }

    clearDependencyMarkers(currentModel);
    // `traceCommandFactory` is the same trace path used by MoonBit Tour. It
    // places value decorations in Monaco and returns stdout for the console.
    const output = await trace(currentModel.uri.toString());
    if (
      traceId !== latestTrace ||
      currentModel !== model ||
      version !== currentModel.getVersionId() ||
      filePath !== props.filePath ||
      output === undefined
    )
      return undefined;
    emit("trace", { kind: "success", filePath, output });
    return output;
  } catch (error) {
    if (
      traceId === latestTrace &&
      currentModel === model &&
      version === currentModel.getVersionId() &&
      filePath === props.filePath
    ) {
      const message = error instanceof Error ? error.message : String(error);
      emit("trace", { kind: "error", filePath, message });
    }
    return undefined;
  }
}

function createModel(value: string, path: string) {
  model?.dispose();
  model = monaco.editor.createModel(value, languageForPath(path), monaco.Uri.file(path));
  editor?.setModel(model);
  model.onDidChangeContent(() => {
    if (!muted) emit("update:modelValue", model?.getValue() ?? "");
    scheduleTrace();
  });
  scheduleTrace(0);
}

async function formatDocument() {
  if (!editor || !model || !isMoonBitFile(props.filePath)) return;
  const range = model.getFullModelRange();
  const formatted = formatMoonBitIndentation(model.getValue());
  if (formatted === model.getValue()) return;
  editor.executeEdits("moonbit-format-indentation", [
    { range, text: formatted, forceMoveMarkers: true },
  ]);
}

onMounted(() => {
  editor = monaco.editor.create(host.value!, {
    automaticLayout: true,
    fontFamily: "'DM Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    lineHeight: 20,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    padding: { top: 12 },
    renderLineHighlight: "line",
    tabSize: 2,
    // Moonpad 0.2.0 has no completion provider. Do not surface Monaco's
    // unrelated word suggestions as if they were MoonBit language completions.
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    wordBasedSuggestions: "off",
    theme: "dark-plus",
  });
  createModel(props.modelValue, props.filePath);
  editor.addAction({
    id: "moonbit.format-document",
    label: "Format MoonBit indentation",
    keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
    run: () => formatDocument(),
  });
  emit("ready");
});

watch(
  () => props.filePath,
  (path) => {
    if (editor) createModel(props.modelValue, path);
  },
);

watch(
  () => props.modelValue,
  (value) => {
    if (!model || model.getValue() === value) return;
    muted = true;
    model.setValue(value);
    muted = false;
  },
);

watch(
  () => props.dependencyAware,
  () => scheduleTrace(0),
);

async function traceMain() {
  return traceCurrentModel();
}

defineExpose({ formatDocument, traceMain });

onBeforeUnmount(() => {
  if (traceTimer) clearTimeout(traceTimer);
  latestTrace++;
  model?.dispose();
  editor?.dispose();
});
</script>

<template>
  <div ref="host" class="moonbit-editor" aria-label="MoonBit Monaco editor"></div>
</template>

<style scoped>
.moonbit-editor {
  width: 100%;
  height: 100%;
  min-height: 0;
}
</style>

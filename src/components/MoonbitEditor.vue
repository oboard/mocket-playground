<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as moonbitMode from "@moonbit/moonpad-monaco";
import * as monaco from "monaco-editor-core";
import MonacoEditorWorker from "monaco-editor-core/esm/vs/editor/editor.worker?worker";

type TraceEvent =
  | { kind: "success"; filePath: string; output: string }
  | { kind: "error"; filePath: string; message: string };

const props = defineProps<{ modelValue: string; filePath: string }>();
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

// This is the MoonBit Tour integration: it registers MoonBit tokens, language
// configuration, diagnostics, completions, hover and the in-browser compiler.
const moonpad = moonbitMode.init({
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

/**
 * moonpad-monaco currently supplies compiler/LSP features but does not expose a
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

function scheduleTrace(delay = 140) {
  if (!model || !isMoonBitFile(props.filePath)) return;
  if (traceTimer) clearTimeout(traceTimer);
  traceTimer = setTimeout(() => void traceCurrentModel(), delay);
}

async function traceCurrentModel() {
  if (!model || !isMoonBitFile(props.filePath)) return undefined;
  const traceId = ++latestTrace;
  const currentModel = model;
  const version = currentModel.getVersionId();
  const filePath = props.filePath;
  try {
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
    quickSuggestions: { other: true, comments: false, strings: false },
    suggest: { showMethods: true, showFunctions: true, showFields: true },
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

async function runSingleFile() {
  return moonpad.runSingleFile({
    code: model?.getValue() ?? props.modelValue,
    filename: props.filePath.split("/").pop(),
    debugMain: true,
  });
}

async function traceMain() {
  return traceCurrentModel();
}

defineExpose({ formatDocument, runSingleFile, traceMain });

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

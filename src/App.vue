<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { WebContainer, type FileSystemTree } from "@webcontainer/api";
import MoonbitEditor from "./components/MoonbitEditor.vue";
import WebTerminal from "./components/WebTerminal.vue";
import ApiClient from "./components/ApiClient.vue";
import {
  checkMocketProjectInBrowser,
  compileMocketToJavaScript,
  compileMoonBitToJavaScript,
} from "./lib/moonbitCompiler";
import { getMocketJavaScriptArtifacts } from "./lib/mocketArtifacts";
import { installMoonbitWasmToolchain, moonbitWasmToolchainBin } from "./lib/moonbitWasmToolchain";
import { startMoonWebBridge, type MoonWebRequest, type MoonWebResponse } from "./lib/moonWebBridge";
import { examples, getExample, type ExampleId } from "./examples";
import AddRegular from "@mingcute/vue/core-regular/add";
import ArrowRightRegular from "@mingcute/vue/core-regular/arrow-right";
import CloseRegular from "@mingcute/vue/core-regular/close";
import CodeRegular from "@mingcute/vue/core-regular/code";
import CommandRegular from "@mingcute/vue/core-regular/command";
import CornerUpRightRegular from "@mingcute/vue/core-regular/corner-up-right";
import Delete2Regular from "@mingcute/vue/core-regular/delete-2";
import DownRegular from "@mingcute/vue/core-regular/down";
import FileRegular from "@mingcute/vue/core-regular/file";
import FlashRegular from "@mingcute/vue/core-regular/flash";
import FolderOpenRegular from "@mingcute/vue/core-regular/folder-open";
import FolderRegular from "@mingcute/vue/core-regular/folder";
import MoreRegular from "@mingcute/vue/core-filled/more-1";
import PlayFilled from "@mingcute/vue/core-filled/play";
import Refresh3Regular from "@mingcute/vue/core-regular/refresh-3";

type EntryKind = "file" | "folder";
type FileEntry = { name: string; path: string; kind: EntryKind; depth: number };
type ExplorerNode = { name: string; path: string; kind: EntryKind; children: ExplorerNode[] };
type CompilerState = "idle" | "compiling" | "success" | "error";
type TraceEvent =
  | { kind: "success"; filePath: string; output: string }
  | { kind: "error"; filePath: string; message: string };
type MoonbitEditorApi = {
  formatDocument: () => Promise<void>;
  traceMain: () => Promise<string | undefined>;
};

const files = ref<Record<string, string>>({
  "/moon.mod": `name = "playground/mocket-starter"
version = "0.1.0"
preferred_target = "js"
`,
  "/moon.pkg": `import {
  "moonbitlang/async",
  "oboard/mocket",
  "oboard/mocket/cors",
}

supported_targets = "+js"

pkgtype(kind: "executable")
`,
  "/main.mbt": `async fn main {
  let app = @mocket.App()

  app.get("/api/hello", _ => {
    "Hello, World!"
  })

  app.listen(":4000")
}
`,
  "/routes.mbt": `/// Put shared route handlers here as the app grows.
pub fn route_greeting() -> String {
  "Hello, Mocket!"
}
`,
  "/README.md": `# Mocket Playground

- **Run** compiles the current Moon module for the JavaScript target and starts the resulting program in WebContainer Node.
- Mocket, moonbitlang/async, and Mocket CORS artifacts are bundled for the JavaScript target; the first run downloads the offline bundle once.
- **Format** uses the browser's MoonBit formatter for the active .mbt file. The terminal includes the official Wasm tools: moonc, moonfmt, and mooninfo.
- The terminal provides a clearly labeled compatibility subset of Moon: \`moon check\`, \`moon build --target js\`, and \`moon run --target js\`.
- This browser environment is not the official \`moon\` executable. Registry and Git dependencies, non-JavaScript targets, \`moon test\`, and other Moon subcommands are unavailable.
`,
});

const runtimeFiles: Record<string, string> = {
  "/package.json": JSON.stringify(
    {
      name: "mocket-webcontainer-runtime",
      private: true,
      type: "module",
    },
    null,
    2,
  ),
};

const activePath = ref("/main.mbt");
const editorValue = computed({
  get: () => files.value[activePath.value] ?? "",
  set: (value: string) => {
    files.value[activePath.value] = value;
    dirty.value = true;
    if (webcontainer.value) void webcontainer.value.fs.writeFile(activePath.value, value);
  },
});
const dirty = ref(false);
const projectName = ref("mocket-starter");
const sidebarTab = ref<"api" | "preview">("api");
const editorRef = ref<MoonbitEditorApi | null>(null);
const compilerState = ref<CompilerState>("idle");
const compilerOutput = ref("Ready to run this project in WebContainer.");
const examplesOpen = ref(false);
const runtimeNotice = ref(
  "Boot the workspace to mount the actual WebContainer filesystem and terminal.",
);
const runtimeState = ref<"idle" | "booting" | "running" | "error">("idle");
const previewUrl = ref("");
const terminalReady = ref(false);
const moonbitToolchainVersion = ref("");
const webcontainer = ref<WebContainer | null>(null);
const serverProcess = ref<Awaited<ReturnType<WebContainer["spawn"]>> | null>(null);
let bootedWebcontainer: WebContainer | null = null;
let stopMoonWebBridge: (() => void) | undefined;
let runPromise: Promise<void> | undefined;
const entries = ref<FileEntry[]>([]);
const expandedFolders = ref(new Set<string>(["/", "/src"]));
const explorerWidth = ref(232);
const inspectorWidth = ref(408);
const terminalHeight = ref(270);
const workspaceRef = ref<HTMLElement | null>(null);
let stopResizing: (() => void) | undefined;

const activeIsMoonBit = computed(() => activePath.value.endsWith(".mbt"));
const panelStyle = computed(() => ({
  "--explorer-width": `${explorerWidth.value}px`,
  "--inspector-width": `${inspectorWidth.value}px`,
  "--terminal-height": `${terminalHeight.value}px`,
}));
const visibleEntries = computed(() =>
  entries.value.filter((entry) => {
    if (entry.path === "/") return true;
    let parent = entry.path.slice(0, entry.path.lastIndexOf("/")) || "/";
    while (parent) {
      if (!expandedFolders.value.has(parent)) return false;
      if (parent === "/") return true;
      parent = parent.slice(0, parent.lastIndexOf("/")) || "/";
    }
    return true;
  }),
);

function entriesFromPaths(paths: string[], rootName: string) {
  const root: ExplorerNode = { name: rootName, path: "/", kind: "folder", children: [] };
  for (const filePath of paths) {
    const parts = filePath.split("/").filter(Boolean);
    let cursor = root;
    parts.forEach((part, index) => {
      const path = `/${parts.slice(0, index + 1).join("/")}`;
      const kind: EntryKind = index === parts.length - 1 ? "file" : "folder";
      let child = cursor.children.find((node) => node.path === path);
      if (!child) {
        child = { name: part, path, kind, children: [] };
        cursor.children.push(child);
      }
      cursor = child;
    });
  }
  const result: FileEntry[] = [];
  const visit = (node: ExplorerNode, depth: number) => {
    result.push({ name: node.name, path: node.path, kind: node.kind, depth });
    node.children
      .sort(
        (a, b) =>
          Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name),
      )
      .forEach((child) => visit(child, depth + 1));
  };
  visit(root, 0);
  return result;
}

async function refreshExplorer() {
  if (!webcontainer.value) {
    entries.value = entriesFromPaths(Object.keys(files.value), projectName.value);
    return;
  }
  const result: FileEntry[] = [
    {
      name: webcontainer.value.workdir.split("/").pop() || projectName.value,
      path: "/",
      kind: "folder",
      depth: 0,
    },
  ];
  async function walk(path: string, depth: number) {
    const nodes = await webcontainer.value!.fs.readdir(path, { withFileTypes: true });
    for (const node of nodes.sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    )) {
      const child = `${path === "/" ? "" : path}/${node.name}`;
      const isRuntimeFile = Object.hasOwn(runtimeFiles, child);
      if (!isRuntimeFile) {
        result.push({
          name: node.name,
          path: child,
          kind: node.isDirectory() ? "folder" : "file",
          depth,
        });
      }
      if (
        node.isDirectory() &&
        ![".moon_db", "_build", ".mooncakes", "node_modules"].includes(node.name)
      )
        await walk(child, depth + 1);
    }
  }
  await walk("/", 1);
  entries.value = result;
}

function isFolderOpen(path: string) {
  return expandedFolders.value.has(path);
}

function toggleFolder(path: string) {
  const next = new Set(expandedFolders.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expandedFolders.value = next;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type HorizontalPanel = "explorer" | "inspector";

function workbenchSizing() {
  const width = workspaceRef.value?.getBoundingClientRect().width ?? window.innerWidth;
  if (width <= 900) {
    return { width, explorerMin: 160, inspectorMin: 280, editorMin: 280 };
  }
  if (width <= 1100) {
    return { width, explorerMin: 180, inspectorMin: 300, editorMin: 330 };
  }
  return { width, explorerMin: 180, inspectorMin: 320, editorMin: 380 };
}

function fitHorizontalPanels() {
  const { width, explorerMin, inspectorMin, editorMin } = workbenchSizing();
  const usableSidePanelWidth = Math.max(explorerMin + inspectorMin, width - editorMin - 10);

  let nextExplorer = clamp(explorerWidth.value, explorerMin, 440);
  let nextInspector = clamp(inspectorWidth.value, inspectorMin, 620);
  if (nextExplorer + nextInspector > usableSidePanelWidth) {
    nextInspector = Math.max(inspectorMin, usableSidePanelWidth - nextExplorer);
    nextExplorer = Math.max(explorerMin, usableSidePanelWidth - nextInspector);
  }

  explorerWidth.value = nextExplorer;
  inspectorWidth.value = nextInspector;
}

function horizontalBounds(target: HorizontalPanel) {
  fitHorizontalPanels();
  const { width, explorerMin, inspectorMin, editorMin } = workbenchSizing();
  const usableSidePanelWidth = Math.max(explorerMin + inspectorMin, width - editorMin - 10);
  const min = target === "explorer" ? explorerMin : inspectorMin;
  const maximum = target === "explorer" ? 440 : 620;
  const otherPanelWidth = target === "explorer" ? inspectorWidth.value : explorerWidth.value;

  return { min, max: Math.max(min, Math.min(maximum, usableSidePanelWidth - otherPanelWidth)) };
}

function startResize(target: "explorer" | "inspector" | "terminal", event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return;

  event.preventDefault();
  stopResizing?.();
  if (target !== "terminal") fitHorizontalPanels();

  const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const startX = event.clientX;
  const startY = event.clientY;
  const startSize =
    target === "explorer"
      ? explorerWidth.value
      : target === "inspector"
        ? inspectorWidth.value
        : terminalHeight.value;
  const terminalBounds = () => {
    const editorPanel = handle?.parentElement;
    const fixedPanelHeight = 39 + 5 + 25;
    const minimumEditorHeight = 180;
    const minimumTerminalHeight = 160;
    const availableTerminalHeight =
      (editorPanel?.getBoundingClientRect().height ?? window.innerHeight) -
      fixedPanelHeight -
      minimumEditorHeight;

    return {
      min: minimumTerminalHeight,
      max: Math.max(minimumTerminalHeight, availableTerminalHeight),
    };
  };
  const move = (moveEvent: PointerEvent) => {
    moveEvent.preventDefault();

    if (target === "explorer") {
      const { min, max } = horizontalBounds("explorer");
      explorerWidth.value = clamp(startSize + moveEvent.clientX - startX, min, max);
    }
    if (target === "inspector") {
      const { min, max } = horizontalBounds("inspector");
      inspectorWidth.value = clamp(startSize - moveEvent.clientX + startX, min, max);
    }
    if (target === "terminal") {
      const { min, max } = terminalBounds();
      terminalHeight.value = clamp(startSize - moveEvent.clientY + startY, min, max);
    }
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    if (handle?.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    document.body.classList.remove("is-resizing", "is-resizing-terminal");
    stopResizing = undefined;
  };

  handle?.setPointerCapture(event.pointerId);
  document.body.classList.add("is-resizing");
  if (target === "terminal") document.body.classList.add("is-resizing-terminal");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop, { once: true });
  window.addEventListener("pointercancel", stop, { once: true });
  stopResizing = stop;
}

function resetTerminalHeight() {
  terminalHeight.value = 270;
}

function loadExample(name: ExampleId) {
  const example = getExample(name);
  files.value["/main.mbt"] = example.code;
  activePath.value = "/main.mbt";
  examplesOpen.value = false;
  dirty.value = true;
  if (webcontainer.value)
    void webcontainer.value.fs.writeFile("/main.mbt", files.value["/main.mbt"]);
  runtimeNotice.value = `Loaded ${name} example. Press Run to compile it and start the server in WebContainer.`;
}

function addFile() {
  const path = `/route_${Object.keys(files.value).filter((key) => key.endsWith(".mbt")).length}.mbt`;
  files.value[path] =
    `/// A new Mocket route module.\npub fn handler() -> String {\n  "Hello from ${path.split("/").pop()}"\n}\n`;
  activePath.value = path;
  dirty.value = true;
  if (webcontainer.value) {
    void webcontainer.value.fs.writeFile(path, files.value[path]).then(refreshExplorer);
  }
}

function removeFile(path: string) {
  if (path === "/main.mbt") return;
  delete files.value[path];
  activePath.value = "/main.mbt";
  dirty.value = true;
  if (webcontainer.value)
    void webcontainer.value.fs.rm(path, { force: true }).then(refreshExplorer);
}

async function bootWebContainer() {
  if (webcontainer.value || runtimeState.value === "booting") return;
  runtimeState.value = "booting";
  runtimeNotice.value = "Booting isolated WebContainer workspace…";
  try {
    const instance = await WebContainer.boot({
      workdirName: "mocket-starter",
      coep: "require-corp",
    });
    bootedWebcontainer = instance;
    await instance.mount(asWebContainerTree());
    runtimeNotice.value = "Installing official MoonBit Wasm compiler tools in WebContainer…";
    const toolchain = await installMoonbitWasmToolchain(instance);
    moonbitToolchainVersion.value = toolchain.version;
    stopMoonWebBridge = startMoonWebBridge(instance, handleMoonWebRequest);
    const updatePreview = (port: number, url: string) => {
      previewUrl.value = url;
      runtimeState.value = "running";
      runtimeNotice.value = `Mocket is listening on port ${port} at ${url}`;
    };
    // `server-ready` is only emitted for a conventional preview server. Mocket
    // uses Node's `http.Server` directly, for which WebContainer reports the
    // lower-level port lifecycle event instead. Listen to both so the API
    // client always receives the genuine Mocket preview URL.
    instance.on("server-ready", updatePreview);
    instance.on("port", (port, type, url) => {
      if (type === "open") {
        updatePreview(port, url);
      } else if (previewUrl.value === url) {
        previewUrl.value = "";
        if (runtimeState.value === "running") {
          runtimeState.value = "idle";
          runtimeNotice.value = `WebContainer port ${port} closed.`;
        }
      }
    });
    // Publish the container only after the toolchain is in place. This keeps
    // the interactive terminal from racing the installer on a fresh browser.
    webcontainer.value = instance;
    await refreshExplorer();
    runtimeState.value = "idle";
    runtimeNotice.value = `Workspace mounted with MoonBit Wasm tools ${toolchain.version}. Starting the Mocket starter project…`;
    void runProject();
  } catch (error) {
    runtimeState.value = "error";
    runtimeNotice.value = `WebContainer unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function asWebContainerTree(): FileSystemTree {
  const tree: FileSystemTree = {};
  Object.entries({ ...runtimeFiles, ...files.value }).forEach(([path, contents]) => {
    const parts = path.split("/").filter(Boolean);
    let cursor = tree;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) cursor[part] = { file: { contents } };
      else {
        const node = cursor[part];
        if (!node || !("directory" in node)) cursor[part] = { directory: {} };
        cursor = (cursor[part] as { directory: FileSystemTree }).directory;
      }
    });
  });
  return tree;
}

async function syncFiles() {
  if (!webcontainer.value) return;
  await Promise.all(
    Object.entries(files.value).map(([path, value]) =>
      webcontainer.value!.fs.writeFile(path, value),
    ),
  );
  await refreshExplorer();
}

function usesMocketDependencies() {
  return Object.values(files.value).some((source) => /@mocket\.|oboard\/mocket/.test(source));
}

function formatDiagnostics(message: string, diagnostics: { message: string }[]) {
  const diagnosticText = diagnostics
    .map((diagnostic) => diagnostic.message)
    .filter(Boolean)
    .join("\n");
  return diagnosticText ? `${message}\n\n${diagnosticText}` : message;
}

function isMoonpadEntrypointNoise(diagnostic: { errorCode?: number; message: string }) {
  return (
    diagnostic.errorCode === 67 ||
    /Main function is already defined at .*main\.mbt:1:1\.$/.test(diagnostic.message)
  );
}

function moonWebUsage() {
  return [
    "The build system and package manager for MoonBit.",
    "",
    "Usage: moon [OPTIONS] <COMMAND>",
    "",
    "Commands:",
    "  check     Check the current package, but don't build object files",
    "  build     Build the current package",
    "  run       Run a main package",
    "  version   Print version information and exit",
    "  help      Print this message or the help of the given subcommand(s)",
    "",
    "Options:",
    "  -V, --version  Print all version information and exit",
    "  -h, --help     Print help",
    "",
    "Moon Web compatibility note: this browser adapter implements only the commands above",
    "for the JavaScript target. It is not the official Moon executable.",
  ].join("\n");
}

function moonWebTargetError(command: MoonWebRequest["command"], args: string[]) {
  let selector: string | undefined;
  let hasRelease = false;
  let hasBuildOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") {
      const target = args[index + 1];
      if (!target)
        return "error: a value is required for '--target <TARGET>' but none was supplied";
      if (target !== "js")
        return `error: invalid value '${target}' for '--target <TARGET>'\n  [possible values: js]\n\nMoon Web supports only the JavaScript target.`;
      index += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      const target = arg.slice("--target=".length);
      if (target !== "js")
        return `error: invalid value '${target}' for '--target <TARGET>'\n  [possible values: js]\n\nMoon Web supports only the JavaScript target.`;
      continue;
    }
    if (arg === "--release") {
      hasRelease = true;
      continue;
    }
    if (arg === "--build-only" && command === "run") {
      hasBuildOnly = true;
      continue;
    }
    if (["--debug", "--frozen", "-q", "--quiet"].includes(arg)) continue;
    if (arg.startsWith("-")) return `error: unexpected argument '${arg}' found`;
    if (selector) return `error: unexpected argument '${arg}' found`;
    selector = arg;
  }

  if (hasRelease && hasBuildOnly) return undefined;
  if (hasRelease || hasBuildOnly) return undefined;
  if (!selector || selector === ".") return undefined;
  return `error: Moon Web only supports the current package selector (received '${selector}').`;
}

function workspacePath(root: string, relative: string) {
  return `${root === "/" ? "" : root}/${relative.replace(/^\/+/, "")}`;
}

async function findMoonWebProjectRoot(cwd: string) {
  if (!webcontainer.value) throw new Error("WebContainer has not started yet.");
  const candidates: string[] = [];
  let current = cwd.startsWith("/") ? cwd.replace(/\/+$/, "") || "/" : "/";
  while (!candidates.includes(current)) {
    candidates.push(current);
    if (current === "/") break;
    current = current.slice(0, current.lastIndexOf("/")) || "/";
  }
  if (!candidates.includes("/")) candidates.push("/");
  for (const candidate of candidates) {
    try {
      await webcontainer.value.fs.readFile(workspacePath(candidate, "moon.mod"), "utf-8");
      return candidate;
    } catch {
      // Try the parent directory. WebContainer's shell path can be different
      // from the FS API's mounted root, so falling back to / is intentional.
    }
  }
  throw new Error("Could not find moon.mod from the terminal's current directory.");
}

async function readMoonWebWorkspace(cwd: string) {
  if (!webcontainer.value) throw new Error("WebContainer has not started yet.");
  const root = await findMoonWebProjectRoot(cwd);
  const files: Record<string, string> = {};
  const skipDirectories = new Set([".moon_db", ".mooncakes", "_build", "node_modules", ".git"]);
  const walk = async (absolutePath: string, relativePath: string): Promise<void> => {
    const entries = await webcontainer.value!.fs.readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      if (skipDirectories.has(entry.name)) continue;
      const childAbsolute = workspacePath(absolutePath, entry.name);
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(childAbsolute, childRelative);
      } else if (
        entry.name.endsWith(".mbt") ||
        entry.name === "moon.mod" ||
        entry.name === "moon.pkg"
      ) {
        files[`/${childRelative}`] = await webcontainer.value!.fs.readFile(childAbsolute, "utf-8");
      }
    }
  };
  await walk(root, "");
  return { root, files };
}

function outputNameFromMoonMod(moonMod: string | undefined) {
  const packageName = moonMod?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? "main";
  return (
    packageName
      .split("/")
      .at(-1)
      ?.replaceAll(/[^A-Za-z0-9_.-]/g, "-") || "main"
  );
}

function hasBrowserBundledDependencies(workspaceFiles: Record<string, string>) {
  return Object.values(workspaceFiles).some((source) =>
    /@mocket\.|oboard\/mocket|moonbitlang\/async/.test(source),
  );
}

async function writeMoonWebBuild(
  root: string,
  outputName: string,
  js: Uint8Array,
  release = false,
) {
  if (!webcontainer.value) throw new Error("WebContainer has not started yet.");
  const outputDirectory = workspacePath(root, `_build/js/${release ? "release" : "debug"}/build`);
  const outputPath = `${outputDirectory}/${outputName}.js`;
  await webcontainer.value.fs.mkdir(outputDirectory, { recursive: true });
  await webcontainer.value.fs.writeFile(outputPath, js);
  await webcontainer.value.fs.writeFile(
    `${outputDirectory}/${outputName}.moon-web-run.mjs`,
    `import { Server } from "node:http";
process.on("uncaughtException", error => console.error(error?.stack || error));
process.on("unhandledRejection", error => console.error(error?.stack || error));
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  console.log("[mocket] http.Server.listen", args.slice(0, 2));
  this.once("listening", () => console.log("[mocket] listening", this.address()));
  this.once("error", error => console.error("[mocket] server error", error?.stack || error));
  return listen.apply(this, args);
};
await import("./${outputName}.js");
`,
  );
  return {
    outputPath,
    runPath: `${outputDirectory}/${outputName}.moon-web-run.mjs`,
  };
}

async function handleMoonWebRequest(request: MoonWebRequest): Promise<MoonWebResponse> {
  if (request.command === "help") {
    return { protocol: 1, id: request.id, exitCode: 0, stdout: moonWebUsage() };
  }
  if (request.command === "version") {
    const args = request.args;
    if (args.some((arg) => !["--all", "--json", "--no-path"].includes(arg))) {
      return {
        protocol: 1,
        id: request.id,
        exitCode: 2,
        stderr: `error: unexpected argument '${args.find((arg) => !["--all", "--json", "--no-path"].includes(arg))}' found`,
      };
    }
    const version = moonbitToolchainVersion.value || "unknown";
    const item = {
      name: "moon",
      version: `browser compatibility adapter (MoonBit Wasm tools ${version})`,
    };
    return {
      protocol: 1,
      id: request.id,
      exitCode: 0,
      stdout: args.includes("--json")
        ? JSON.stringify({ items: [item] })
        : `${item.name} ${item.version}\n\nThis is not the official Moon executable; only JavaScript build compatibility is available.`,
    };
  }

  const targetError = moonWebTargetError(request.command, request.args);
  if (targetError) return { protocol: 1, id: request.id, exitCode: 2, stderr: targetError };

  const workspace = await readMoonWebWorkspace(request.cwd);
  const mainPath = "/main.mbt";
  const main = workspace.files[mainPath];
  if (!main) {
    return {
      protocol: 1,
      id: request.id,
      exitCode: 1,
      stderr:
        "error: no main package was found in the current module. Moon Web currently runs /main.mbt only.",
    };
  }

  const dependencyAware = hasBrowserBundledDependencies(workspace.files);
  const artifactBundle = dependencyAware ? await getMocketJavaScriptArtifacts() : undefined;
  const formatMoonWebDiagnostics = (
    message: string,
    diagnostics: { errorCode?: number; message: string }[],
  ) =>
    formatDiagnostics(
      message,
      diagnostics.filter((diagnostic) => !isMoonpadEntrypointNoise(diagnostic)),
    );

  if (request.command === "check") {
    if (dependencyAware) {
      const result = await checkMocketProjectInBrowser({
        files: workspace.files,
        artifacts: artifactBundle!,
      });
      const diagnostics = result.diagnostics.filter(
        (diagnostic) => !isMoonpadEntrypointNoise(diagnostic),
      );
      const errors = diagnostics.filter((diagnostic) => diagnostic.level === "error");
      if (result.kind === "error" || errors.length > 0) {
        const message = result.kind === "error" ? result.message : "MoonBit type checking failed.";
        return {
          protocol: 1,
          id: request.id,
          exitCode: 1,
          stderr: formatDiagnostics(message, diagnostics),
        };
      }
      return {
        protocol: 1,
        id: request.id,
        exitCode: 0,
        stdout: `Checked ${Object.keys(workspace.files).filter((path) => path.endsWith(".mbt")).length} MoonBit file(s) against bundled Mocket + async artifacts.`,
      };
    }
    const result = await compileMoonBitToJavaScript({ code: main, filename: "main.mbt" });
    if (result.kind === "error") {
      return {
        protocol: 1,
        id: request.id,
        exitCode: 1,
        stderr: formatMoonWebDiagnostics(result.message, result.diagnostics),
      };
    }
    return {
      protocol: 1,
      id: request.id,
      exitCode: 0,
      stdout: "Checked the current MoonBit entrypoint.",
    };
  }

  const result = dependencyAware
    ? await compileMocketToJavaScript({
        code: main,
        filename: "main.mbt",
        files: workspace.files,
        artifacts: artifactBundle!,
      })
    : await compileMoonBitToJavaScript({ code: main, filename: "main.mbt" });
  if (result.kind === "error") {
    compilerState.value = "error";
    compilerOutput.value = formatMoonWebDiagnostics(result.message, result.diagnostics);
    return {
      protocol: 1,
      id: request.id,
      exitCode: 1,
      stderr: compilerOutput.value,
    };
  }

  const build = await writeMoonWebBuild(
    workspace.root,
    outputNameFromMoonMod(workspace.files["/moon.mod"]),
    result.js,
    request.args.includes("--release"),
  );
  await refreshExplorer();
  compilerState.value = "success";
  compilerOutput.value = `Moon Web built ${build.outputPath}${dependencyAware ? " with Mocket + async artifacts" : ""}.`;
  runtimeNotice.value = "Moon Web generated JavaScript in WebContainer.";
  return {
    protocol: 1,
    id: request.id,
    exitCode: 0,
    stdout: `Finished. Moon Web built ${build.outputPath}`,
    ...(request.command === "run" ? { runPath: build.runPath } : {}),
  };
}

async function pipeProgramOutput(process: Awaited<ReturnType<WebContainer["spawn"]>>) {
  let output = "";
  try {
    await process.output.pipeTo(
      new WritableStream<string>({
        write(chunk) {
          output += chunk;
          compilerOutput.value = output || "Program is running in WebContainer…";
          // Mocket's own Node server has confirmed that it bound its port. The
          // API client can now issue requests from inside the same WebContainer
          // even if the host browser has not exposed an iframe preview URL.
          if (output.includes("[mocket] listening")) {
            runtimeState.value = "running";
            runtimeNotice.value =
              "Mocket is listening on port 4000 inside WebContainer. The API client connects to the real Node server directly.";
          }
        },
      }),
    );
    const exitCode = await process.exit;
    if (serverProcess.value === process) serverProcess.value = null;
    if (!previewUrl.value) {
      runtimeState.value = exitCode === 0 ? "idle" : "error";
      runtimeNotice.value =
        exitCode === 0
          ? "MoonBit JavaScript finished in WebContainer. This program did not open an HTTP port."
          : `MoonBit JavaScript exited with code ${exitCode}.`;
    }
  } catch (error) {
    if (serverProcess.value === process) serverProcess.value = null;
    runtimeState.value = "error";
    runtimeNotice.value = `Unable to read Node output: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function runProjectInternal() {
  const hasMocketDependencies = usesMocketDependencies();

  compilerState.value = "compiling";
  compilerOutput.value = hasMocketDependencies
    ? "Loading built-in Mocket + async JavaScript artifacts…"
    : "Compiling /main.mbt to JavaScript in your browser…";
  runtimeState.value = "booting";
  runtimeNotice.value = hasMocketDependencies
    ? "Preparing the offline Mocket JavaScript compiler for WebContainer Node…"
    : "Linking standalone MoonBit JavaScript for WebContainer Node…";

  await bootWebContainer();
  if (!webcontainer.value) return;
  await syncFiles();
  if (serverProcess.value) {
    serverProcess.value.kill();
    serverProcess.value = null;
  }
  previewUrl.value = "";

  try {
    const source = files.value["/main.mbt"] ?? "";
    const result = hasMocketDependencies
      ? await compileMocketToJavaScript({
          code: source,
          filename: "main.mbt",
          artifacts: await getMocketJavaScriptArtifacts(),
        })
      : await compileMoonBitToJavaScript({ code: source, filename: "main.mbt" });
    if (result.kind === "error") {
      compilerState.value = "error";
      runtimeState.value = "error";
      compilerOutput.value = formatDiagnostics(result.message, result.diagnostics);
      runtimeNotice.value = "MoonBit compilation failed before Node could start.";
      return;
    }

    await webcontainer.value.fs.mkdir("/.mocket-runtime", { recursive: true });
    await webcontainer.value.fs.writeFile(
      "/.mocket-runtime/main.mjs",
      new TextDecoder().decode(result.js),
    );
    // Keep runtime failures observable in the compiler panel. This wrapper does
    // not implement HTTP itself: it only imports the real Mocket program.
    await webcontainer.value.fs.writeFile(
      "/.mocket-runtime/run.mjs",
      `import { Server } from "node:http";
process.on("uncaughtException", error => console.error(error?.stack || error));
process.on("unhandledRejection", error => console.error(error?.stack || error));
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  console.log("[mocket] http.Server.listen", args.slice(0, 2));
  this.once("listening", () => console.log("[mocket] listening", this.address()));
  this.once("error", error => console.error("[mocket] server error", error?.stack || error));
  return listen.apply(this, args);
};
await import("./main.mjs");
`,
    );
    await refreshExplorer();
    compilerState.value = "success";
    compilerOutput.value = `Built /.mocket-runtime/main.mjs${
      hasMocketDependencies ? " with Mocket + async artifacts" : ""
    }. Starting Node in WebContainer…`;
    runtimeNotice.value = "Running browser-compiled MoonBit JavaScript with WebContainer Node…";
    const process = await webcontainer.value.spawn("node", [".mocket-runtime/run.mjs"]);
    serverProcess.value = process;
    void pipeProgramOutput(process);
  } catch (error) {
    compilerState.value = "error";
    runtimeState.value = "error";
    const message = error instanceof Error ? error.message : String(error);
    compilerOutput.value = message;
    runtimeNotice.value = `Unable to run browser-compiled JavaScript: ${message}`;
  }
}

function runProject() {
  if (runPromise) return runPromise;
  runPromise = runProjectInternal().finally(() => {
    runPromise = undefined;
  });
  return runPromise;
}

async function executeRuntimeRequest(request: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}) {
  if (!webcontainer.value) throw new Error("WebContainer has not started yet.");

  const requestedUrl = new URL(request.path, "http://mocket.local");
  const payload = {
    ...request,
    url: `http://127.0.0.1:4000${requestedUrl.pathname}${requestedUrl.search}`,
  };
  const script = `
const request = JSON.parse(process.argv[1]);
const response = await fetch(request.url, {
  method: request.method,
  headers: request.headers,
  body: request.body,
});
const body = await response.text();
process.stdout.write(JSON.stringify({
  status: response.status,
  headers: Array.from(response.headers.entries()).map(([key, value]) => key + ": " + value),
  body,
}));
`;
  const process = await webcontainer.value.spawn("node", ["-e", script, JSON.stringify(payload)]);
  const reader = process.output.getReader();
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += value;
  }
  const exitCode = await process.exit;
  if (exitCode !== 0) throw new Error(output || `Node request exited with code ${exitCode}.`);
  try {
    return JSON.parse(output) as { status: number; headers: string[]; body: string };
  } catch {
    throw new Error(output || "The runtime returned an invalid API response.");
  }
}

async function openFile(path: string, kind: EntryKind) {
  if (kind !== "file") return;
  if (webcontainer.value) files.value[path] = await webcontainer.value.fs.readFile(path, "utf-8");
  activePath.value = path;
}

function handleEditorTrace(event: TraceEvent) {
  if (
    event.filePath !== activePath.value ||
    !activeIsMoonBit.value ||
    compilerState.value === "compiling"
  )
    return;
  if (event.kind === "error") {
    compilerState.value = "error";
    compilerOutput.value = event.message;
    return;
  }
  compilerState.value = "idle";
  compilerOutput.value = event.output || "LSP check passed — no runtime output yet.";
}

async function formatCurrentFile() {
  if (!activeIsMoonBit.value) {
    compilerState.value = "error";
    compilerOutput.value = "Formatting is available for MoonBit (.mbt) files only.";
    return;
  }

  await editorRef.value?.formatDocument();
  compilerOutput.value = "Formatted the active MoonBit file.";
  compilerState.value = "idle";
}

function resetProject() {
  files.value["/main.mbt"] = getExample("hello").code;
  activePath.value = "/main.mbt";
  dirty.value = true;
  runtimeNotice.value =
    "Starter project restored. Press Run to compile it and start WebContainer Node.";
}

onMounted(() => {
  fitHorizontalPanels();
  window.addEventListener("resize", fitHorizontalPanels);
  void refreshExplorer();
  void bootWebContainer();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", fitHorizontalPanels);
  stopResizing?.();
  stopMoonWebBridge?.();
  stopMoonWebBridge = undefined;
  void serverProcess.value?.kill();
  // WebContainer permits only one live instance. Release both a fully mounted
  // workspace and one still installing so browser reload/HMR can boot again.
  bootedWebcontainer?.teardown();
  bootedWebcontainer = null;
});
</script>

<template>
  <main class="playground-shell" :style="panelStyle">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">M</span><span>Mocket <b>Playground</b></span
        ><i></i><span class="workspace-name">{{ projectName }}</span>
      </div>
      <nav>
        <button class="nav-link" type="button">
          Docs
          <CornerUpRightRegular :size="13" aria-hidden="true" />
        </button>
        <div class="examples-menu">
          <button
            class="nav-link"
            type="button"
            aria-controls="examples-menu"
            :aria-expanded="examplesOpen"
            @click="examplesOpen = !examplesOpen"
          >
            Examples
            <DownRegular :size="13" aria-hidden="true" />
          </button>
          <div v-if="examplesOpen" id="examples-menu" class="examples-popover">
            <button
              v-for="example in examples"
              :key="example.name"
              @click="loadExample(example.name)"
            >
              <b>{{ example.label }}</b
              ><span>{{ example.subtitle }}</span>
            </button>
          </div>
        </div>
      </nav>
      <div class="top-actions">
        <span class="runtime-dot" :class="runtimeState"></span
        ><span class="runtime-label">{{ runtimeNotice }}</span
        ><button class="ghost-button" @click="resetProject">Reset</button
        ><button class="run-button" type="button" @click="runProject">
          <PlayFilled :size="13" aria-hidden="true" /> Run
        </button>
      </div>
    </header>

    <section ref="workspaceRef" class="workspace">
      <aside class="file-panel">
        <div class="panel-heading">
          <span>EXPLORER</span
          ><button
            type="button"
            title="New MoonBit file"
            aria-label="New MoonBit file"
            @click="addFile"
          >
            <AddRegular :size="16" aria-hidden="true" />
          </button>
        </div>
        <div class="file-tree">
          <div
            v-for="entry in visibleEntries"
            :key="entry.path"
            class="file-row"
            :class="{
              selected: activePath === entry.path,
              folder: entry.kind === 'folder',
            }"
            role="button"
            tabindex="0"
            :style="{ paddingLeft: `${12 + entry.depth * 15}px` }"
            @click="
              entry.kind === 'folder' ? toggleFolder(entry.path) : openFile(entry.path, entry.kind)
            "
            @keydown.enter="
              entry.kind === 'folder' ? toggleFolder(entry.path) : openFile(entry.path, entry.kind)
            "
            @keydown.space.prevent="
              entry.kind === 'folder' ? toggleFolder(entry.path) : openFile(entry.path, entry.kind)
            "
          >
            <span class="file-icon" aria-hidden="true">
              <FolderOpenRegular
                v-if="entry.kind === 'folder' && isFolderOpen(entry.path)"
                :size="15"
              />
              <FolderRegular v-else-if="entry.kind === 'folder'" :size="15" />
              <CodeRegular v-else-if="entry.name.endsWith('.mbt')" :size="15" />
              <FileRegular v-else :size="15" />
            </span>
            {{ entry.name }}
            <span v-if="entry.path === '/main.mbt'" class="entry-tag">main</span>
            <button
              v-if="entry.kind === 'file' && entry.path !== '/main.mbt'"
              class="delete-file"
              type="button"
              :aria-label="`Delete ${entry.name}`"
              title="Delete file"
              @click.stop="removeFile(entry.path)"
            >
              <Delete2Regular :size="14" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div class="project-meta">
          <div><CodeRegular :size="14" aria-hidden="true" /> MoonBit</div>
          <small>target <b>js</b></small
          ><small>framework <b>mocket</b></small>
        </div>
      </aside>
      <div
        class="panel-resizer vertical explorer-resizer"
        role="separator"
        aria-label="Resize explorer"
        @pointerdown="startResize('explorer', $event)"
      ></div>

      <section class="editor-panel">
        <div class="tabs">
          <div class="tab active">
            <CodeRegular class="moon-icon" :size="14" aria-hidden="true" />
            {{ activePath.split("/").pop() }}<span v-if="dirty" class="dirty"></span
            ><button type="button" aria-label="Clear unsaved indicator" @click="dirty = false">
              <CloseRegular :size="14" aria-hidden="true" />
            </button>
          </div>
          <div class="tab-spacer"></div>
          <button
            class="editor-tool"
            type="button"
            title="Format MoonBit indentation (⇧⌥F)"
            aria-label="Format MoonBit indentation"
            @click="formatCurrentFile"
          >
            <CommandRegular :size="16" aria-hidden="true" />
          </button>
          <button
            class="editor-tool"
            type="button"
            title="More editor actions"
            aria-label="More editor actions"
          >
            <MoreRegular :size="16" aria-hidden="true" />
          </button>
        </div>
        <div class="editor-body">
          <MoonbitEditor
            ref="editorRef"
            v-model="editorValue"
            :file-path="activePath"
            :project-files="files"
            :dependency-aware="usesMocketDependencies()"
            @trace="handleEditorTrace"
          />
        </div>
        <div
          class="panel-resizer horizontal terminal-resizer"
          role="separator"
          aria-label="Resize compiler and terminal"
          title="Drag to resize terminal · Double-click to reset"
          @pointerdown="startResize('terminal', $event)"
          @dblclick="resetTerminalHeight"
        ></div>
        <div class="terminal">
          <div class="terminal-heading">
            <span><i class="terminal-led"></i> COMPILER & TERMINAL</span
            ><span>{{ terminalReady ? "WebContainer shell" : "Starting WebContainer…" }}</span>
          </div>
          <div class="compiler-result" :class="compilerState">
            <span
              >{{ activeIsMoonBit ? "browser build" : "file" }} ·
              {{ activePath.split("/").pop() }}</span
            >
            <pre>{{ compilerOutput }}</pre>
          </div>
          <WebTerminal
            :container="webcontainer"
            :moonbit-bin="moonbitWasmToolchainBin"
            :moonbit-version="moonbitToolchainVersion"
            @ready="terminalReady = true"
          />
        </div>
        <div class="statusbar">
          <span>{{ activePath.split("/").pop() }}</span
          ><span>{{ editorValue.split("\n").length }} lines</span><span>MoonBit</span
          ><span>UTF-8</span
          ><span class="status-right">
            <FlashRegular :size="13" aria-hidden="true" /> JavaScript backend
          </span>
        </div>
      </section>
      <div
        class="panel-resizer vertical inspector-resizer"
        role="separator"
        aria-label="Resize API client"
        @pointerdown="startResize('inspector', $event)"
      ></div>

      <aside class="right-panel">
        <div class="sidebar-tabs">
          <button :class="{ active: sidebarTab === 'api' }" @click="sidebarTab = 'api'">
            API client
          </button>
          <button :class="{ active: sidebarTab === 'preview' }" @click="sidebarTab = 'preview'">
            Web preview
          </button>
        </div>
        <ApiClient
          v-if="sidebarTab === 'api'"
          :base-url="previewUrl"
          :is-runtime-ready="runtimeState === 'running'"
          :execute-request="executeRuntimeRequest"
        />
        <section v-else class="sidebar-preview">
          <div class="preview-heading">
            <span><i class="preview-indicator"></i> WEB PREVIEW</span
            ><button
              title="Refresh preview"
              @click="previewUrl && (previewUrl = `${previewUrl.split('?')[0]}?t=${Date.now()}`)"
            >
              <Refresh3Regular :size="16" aria-hidden="true" />
            </button>
          </div>
          <div class="preview-address">{{ previewUrl || "No server running" }}</div>
          <iframe v-if="previewUrl" title="Mocket web preview" :src="previewUrl"></iframe>
          <div v-else class="preview-cover">
            <span class="cover-icon">M</span>
            <h2>Start the WebContainer preview</h2>
            <p>
              Run the preview workspace, then use the terminal as you would in the StackBlitz
              WebContainer starter.
            </p>
            <button type="button" @click="runProject">
              Mount project
              <ArrowRightRegular :size="15" aria-hidden="true" />
            </button>
          </div>
        </section>
      </aside>
    </section>
  </main>
</template>

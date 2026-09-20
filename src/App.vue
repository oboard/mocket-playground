<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { WebContainer, type FileSystemTree } from "@webcontainer/api";
import MoonbitEditor from "./components/MoonbitEditor.vue";
import WebTerminal from "./components/WebTerminal.vue";
import ApiClient from "./components/ApiClient.vue";
import { compileMocketToJavaScript, compileMoonBitToJavaScript } from "./lib/moonbitCompiler";
import { getMocketJavaScriptArtifacts } from "./lib/mocketArtifacts";
import { installMoonbitWasmToolchain, moonbitWasmToolchainBin } from "./lib/moonbitWasmToolchain";

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
  runSingleFile: () => Promise<
    | { kind: "success"; output: string; diagnostics: unknown[] }
    | { kind: "error"; stage: string; message: string; diagnostics?: unknown[] }
  >;
};

const files = ref<Record<string, string>>({
  "/moon.mod": `name = "playground/mocket-starter"
version = "0.1.0"
source = "src"
preferred_target = "js"
`,
  "/src/moon.pkg": `import {
  "moonbitlang/async",
  "oboard/mocket",
  "oboard/mocket/cors",
}

supported_targets = "+js"

pkgtype(kind: "executable")
`,
  "/src/main.mbt": `/// This file compiles immediately in the browser — no local MoonBit install needed.
fn greeting(name : String) -> String {
  "Hello, \\{name}!"
}

fn main {
  println(greeting("MoonBit"))
}
`,
  "/src/routes.mbt": `/// Put shared route handlers here as the app grows.
pub fn route_greeting() -> String {
  "Hello, Mocket!"
}
`,
  "/README.md": `# Mocket Playground

- **Compile** uses MoonBit’s browser compiler and requires no local toolchain.
- Mocket, moonbitlang/async, and Mocket CORS artifacts are bundled for the JavaScript target; the first Mocket Run downloads the offline bundle once.
- **LSP trace** runs as you type for MoonBit files and decorates values in the editor.
- **Format** normalizes indentation in the browser. The WebContainer terminal includes the official Wasm tools: \`moonc\`, \`moonfmt\`, and \`mooninfo\`.
- The upstream Wasm archive does not include the Rust \`moon\` package manager, so dependency-aware Mocket builds continue to use the browser compiler.
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

const exampleTemplates: Record<string, string> = {
  hello: `/// This file compiles immediately in the browser — no local MoonBit install needed.
fn greeting(name : String) -> String {
  "Hello, \\{name}!"
}

fn main {
  println(greeting("MoonBit"))
}
`,
  params: `async fn main {
  let app = @mocket.App()
  app.use_middleware(@cors.handle_cors())

  // Visit /hello/MoonBit to read a named route parameter.
  app.get("/hello/:name", event => {
    let name = event.params.get("name").unwrap_or("World")
    "Hello, \\{name}!"
  })

  app.listen("0.0.0.0:4000")
}
`,
  api: `async fn main {
  let app = @mocket.App()
  app.use_middleware(@cors.handle_cors())

  app.group("/api", group => {
    group.get("/status", _ => {
      ({ "ok": true, "framework": "mocket" } : Json)
    })
  })

  app.listen("0.0.0.0:4000")
}
`,
  echo: `async fn main {
  let app = @mocket.App()
  app.use_middleware(@cors.handle_cors())

  app.post("/echo", event => {
    let body : Bytes = event.req.body()
    body
  })

  app.listen("0.0.0.0:4000")
}
`,
};

const activePath = ref("/src/main.mbt");
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
const compilerOutput = ref("Ready to compile this file in your browser.");
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
const entries = ref<FileEntry[]>([]);
const compileGeneration = ref(0);
const expandedFolders = ref(new Set<string>(["/", "/src"]));
const explorerWidth = ref(232);
const inspectorWidth = ref(408);
const terminalHeight = ref(270);
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

function startResize(target: "explorer" | "inspector" | "terminal", event: PointerEvent) {
  event.preventDefault();
  stopResizing?.();
  const startX = event.clientX;
  const startY = event.clientY;
  const startSize =
    target === "explorer"
      ? explorerWidth.value
      : target === "inspector"
        ? inspectorWidth.value
        : terminalHeight.value;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const move = (moveEvent: PointerEvent) => {
    if (target === "explorer")
      explorerWidth.value = clamp(startSize + moveEvent.clientX - startX, 180, 440);
    if (target === "inspector")
      inspectorWidth.value = clamp(startSize - moveEvent.clientX + startX, 320, 620);
    if (target === "terminal")
      terminalHeight.value = clamp(startSize - moveEvent.clientY + startY, 160, 620);
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    document.body.classList.remove("is-resizing");
    stopResizing = undefined;
  };
  document.body.classList.add("is-resizing");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop, { once: true });
  stopResizing = stop;
}

function loadExample(name: keyof typeof exampleTemplates) {
  files.value["/src/main.mbt"] = exampleTemplates[name];
  activePath.value = "/src/main.mbt";
  examplesOpen.value = false;
  dirty.value = true;
  if (webcontainer.value)
    void webcontainer.value.fs.writeFile("/src/main.mbt", files.value["/src/main.mbt"]);
  runtimeNotice.value = `Loaded ${name} example. Use Compile to run the active file in your browser.`;
}

function addFile() {
  const path = `/src/route_${Object.keys(files.value).filter((key) => key.startsWith("/src/")).length}.mbt`;
  files.value[path] =
    `/// A new Mocket route module.\npub fn handler() -> String {\n  "Hello from ${path.split("/").pop()}"\n}\n`;
  activePath.value = path;
  dirty.value = true;
  if (webcontainer.value) {
    void webcontainer.value.fs.writeFile(path, files.value[path]).then(refreshExplorer);
  }
}

function removeFile(path: string) {
  if (path === "/src/main.mbt") return;
  delete files.value[path];
  activePath.value = "/src/main.mbt";
  dirty.value = true;
  if (webcontainer.value)
    void webcontainer.value.fs.rm(path, { force: true }).then(refreshExplorer);
}

async function bootWebContainer() {
  if (webcontainer.value || runtimeState.value === "booting") return;
  runtimeState.value = "booting";
  runtimeNotice.value = "Booting isolated WebContainer workspace…";
  try {
    const instance = await WebContainer.boot({ workdirName: "mocket-starter" });
    bootedWebcontainer = instance;
    await instance.mount(asWebContainerTree());
    runtimeNotice.value = "Installing official MoonBit Wasm compiler tools in WebContainer…";
    const toolchain = await installMoonbitWasmToolchain(instance);
    moonbitToolchainVersion.value = toolchain.version;
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
    runtimeNotice.value = `Workspace mounted with MoonBit Wasm tools ${toolchain.version}. Use moonc, moonfmt, or mooninfo in the terminal; browser Compile still powers full Mocket runs.`;
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

async function runProject() {
  const hasMocketDependencies = usesMocketDependencies();

  compilerState.value = "compiling";
  compilerOutput.value = hasMocketDependencies
    ? "Loading built-in Mocket + async JavaScript artifacts…"
    : "Compiling /src/main.mbt to JavaScript in your browser…";
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
    const source = files.value["/src/main.mbt"] ?? "";
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

async function compileCurrentFile() {
  if (!activeIsMoonBit.value) {
    compilerState.value = "error";
    compilerOutput.value = "Choose a MoonBit (.mbt) file before compiling.";
    return;
  }
  if (!editorRef.value) {
    compilerOutput.value = "The editor is still loading. Try compiling again in a moment.";
    compilerState.value = "error";
    return;
  }
  const generation = ++compileGeneration.value;
  compilerState.value = "compiling";
  compilerOutput.value = "Compiling in your browser…";
  try {
    const result = await editorRef.value.runSingleFile();
    if (generation !== compileGeneration.value) return;
    if (result.kind === "success") {
      compilerState.value = "success";
      compilerOutput.value = result.output || "Build succeeded with no program output.";
    } else {
      compilerState.value = "error";
      compilerOutput.value = result.message;
    }
  } catch (error) {
    if (generation !== compileGeneration.value) return;
    compilerState.value = "error";
    compilerOutput.value = error instanceof Error ? error.message : String(error);
  }
}

function resetProject() {
  files.value["/src/main.mbt"] = exampleTemplates.hello;
  activePath.value = "/src/main.mbt";
  dirty.value = true;
  runtimeNotice.value =
    "Starter project restored. Press Compile to run it entirely in your browser.";
}

onMounted(() => {
  void refreshExplorer();
  void bootWebContainer();
});

onBeforeUnmount(() => {
  stopResizing?.();
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
        <button class="nav-link">Docs ↗</button>
        <div class="examples-menu">
          <button class="nav-link" @click="examplesOpen = !examplesOpen">Examples ▾</button>
          <div v-if="examplesOpen" class="examples-popover">
            <button @click="loadExample('hello')">
              <b>Hello world</b><span>browser compiler</span></button
            ><button @click="loadExample('params')">
              <b>Route parameters</b><span>/:name</span></button
            ><button @click="loadExample('api')">
              <b>API group</b><span>/api/status JSON</span></button
            ><button @click="loadExample('echo')"><b>POST echo</b><span>request body</span></button>
          </div>
        </div>
      </nav>
      <div class="top-actions">
        <span class="runtime-dot" :class="runtimeState"></span
        ><span class="runtime-label">{{ runtimeNotice }}</span
        ><button
          class="ghost-button"
          :class="`compile-${compilerState}`"
          @click="compileCurrentFile"
        >
          {{ compilerState === "compiling" ? "Compiling…" : "Compile" }}</button
        ><button class="ghost-button" @click="resetProject">Reset</button
        ><button class="run-button" @click="runProject"><span>▶</span> Run</button>
      </div>
    </header>

    <section class="workspace">
      <aside class="file-panel">
        <div class="panel-heading">
          <span>EXPLORER</span><button title="New MoonBit file" @click="addFile">＋</button>
        </div>
        <div class="file-tree">
          <button
            v-for="entry in visibleEntries"
            :key="entry.path"
            class="file-row"
            :class="{
              selected: activePath === entry.path,
              folder: entry.kind === 'folder',
            }"
            :style="{ paddingLeft: `${12 + entry.depth * 15}px` }"
            @click="
              entry.kind === 'folder' ? toggleFolder(entry.path) : openFile(entry.path, entry.kind)
            "
          >
            <span class="file-icon">{{
              entry.kind === "folder"
                ? isFolderOpen(entry.path)
                  ? "⌄"
                  : "›"
                : entry.name.endsWith(".mbt")
                  ? "◇"
                  : "□"
            }}</span
            >{{ entry.name }}
            <span v-if="entry.path === '/src/main.mbt'" class="entry-tag">main</span>
            <span
              v-if="entry.kind === 'file' && entry.path !== '/src/main.mbt'"
              class="delete-file"
              title="Delete file"
              @click.stop="removeFile(entry.path)"
              >×</span
            >
          </button>
        </div>
        <div class="project-meta">
          <div><span>◒</span> MoonBit</div>
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
            <span class="moon-icon">◇</span>{{ activePath.split("/").pop()
            }}<span v-if="dirty" class="dirty">●</span><button @click="dirty = false">×</button>
          </div>
          <div class="tab-spacer"></div>
          <button
            class="editor-tool"
            title="Format MoonBit indentation (⇧⌥F)"
            @click="formatCurrentFile"
          >
            ⌘</button
          ><button class="editor-tool" title="More">···</button>
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
          @pointerdown="startResize('terminal', $event)"
        ></div>
        <div class="terminal">
          <div class="terminal-heading">
            <span><i class="terminal-led"></i> COMPILER & TERMINAL</span
            ><span>{{ terminalReady ? "WebContainer shell" : "Browser compiler ready" }}</span>
          </div>
          <div class="compiler-result" :class="compilerState">
            <span
              >{{ activeIsMoonBit ? "moon run" : "file" }} · {{ activePath.split("/").pop() }}</span
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
          ><span>UTF-8</span><span class="status-right">⚡ JavaScript backend</span>
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
              ↻
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
            <button @click="runProject">Mount project →</button>
          </div>
        </section>
      </aside>
    </section>
  </main>
</template>

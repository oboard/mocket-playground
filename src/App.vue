<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { WebContainer, type FileSystemTree } from "@webcontainer/api";
import MoonbitEditor from "./components/MoonbitEditor.vue";
import WebTerminal from "./components/WebTerminal.vue";
import ApiClient from "./components/ApiClient.vue";

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
  "/src/moon.pkg": `supported_targets = "+js"

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
pub fn greeting() -> String {
  "Hello, Mocket!"
}
`,
  "/README.md": `# Mocket Playground

- **Compile** uses MoonBit’s browser compiler and requires no local toolchain.
- **LSP trace** runs as you type for MoonBit files and decorates values in the editor.
- **Format** normalizes indentation in the browser; use \`moon fmt\` in a full MoonBit workspace for canonical project formatting.
`,
});

const runtimeFiles: Record<string, string> = {
  "/package.json": JSON.stringify(
    {
      name: "mocket-webcontainer-runtime",
      type: "module",
      dependencies: { express: "latest" },
      scripts: { start: "node server.mjs" },
    },
    null,
    2,
  ),
  "/server.mjs": `import express from "express";

const app = express();
const port = 3111;
app.use(express.json());
app.get("/", (_request, response) => response.send("Mocket preview is ready."));
app.get("/api/hello", (_request, response) => response.json({ message: "Hello from Mocket!", runtime: "MoonBit JS" }));
app.get("/api/status", (_request, response) => response.json({ ok: true, framework: "mocket" }));
app.post("/echo", (request, response) => response.json(request.body));
app.listen(port, () => console.log(\`Mocket preview ready at http://localhost:\${port}\`));
`,
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
const webcontainer = ref<WebContainer | null>(null);
const serverProcess = ref<Awaited<ReturnType<WebContainer["spawn"]>> | null>(null);
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
    webcontainer.value = instance;
    await instance.mount(asWebContainerTree());
    instance.on("server-ready", (_port, url) => {
      previewUrl.value = url;
      runtimeState.value = "running";
      runtimeNotice.value = `WebContainer preview listening at ${url}`;
    });
    await refreshExplorer();
    runtimeState.value = "idle";
    runtimeNotice.value =
      "Workspace mounted. Compile MoonBit in the browser, or Run the WebContainer preview runtime.";
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

async function runProject() {
  await bootWebContainer();
  if (!webcontainer.value || serverProcess.value) return;
  await syncFiles();
  runtimeState.value = "booting";
  runtimeNotice.value = "Installing the WebContainer preview runtime…";
  try {
    const installProcess = await webcontainer.value.spawn("npm", ["install"]);
    const exitCode = await installProcess.exit;
    if (exitCode !== 0) throw new Error(`npm install exited with ${exitCode}`);
    runtimeNotice.value = "Starting the WebContainer preview…";
    serverProcess.value = await webcontainer.value.spawn("npm", ["run", "start"]);
  } catch (error) {
    runtimeState.value = "error";
    runtimeNotice.value = `Unable to start preview: ${error instanceof Error ? error.message : String(error)}`;
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

onBeforeUnmount(() => stopResizing?.());
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
          <WebTerminal :container="webcontainer" @ready="terminalReady = true" />
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

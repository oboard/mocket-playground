<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";

const props = defineProps<{
  container: Pick<WebContainer, "spawn" | "path"> | null;
  moonbitBin: string;
  moonbitVersion: string;
}>();
const emit = defineEmits<{ ready: [] }>();
const host = ref<HTMLElement | null>(null);
let terminal: Terminal | undefined;
let fitAddon: FitAddon | undefined;
let shellProcess: WebContainerProcess | undefined;
let resizeObserver: ResizeObserver | undefined;
let disposeInput: (() => void) | undefined;

async function startShell() {
  if (!props.container || shellProcess || !terminal) return;
  fitAddon?.fit();
  shellProcess = await props.container.spawn("jsh", {
    env: { PATH: `${props.moonbitBin}:${props.container.path}` },
    terminal: { cols: terminal.cols, rows: terminal.rows },
  });
  shellProcess.output.pipeTo(
    new WritableStream({
      write(data) {
        terminal?.write(data);
      },
    }),
  );
  const input = shellProcess.input.getWriter();
  const inputSubscription = terminal.onData((data) => void input.write(data));
  disposeInput = () => inputSubscription.dispose();
  terminal.writeln(
    `\x1b[36mMocket workspace ready — Moon Web plus official Wasm tools ${props.moonbitVersion || "installed"}.\x1b[0m`,
  );
  terminal.writeln(
    "\x1b[90mMoon Web supports: moon check, moon build --target js, and moon run --target js.\x1b[0m",
  );
  terminal.writeln(
    "\x1b[90mmoonc, moonfmt, and mooninfo are the official MoonBit Wasm tools; keep this tab open while Moon Web runs.\x1b[0m",
  );
  emit("ready");
}

function resizeShell() {
  if (!terminal || !fitAddon) return;
  fitAddon.fit();
  shellProcess?.resize({ cols: terminal.cols, rows: terminal.rows });
}

onMounted(() => {
  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: "'DM Mono', ui-monospace, monospace",
    fontSize: 11,
    theme: { background: "#171717", foreground: "#d7d7d7" },
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(host.value!);
  resizeObserver = new ResizeObserver(resizeShell);
  resizeObserver.observe(host.value!);
  resizeShell();
  void startShell();
});

watch(
  () => props.container,
  () => void startShell(),
);

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  disposeInput?.();
  void shellProcess?.kill();
  terminal?.dispose();
});
</script>

<template>
  <div ref="host" class="terminal-host" aria-label="WebContainer terminal"></div>
</template>

<style scoped>
.terminal-host {
  display: block;
  width: 100%;
  min-height: 0;
  height: 100%;
  padding: 7px 9px;
  overflow: hidden;
}

/* xterm's viewport is absolutely positioned. Give its root the host's full
   grid area so the viewport/canvas do not collapse to their content height. */
.terminal-host :deep(.xterm) {
  height: 100%;
}
</style>

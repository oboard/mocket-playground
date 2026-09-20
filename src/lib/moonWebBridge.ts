import type { WebContainer } from "@webcontainer/api";

/**
 * The browser owns the MoonBit compiler worker while WebContainer owns the
 * terminal and Node runtime. The two sides exchange small JSON messages in
 * WebContainer's filesystem so the `moon` command remains a normal terminal
 * command instead of a UI-only button.
 */
export const moonWebBridgeDirectory = "/tmp/moon-web";
const requestPrefix = "request-";
const responsePrefix = "response-";

export type MoonWebCommand = "version" | "check" | "build" | "run" | "help";

export type MoonWebRequest = {
  protocol: 1;
  id: string;
  command: MoonWebCommand;
  args: string[];
  cwd: string;
};

export type MoonWebResponse = {
  protocol: 1;
  id: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  /** A generated JavaScript file which `moon run` should execute in the terminal. */
  runPath?: string;
};

type BridgeFileSystem = Pick<WebContainer, "fs">;

function responseFile(id: string) {
  return `${moonWebBridgeDirectory}/${responsePrefix}${id}.json`;
}

function isMoonWebRequest(value: unknown): value is MoonWebRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<MoonWebRequest>;
  return (
    request.protocol === 1 &&
    typeof request.id === "string" &&
    typeof request.cwd === "string" &&
    Array.isArray(request.args) &&
    ["version", "check", "build", "run", "help"].includes(request.command ?? "")
  );
}

export function moonWebCliSource() {
  return `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const virtualBridgeDirectory = ${JSON.stringify(moonWebBridgeDirectory)};
const requestPrefix = ${JSON.stringify(requestPrefix)};
const responsePrefix = ${JSON.stringify(responsePrefix)};
const timeoutMs = 120_000;

function findBridgeDirectory() {
  let current = process.cwd();
  while (true) {
    // WebContainer's Filesystem API mounts the playground at the terminal
    // working directory, so the virtual /tmp directory is physical <root>/tmp.
    const candidate = join(current, virtualBridgeDirectory.slice(1));
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return candidate;
    current = parent;
  }
}

function usage() {
  return [
    "Moon Web — browser-hosted MoonBit workspace commands",
    "",
    "Usage: moon <command> [options]",
    "",
    "Commands implemented in this browser port:",
    "  version                 Show the browser Moon toolchain versions",
    "  check [--target js]     Type-check the current workspace",
    "  build [--target js]     Build JavaScript into _build/js/debug/build",
    "  run [--target js]       Build and execute the generated JavaScript",
    "",
    "The browser tab must remain open while a command is running.",
  ].join("\\n");
}

function parse(argv) {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    return { command: "help", args: [] };
  }
  if (argv[0] === "--version" || argv[0] === "-V") return { command: "version", args: [] };
  if (["version", "check", "build", "run"].includes(argv[0])) {
    return { command: argv[0], args: argv.slice(1) };
  }
  throw new Error("unsupported command '" + argv[0] + "'\\n\\n" + usage());
}

function writeAtomically(path, value) {
  const temporary = path + ".tmp-" + process.pid;
  writeFileSync(temporary, value);
  renameSync(temporary, path);
}

async function waitForResponse(bridgeDirectory, id) {
  const path = bridgeDirectory + "/" + responsePrefix + id + ".json";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const response = JSON.parse(readFileSync(path, "utf8"));
      unlinkSync(path);
      return response;
    }
    await sleep(40);
  }
  throw new Error("Moon Web timed out waiting for the browser compiler. Keep this playground tab open and try again.");
}

async function runGeneratedJavaScript(path) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error("generated program was terminated by " + signal));
      else resolve(code ?? 1);
    });
  }).then((code) => {
    process.exitCode = code;
  });
}

async function main() {
  let parsed;
  try {
    parsed = parse(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const bridgeDirectory = findBridgeDirectory();
  mkdirSync(bridgeDirectory, { recursive: true });
  const id = Date.now().toString(36) + "-" + process.pid + "-" + Math.random().toString(36).slice(2);
  const responsePath = bridgeDirectory + "/" + responsePrefix + id + ".json";
  if (existsSync(responsePath)) unlinkSync(responsePath);
  writeAtomically(bridgeDirectory + "/" + requestPrefix + id + ".json", JSON.stringify({
    protocol: 1,
    id,
    command: parsed.command,
    args: parsed.args,
    cwd: process.cwd(),
  }));

  try {
    const response = await waitForResponse(bridgeDirectory, id);
    if (response.stdout) process.stdout.write(response.stdout.endsWith("\\n") ? response.stdout : response.stdout + "\\n");
    if (response.stderr) process.stderr.write(response.stderr.endsWith("\\n") ? response.stderr : response.stderr + "\\n");
    process.exitCode = response.exitCode;
    if (response.exitCode === 0 && response.runPath) {
      const projectRoot = dirname(dirname(bridgeDirectory));
      await runGeneratedJavaScript(join(projectRoot, response.runPath.startsWith("/") ? response.runPath.slice(1) : response.runPath));
    }
  } catch (error) {
    console.error("moon: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

void main();
`;
}

/** Polls filesystem requests created by the terminal's `moon` launcher. */
export function startMoonWebBridge(
  container: BridgeFileSystem,
  handle: (request: MoonWebRequest) => Promise<MoonWebResponse>,
) {
  let stopped = false;
  let polling = false;
  const inFlight = new Set<string>();

  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      await container.fs.mkdir(moonWebBridgeDirectory, { recursive: true });
      const entries = await container.fs.readdir(moonWebBridgeDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (stopped || !entry.isFile() || !entry.name.startsWith(requestPrefix)) continue;
        const id = entry.name.slice(requestPrefix.length).replace(/\.json$/, "");
        if (!id || inFlight.has(id)) continue;
        inFlight.add(id);
        const path = `${moonWebBridgeDirectory}/${entry.name}`;
        void (async () => {
          try {
            const raw = await container.fs.readFile(path, "utf-8");
            const parsed: unknown = JSON.parse(raw);
            if (!isMoonWebRequest(parsed) || parsed.id !== id) return;
            const response = await handle(parsed);
            await container.fs.writeFile(responseFile(id), JSON.stringify(response));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await container.fs.writeFile(
              responseFile(id),
              JSON.stringify({ protocol: 1, id, exitCode: 1, stderr: `moon: ${message}` }),
            );
          } finally {
            await container.fs.rm(path, { force: true }).catch(() => undefined);
            inFlight.delete(id);
          }
        })();
      }
    } finally {
      polling = false;
    }
  };

  const timer = window.setInterval(() => void poll(), 40);
  void poll();
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}

import type { WebContainer } from "@webcontainer/api";
import { moonWebCliSource } from "./moonWebBridge";

const TOOLCHAIN_ROOT = "/tools/moonbit";
// WebContainer FS paths are relative to the mounted project from jsh.
const TOOLCHAIN_BIN_FROM_WORKSPACE = "tools/moonbit/bin";
const TOOLCHAIN_MARKER = `${TOOLCHAIN_ROOT}/moon_version`;
const ARCHIVE_URL = `${import.meta.env.BASE_URL}moonbit/moonbit-wasm.tar.gz`;

export type MoonbitWasmToolchain = {
  version: string;
  root: string;
};

type TarEntry = {
  path: string;
  data: Uint8Array;
  type: number;
};

function readTarString(bytes: Uint8Array, start: number, length: number) {
  const end = bytes.subarray(start, start + length).indexOf(0);
  return new TextDecoder().decode(bytes.subarray(start, start + (end < 0 ? length : end)));
}

function readTarOctal(bytes: Uint8Array, start: number, length: number) {
  const raw = readTarString(bytes, start, length).trim().replace(/\0/g, "");
  return raw ? Number.parseInt(raw, 8) : 0;
}

function isZeroBlock(bytes: Uint8Array, offset: number) {
  for (let index = offset; index < offset + 512; index += 1) if (bytes[index] !== 0) return false;
  return true;
}

/**
 * The official MoonBit Wasm toolchain is distributed as a gzip-compressed tar
 * archive. Keep parsing deliberately small: it only needs POSIX ustar files
 * and directories, and rejects paths outside the toolchain root.
 */
function readTarEntries(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length && !isZeroBlock(bytes, offset)) {
    const name = readTarString(bytes, offset, 100);
    const prefix = readTarString(bytes, offset + 345, 155);
    const path = `${prefix ? `${prefix}/` : ""}${name}`.replace(/^\.\//, "");
    const size = readTarOctal(bytes, offset + 124, 12);
    const type = bytes[offset + 156] || 48;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new Error("The MoonBit Wasm toolchain archive is truncated.");
    // GNU tar starts this official archive with a harmless `./` root entry.
    // After normalization it is empty and must not be written to the install
    // directory, but it is not a traversal attempt.
    if (!path) {
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    if (path.startsWith("/") || path.split("/").some((part) => part === "..")) {
      throw new Error("The MoonBit Wasm toolchain archive contains an unsafe path.");
    }
    entries.push({ path, data: bytes.slice(dataStart, dataEnd), type });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function unpackOfficialArchive() {
  const response = await fetch(ARCHIVE_URL);
  if (!response.ok) {
    throw new Error(`Could not download the official MoonBit Wasm toolchain (${response.status}).`);
  }
  if (!response.body)
    throw new Error("The MoonBit Wasm toolchain download did not include a response body.");
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot unpack gzip archives for the MoonBit Wasm toolchain.");
  }
  // Some Vite dev servers label a `.tar.gz` *file* with Content-Encoding:
  // gzip but still pass its raw gzip bytes through to fetch. Other hosts
  // transparently decode the body. Sniff the bytes rather than trusting that
  // header, which prevents both a double-decompression and parsing a gzip
  // header as a tar filename on a cold reload.
  let archive = new Uint8Array(await response.arrayBuffer());
  const isGzip = archive[0] === 0x1f && archive[1] === 0x8b;
  if (isGzip) {
    const compressed = new Response(archive);
    if (!compressed.body) throw new Error("Could not read the MoonBit Wasm toolchain archive.");
    archive = new Uint8Array(
      await new Response(
        compressed.body.pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer(),
    );
  }
  return readTarEntries(archive);
}

async function readText(container: Pick<WebContainer, "fs">, path: string) {
  return (await container.fs.readFile(path, "utf-8")).trim();
}

async function ensureDirectory(container: Pick<WebContainer, "fs">, path: string) {
  await container.fs.mkdir(path, { recursive: true });
}

async function installCommandWrappers(container: Pick<WebContainer, "fs" | "spawn">) {
  const bin = `${TOOLCHAIN_ROOT}/bin`;
  await ensureDirectory(container, bin);
  await Promise.all(
    ["moonc", "moonfmt", "mooninfo"]
      .map(async (command) => {
        await container.fs.writeFile(
          `${bin}/${command}`,
          `#!/bin/sh\nexec node "$(dirname "$0")/../${command}.js" "$@"\n`,
        );
      })
      .concat(container.fs.writeFile(`${bin}/moon`, moonWebCliSource())),
  );
  // `fs` paths begin at the mounted project root, while a spawned terminal sees
  // the host-like WebContainer root. Execute chmod from the workspace instead
  // of using the virtual leading slash so the resulting scripts are executable.
  const executableBin = TOOLCHAIN_BIN_FROM_WORKSPACE;
  const chmod = await container.spawn("sh", [
    "-lc",
    `chmod +x ${executableBin}/moonc ${executableBin}/moonfmt ${executableBin}/mooninfo ${executableBin}/moon`,
  ]);
  const exitCode = await chmod.exit;
  if (exitCode !== 0)
    throw new Error("WebContainer could not make MoonBit Wasm command wrappers executable.");
}

/**
 * Installs the official MoonBit compiler-tool Wasm distribution in the active
 * WebContainer. The official archive provides moonc, moonfmt and mooninfo.
 * The separately implemented `moon` browser port is installed as a terminal
 * launcher which delegates package compilation to the browser compiler bridge.
 */
export async function installMoonbitWasmToolchain(
  container: Pick<WebContainer, "fs" | "spawn">,
): Promise<MoonbitWasmToolchain> {
  try {
    const version = await readText(container, TOOLCHAIN_MARKER);
    await installCommandWrappers(container);
    return { version, root: TOOLCHAIN_ROOT };
  } catch {
    // A missing marker means first install. Any partial prior install is safe to
    // overwrite because every archive entry is written atomically by the FS API.
  }

  const entries = await unpackOfficialArchive();
  await ensureDirectory(container, TOOLCHAIN_ROOT);
  for (const entry of entries) {
    const destination = `${TOOLCHAIN_ROOT}/${entry.path}`;
    if (entry.type === 53) {
      await ensureDirectory(container, destination);
    } else if (entry.type === 48 || entry.type === 0) {
      await ensureDirectory(container, destination.slice(0, destination.lastIndexOf("/")));
      await container.fs.writeFile(destination, entry.data);
    }
  }
  await installCommandWrappers(container);
  return { version: await readText(container, TOOLCHAIN_MARKER), root: TOOLCHAIN_ROOT };
}

export const moonbitWasmToolchainBin = TOOLCHAIN_BIN_FROM_WORKSPACE;

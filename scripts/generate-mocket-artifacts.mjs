#!/usr/bin/env node
/**
 * Build the browser-side MoonBit dependency bundle used by Mocket Playground.
 *
 * Usage:
 *   MOCKET_SOURCE=/absolute/path/to/mocket node scripts/generate-mocket-artifacts.mjs
 *
 * The generated gzip is intentionally checked in: it lets a new Playground
 * visitor compile Mocket without installing MoonBit or downloading Mooncakes.
 */
import { gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative, dirname, basename, join, sep } from "node:path";

const mocketSource = process.env.MOCKET_SOURCE;
if (!mocketSource) throw new Error("Set MOCKET_SOURCE to a checked-out oboard/mocket repository.");

const sourceRoot = resolve(mocketSource);
const buildRoot = join(sourceRoot, "_build/js/release/build");
const output = resolve("public/moonbit/mocket-js-artifacts.json.gz");

async function walk(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path, extension);
      return path.endsWith(extension) ? [path] : [];
    }),
  );
  return nested.flat();
}

function artifactKey(file) {
  const directory = relative(buildRoot, dirname(file)).split(sep).join("/");
  const alias = basename(file, ".mi");
  return [`/mocket-bundle/${directory}:${alias}`, alias];
}

function packageSource(file) {
  const directory = relative(buildRoot, dirname(file)).split(sep).join("/");
  const alias = basename(file, ".mi");
  if (!directory || directory === ".") return `oboard/mocket:${alias}:/mocket-bundle`;
  if (directory.startsWith(".mooncakes/")) {
    return `${directory.slice(".mooncakes/".length).replace("/src/", "/")}:${alias}:/mocket-bundle/${directory}`;
  }
  return `oboard/mocket/${directory}:${alias}:/mocket-bundle/${directory}`;
}

const miPaths = (await walk(buildRoot, ".mi")).filter(
  (file) => !file.includes(`${sep}examples${sep}`),
);
const corePaths = (await walk(buildRoot, ".core")).filter(
  (file) => !file.includes(`${sep}examples${sep}`),
);
if (!miPaths.length || !corePaths.length) {
  throw new Error(
    "Mocket JS artifacts are missing. Run `moon build --target js --release examples/route` first.",
  );
}

const miFiles = await Promise.all(
  miPaths.map(async (file) => {
    const [path] = artifactKey(file);
    return [path, (await readFile(file)).toString("base64")];
  }),
);
const coreFiles = await Promise.all(
  corePaths.map(async (file) => (await readFile(file)).toString("base64")),
);
const pkgSources = ["moonbitlang/core:moonbit-core:/lib/core", ...miPaths.map(packageSource)];

const payload = {
  version: 1,
  target: "js",
  packages: ["oboard/mocket", "moonbitlang/async", "moonbitlang/x", "oboard/mimetype"],
  miFiles,
  coreFiles,
  pkgSources,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, gzipSync(JSON.stringify(payload), { level: 9 }));
console.log(`Wrote ${output} (${miFiles.length} interfaces, ${coreFiles.length} core files).`);

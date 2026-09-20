import { checkMocketProject, linkMocketProject, linkSingleFile } from "@moonbit/moonpad-monaco";
import type { MocketJavaScriptArtifacts } from "./mocketArtifacts";

function sourceFilePath(path: string) {
  return path.replace(/^\/+/, "").replace(/^src\//, "");
}

export type MoonBitDiagnostic = {
  level: "warning" | "error" | "info";
  path?: string;
  start?: { line: number; col: number };
  end?: { line: number; col: number };
  message: string;
  errorCode?: number;
  raw: string;
};

export type MoonBitJavaScriptBuild =
  | { kind: "success"; js: Uint8Array; diagnostics: MoonBitDiagnostic[] }
  | {
      kind: "error";
      stage: "build" | "link";
      diagnostics: MoonBitDiagnostic[];
      message: string;
    };

/**
 * Compile a standalone MoonBit executable in the browser. The resulting JS is
 * self-contained and can be written directly to a Node/WebContainer filesystem.
 */
export async function compileMoonBitToJavaScript(input: {
  code: string;
  filename?: string;
}): Promise<MoonBitJavaScriptBuild> {
  return linkSingleFile({
    code: input.code,
    filename: input.filename ?? "main.mbt",
    debugMain: false,
  });
}

/** Compiles a Mocket entrypoint against the prebuilt offline JS artifact bundle. */
export async function compileMocketToJavaScript(input: {
  code: string;
  filename?: string;
  /** Every .mbt file in the virtual project, keyed by absolute workspace path. */
  files?: Record<string, string>;
  artifacts: MocketJavaScriptArtifacts;
}): Promise<MoonBitJavaScriptBuild> {
  const pkg = "playground/mocket-starter";
  return linkMocketProject({
    code: input.code,
    filename: input.filename ?? "main.mbt",
    files: Object.entries(input.files ?? {})
      .filter(([path]) => path.endsWith(".mbt"))
      .map(([path, source]) => [sourceFilePath(path), source]),
    pkg,
    pkgSources: [`${pkg}:playground:/workspace`, ...input.artifacts.pkgSources],
    miFiles: input.artifacts.miFiles,
    coreFiles: input.artifacts.coreFiles,
    debugMain: false,
  });
}

/** Type-checks a whole Mocket project against the bundled async + Mocket interfaces. */
export async function checkMocketProjectInBrowser(input: {
  files: Record<string, string>;
  artifacts: MocketJavaScriptArtifacts;
}) {
  const pkg = "playground/mocket-starter";
  const main = input.files["/src/main.mbt"] ?? input.files["src/main.mbt"] ?? "";
  return checkMocketProject({
    code: main,
    filename: "main.mbt",
    files: Object.entries(input.files)
      .filter(([path]) => path.endsWith(".mbt"))
      .map(([path, source]) => [sourceFilePath(path), source]),
    pkg,
    pkgSources: [`${pkg}:playground:/workspace`, ...input.artifacts.pkgSources],
    miFiles: input.artifacts.miFiles,
  });
}

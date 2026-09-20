import { linkMocketProject, linkSingleFile } from "@moonbit/moonpad-monaco";
import type { MocketJavaScriptArtifacts } from "./mocketArtifacts";

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
  artifacts: MocketJavaScriptArtifacts;
}): Promise<MoonBitJavaScriptBuild> {
  const pkg = "playground/mocket-starter";
  return linkMocketProject({
    code: input.code,
    filename: input.filename ?? "main.mbt",
    pkg,
    pkgSources: [`${pkg}:playground:/workspace`, ...input.artifacts.pkgSources],
    miFiles: input.artifacts.miFiles,
    coreFiles: input.artifacts.coreFiles,
    debugMain: false,
  });
}

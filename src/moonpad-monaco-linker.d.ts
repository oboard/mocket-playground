import "@moonbit/moonpad-monaco";

declare module "@moonbit/moonpad-monaco" {
  type MoonpadDiagnostic = {
    level: "warning" | "error" | "info";
    path?: string;
    start?: { line: number; col: number };
    end?: { line: number; col: number };
    message: string;
    errorCode?: number;
    raw: string;
  };

  type MoonpadLinkInput = {
    code: string;
    filename?: string;
    debugMain?: boolean;
    enableValueTracing?: boolean;
    exportedFunctions?: string[];
  };

  type MoonpadProjectInput = MoonpadLinkInput & {
    /** All project .mbt files, with paths relative to the virtual workspace. */
    files?: [string, string][];
    pkg: string;
    pkgSources: string[];
    miFiles: [string, Uint8Array][];
  };

  type MoonpadLinkResult =
    | { kind: "success"; js: Uint8Array; diagnostics: MoonpadDiagnostic[] }
    | {
        kind: "error";
        stage: "build" | "link";
        diagnostics: MoonpadDiagnostic[];
        message: string;
      };

  type MoonpadProjectCheckResult =
    | { kind: "success"; diagnostics: MoonpadDiagnostic[] }
    | { kind: "error"; diagnostics: MoonpadDiagnostic[]; message: string };

  /**
   * Exported by this app's Vite compatibility transform. Moonpad 0.2.0 ships
   * these compiler primitives in its browser bundle but omits them from the
   * package entrypoint.
   */
  export function linkSingleFile(input: string | MoonpadLinkInput): Promise<MoonpadLinkResult>;
  export function checkMocketProject(
    input: MoonpadProjectInput,
  ): Promise<MoonpadProjectCheckResult>;
  export function linkMocketProject(
    input: MoonpadProjectInput & { coreFiles: Uint8Array[] },
  ): Promise<MoonpadLinkResult>;
}

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

  type MoonpadLinkResult =
    | { kind: "success"; js: Uint8Array; diagnostics: MoonpadDiagnostic[] }
    | {
        kind: "error";
        stage: "build" | "link";
        diagnostics: MoonpadDiagnostic[];
        message: string;
      };

  /**
   * Exported by this app's Vite compatibility transform. Moonpad 0.2.0 ships
   * the linker in its browser bundle but omits it from the package entrypoint.
   */
  export function linkSingleFile(input: string | MoonpadLinkInput): Promise<MoonpadLinkResult>;
}

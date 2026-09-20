import { defineConfig, lazyPlugins } from "vite-plus";
import vue from "@vitejs/plugin-vue";

/**
 * moonpad-monaco@0.2.0 bundles `linkSingleFile`, but accidentally does not
 * re-export it. Keep the compatibility fix in source control rather than
 * mutating node_modules, so every fresh browser build gets the same linker.
 */
function moonpadLinkerExport() {
  return {
    name: "mocket:moonpad-linker-export",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.includes("@moonbit/moonpad-monaco/dist/moonpad-monaco.js")) return null;
      const match = code.match(
        /async function (\w+)\(B\) \{\n  const u = xt\(B\), m = await wt\(\{/,
      );
      if (!match) {
        throw new Error("Could not locate moonpad-monaco’s bundled linkSingleFile implementation.");
      }
      const linkerName = match[1];
      const mocketLinker = `
async function __mocketLinkProject(input) {
  const source = typeof input === "string" ? { code: input } : input;
  const filename = (source.filename || "main.mbt").replace(/^\\/+/, "");
  const pkg = source.pkg || "playground/mocket-starter";
  const build = await wt({
    mbtFiles: [[filename, source.code]],
    miFiles: source.miFiles || [],
    stdMiFiles: St(),
    target: "js",
    pkg,
    pkgSources: source.pkgSources || [],
    isMain: true,
    enableValueTracing: source.enableValueTracing || false,
    errorFormat: "json",
    noOpt: source.debugMain || false,
    indirectImportMiFiles: []
  });
  const diagnostics = Jt(build.diagnostics);
  if (build.core === void 0 || build.mi === void 0) {
    return { kind: "error", stage: "build", diagnostics, message: Ht(diagnostics) };
  }
  try {
    const linked = await Ft({
      coreFiles: [...await ft("js"), ...(source.coreFiles || []), build.core],
      exportedFunctions: source.exportedFunctions || [],
      main: pkg,
      outputFormat: "wasm",
      pkgSources: source.pkgSources || [],
      sources: {},
      target: "js",
      testMode: false,
      sourceMap: false,
      debug: false,
      noOpt: source.debugMain || false,
      stopOnMain: false
    });
    return { kind: "success", js: linked.result, diagnostics };
  } catch (error) {
    return { kind: "error", stage: "link", diagnostics, message: gg(error) };
  }
}
`;
      return {
        code: `${code}\n${mocketLinker}\nexport { ${linkerName} as linkSingleFile, __mocketLinkProject as linkMocketProject };\n`,
        map: null,
      };
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(() => [moonpadLinkerExport(), vue()]),
  optimizeDeps: {
    // The source must pass through the compatibility transform above.
    exclude: ["@moonbit/moonpad-monaco"],
  },
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
});

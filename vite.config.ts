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
function __mocketProjectInput(input) {
  const source = typeof input === "string" ? { code: input } : input;
  const filename = (source.filename || "main.mbt").replace(/^\\/+/, "");
  const inputFiles = Array.isArray(source.files) && source.files.length > 0
    ? source.files
    : [[filename, source.code]];
  // Model URIs can be absolute while explorer paths are relative. Normalize
  // aliases first so buildPackage never receives main.mbt twice.
  const fileMap = new Map();
  for (const [path, code] of inputFiles) fileMap.set(path.replace(/^\\/+/, ""), code);
  const files = [...fileMap.entries()];
  return {
    source,
    pkg: source.pkg || "playground/mocket-starter",
    mbtFiles: files,
    pkgSources: source.pkgSources || [],
    miFiles: source.miFiles || [],
    debugMain: source.debugMain || false,
    enableValueTracing: source.enableValueTracing || false
  };
}
async function __mocketBuildProject(input) {
  const project = __mocketProjectInput(input);
  const build = await wt({
    mbtFiles: project.mbtFiles,
    miFiles: project.miFiles,
    stdMiFiles: St(),
    target: "js",
    pkg: project.pkg,
    pkgSources: project.pkgSources,
    isMain: true,
    enableValueTracing: project.enableValueTracing,
    errorFormat: "json",
    noOpt: project.debugMain,
    indirectImportMiFiles: []
  });
  return { project, build, diagnostics: Jt(build.diagnostics) };
}
async function __mocketCheckProject(input) {
  const { build, diagnostics } = await __mocketBuildProject(input);
  if (build.core === void 0 || build.mi === void 0) {
    return { kind: "error", diagnostics, message: Ht(diagnostics) };
  }
  return { kind: "success", diagnostics };
}
async function __mocketLinkProject(input) {
  const { project, build, diagnostics } = await __mocketBuildProject(input);
  if (build.core === void 0 || build.mi === void 0) {
    return { kind: "error", stage: "build", diagnostics, message: Ht(diagnostics) };
  }
  try {
    const linked = await Ft({
      coreFiles: [...await ft("js"), ...(project.source.coreFiles || []), build.core],
      exportedFunctions: project.source.exportedFunctions || [],
      main: project.pkg,
      outputFormat: "wasm",
      pkgSources: project.pkgSources,
      sources: {},
      target: "js",
      testMode: false,
      sourceMap: false,
      debug: false,
      noOpt: project.debugMain,
      stopOnMain: false
    });
    return { kind: "success", js: linked.result, diagnostics };
  } catch (error) {
    return { kind: "error", stage: "link", diagnostics, message: gg(error) };
  }
}
`;
      return {
        code: `${code}\n${mocketLinker}\nexport { ${linkerName} as linkSingleFile, __mocketCheckProject as checkMocketProject, __mocketLinkProject as linkMocketProject };\n`,
        map: null,
      };
    },
  };
}

const crossOriginIsolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

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
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
});

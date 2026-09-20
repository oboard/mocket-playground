import { defineConfig, lazyPlugins } from "vite-plus";

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
      return {
        code: `${code}\nexport { ${linkerName} as linkSingleFile };\n`,
        map: null,
      };
    },
  };
}
import vue from "@vitejs/plugin-vue";

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

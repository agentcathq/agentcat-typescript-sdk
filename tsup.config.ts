import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    outExtension({ format }) {
      return {
        js: format === "esm" ? ".mjs" : ".cjs",
      };
    },
  },
  {
    entry: ["src/index.workerd.ts"],
    format: ["esm"],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false,
    external: ["cloudflare:workers"],
    outExtension() {
      return { js: ".mjs" };
    },
  },
]);

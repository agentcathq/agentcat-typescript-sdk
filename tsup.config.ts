import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    // import.meta.url must survive the CJS transform: logging, diagnostics,
    // and MCP-version detection all derive createRequire from it. Without
    // the shim it compiles to undefined, createRequire throws, and the CJS
    // build misdetects Node as an edge runtime — routing logs to stdout,
    // which is the JSON-RPC wire on stdio transports.
    shims: true,
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

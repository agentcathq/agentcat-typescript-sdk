import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: path.join(
          import.meta.dirname,
          "wrangler.workers-test.jsonc",
        ),
      },
    }),
  ],
  test: {
    name: "workers",
    include: ["src/tests/workers/**/*.test.ts"],
    testTimeout: 15_000,
    teardownTimeout: 30_000,
  },
});

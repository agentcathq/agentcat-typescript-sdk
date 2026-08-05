import { defineConfig } from "vitest/config";

// Shared per-project settings: tests run sequentially in a single fork to
// avoid agentcat.log file conflicts (see setup.ts).
const sequential = {
  setupFiles: ["./src/tests/setup.ts"],
  pool: "forks" as const,
  poolOptions: {
    forks: {
      singleFork: true,
    },
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...sequential,
          name: "v1",
          include: ["src/tests/**/*.test.ts"],
          exclude: [
            "src/tests/v2/**",
            "src/tests/e2e-http/**",
            "src/tests/workers/**",
            "**/node_modules/**",
          ],
        },
      },
      {
        test: {
          ...sequential,
          name: "v2",
          include: ["src/tests/v2/**/*.test.ts"],
          passWithNoTests: true,
        },
      },
      {
        // Opt-in real-HTTP matrix (not part of the default `pnpm test` chain):
        // real node:http servers on ephemeral ports for both SDK majors.
        test: {
          ...sequential,
          name: "e2e-http",
          include: ["src/tests/e2e-http/**/*.test.ts"],
          testTimeout: 30_000,
          passWithNoTests: true,
        },
      },
    ],
  },
});

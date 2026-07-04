import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sdkRoot = join(__dirname, "..", "..");
// The published package name, read from package.json so this test follows any
// package rename automatically.
const pkgName: string = JSON.parse(
  readFileSync(join(sdkRoot, "package.json"), "utf8"),
).name;

// Verifies that a real Node.js process with "type": "module" can import the
// built SDK tarball and its transitive agentcat-api dependency. Catches the
// class of dual-package ESM bug where exports.import points to a .js file in
// a package missing the "type": "module" marker — the file is then parsed as
// CommonJS, yielding zero named exports and "does not provide an export
// named X" link errors. Version 0.1.8 of the predecessor API client package
// is a concrete example.
describe("ESM consumer smoke test", () => {
  let workDir: string;
  let tarballPath: string;

  beforeAll(() => {
    const packOutput = execFileSync(
      "pnpm",
      ["pack", "--pack-destination", tmpdir()],
      { cwd: sdkRoot, encoding: "utf8" },
    );
    const lastLine = packOutput.trim().split("\n").pop();
    if (!lastLine || !lastLine.endsWith(".tgz")) {
      throw new Error(
        `pnpm pack did not produce a tarball, got: ${packOutput}`,
      );
    }
    tarballPath = lastLine;

    workDir = mkdtempSync(join(tmpdir(), "agentcat-esm-consume-"));
    writeFileSync(
      join(workDir, "package.json"),
      JSON.stringify({
        name: "agentcat-esm-consumer",
        private: true,
        type: "module",
      }),
    );
    execFileSync("pnpm", ["add", tarballPath], {
      cwd: workDir,
      stdio: "inherit",
    });
  }, 120_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    if (tarballPath) rmSync(tarballPath, { force: true });
  });

  test("can import the SDK package from a real Node ESM process", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import * as m from '${pkgName}'; if (typeof m.track !== 'function') { console.error('track missing'); process.exit(2); } console.log('ok');`,
      ],
      { cwd: workDir, encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });
});

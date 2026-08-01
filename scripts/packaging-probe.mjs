// scripts/packaging-probe.mjs
// Install-topology probes: the agentcat tarball must import cleanly
// (1) with only v2 SDK packages installed, (2) with no SDK at all.
// Run from the repo root: node scripts/packaging-probe.mjs
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sh = (cmd, cwd) =>
  execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

console.log("Building and packing agentcat...");
sh("pnpm run build", root);
const tarball = join(root, sh("npm pack --silent", root).split("\n").pop());

const IMPORT_CHECK = `
import("agentcat")
  .then((m) => {
    if (typeof m.track !== "function") throw new Error("track missing");
    console.log("import OK");
  })
  .catch((e) => {
    console.error("IMPORT FAILED:", e && e.message);
    process.exit(1);
  });
`;

function probe(name, installCmd) {
  const dir = mkdtempSync(join(tmpdir(), "agentcat-probe-"));
  sh("npm init -y", dir);
  sh(`npm install --no-audit --no-fund ${installCmd} "${tarball}"`, dir);
  writeFileSync(join(dir, "check.mjs"), IMPORT_CHECK);
  try {
    console.log(`[${name}] ${sh("node check.mjs", dir)}`);
  } catch (e) {
    console.error(`[${name}] FAILED`);
    console.error(e.stdout?.toString(), e.stderr?.toString());
    process.exit(1);
  }
}

probe("v2-only", "@modelcontextprotocol/server@^2 @modelcontextprotocol/client@^2");
probe("no-sdk", "");
console.log("packaging probes passed");

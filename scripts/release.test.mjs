// scripts/release.test.mjs
// The steps of .github/workflows/release.yml (scripts/release.mjs), as in the
// Java, Rust and Ruby SDKs. ci.yml runs it on each Node version of CI:
//   node --test scripts/release.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHANGELOG,
  ReleaseError,
  VERSION_FILE,
  Version,
  dateChangelog,
  datedSection,
  fileVersion,
  main,
  newestTag,
  nextVersion,
  setFileVersion,
} from "./release.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = "https://github.com/agentcathq/agentcat-typescript-sdk";

const CHANGELOG_TEXT = `# Changelog

Intro.

## [Unreleased]

### Added

- A feature.

## [1.0.0] - 2026-11-03

### Added

- The first release.

[Unreleased]: ${REPO}/compare/v1.0.0...HEAD
[1.0.0]: ${REPO}/releases/tag/v1.0.0
`;

const packageText = (version) => `{
  "name": "agentcat",
  "version": "${version}",
  "devDependencies": {
    "zod": "^3.25"
  },
  "pnpm": {
    "overrides": {
      "vite": "7.3.7"
    }
  },
  "dependencies": {
    "agentcat-api": "1.0.3"
  }
}
`;

function v(text) {
  const version = Version.parse(text);
  assert.ok(version, `${JSON.stringify(text)} is not a version`);
  return version;
}

const raisesWith = (fn, text) =>
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ReleaseError, String(error));
    if (text !== undefined)
      assert.ok(error.message.includes(text), error.message);
    return true;
  });

test("versions parse only as MAJOR.MINOR.PATCH", () => {
  assert.equal(v("1.20.3").toString(), "1.20.3");
  assert.equal(v("0.0.0").toString(), "0.0.0");
  for (const bad of [
    "",
    "1",
    "1.2",
    "1.2.3.4",
    "01.2.3",
    "1.2.x",
    "v1.2.3",
    "1.2.3-rc.1",
    "1..3",
    "1.2.3\n",
    "99999999999999999999.0.0",
  ]) {
    assert.equal(Version.parse(bad), null, JSON.stringify(bad));
  }
});

test("the newest tag ignores tags that are not versions", () => {
  const tags = [
    "v1.0.0",
    "v1.10.0",
    "v1.9.9",
    "attempt-1",
    "v2.0",
    "1.99.0",
    "v2.1.1-beta.1",
  ];
  assert.deepEqual(newestTag(tags), v("1.10.0"));
  assert.equal(newestTag(["attempt-1"]), null);
});

test("words count from the newest tag", () => {
  const newest = v("1.2.3");
  assert.deepEqual(nextVersion("patch", newest, newest), v("1.2.4"));
  assert.deepEqual(nextVersion("minor", newest, newest), v("1.3.0"));
  assert.deepEqual(nextVersion("major", newest, newest), v("2.0.0"));
  assert.deepEqual(nextVersion("1.5.0", newest, newest), v("1.5.0"));
});

test("an exact version must be newer than the newest tag", () => {
  const newest = v("1.2.3");
  assert.throws(() => nextVersion("1.2.3", newest, newest), {
    message: "1.2.3 is not newer than the newest tag, v1.2.3",
  });
  raisesWith(() => nextVersion("1.0.9", newest, newest));
  assert.throws(() => nextVersion("next", newest, newest), {
    message: '"next" is not patch, minor, major or a version X.Y.Z',
  });
});

test("the first release is the version of package.json", () => {
  for (const word of ["patch", "minor", "major", "1.0.0"]) {
    assert.deepEqual(nextVersion(word, v("1.0.0"), null), v("1.0.0"), word);
  }
  raisesWith(
    () => nextVersion("1.1.0", v("1.0.0"), null),
    "the first release is the version of package.json, 1.0.0",
  );
  raisesWith(() => nextVersion("next", v("1.0.0"), null));
});

test("package.json gets the new version and keeps the rest", () => {
  const text = packageText("1.0.0");
  assert.deepEqual(fileVersion(text), v("1.0.0"));
  const set = setFileVersion(text, v("1.0.1"));
  assert.equal(set, text.replace('"version": "1.0.0"', '"version": "1.0.1"'));
  assert.deepEqual(fileVersion(set), v("1.0.1"));
  // A nested "version" key does not count.
  raisesWith(() =>
    setFileVersion(
      '{\n  "name": "agentcat",\n  "engines": {\n    "version": "1.0.0"\n  }\n}\n',
      v("1.0.1"),
    ),
  );
  assert.equal(fileVersion('{"version": "1.0.0-beta.1"}'), null);
  assert.equal(fileVersion("not json"), null);
});

test("dating moves the entries under the version and links both sections", () => {
  const dated = dateChangelog(
    CHANGELOG_TEXT,
    v("1.1.0"),
    "2026-12-01",
    v("1.0.0"),
  );
  const expected = CHANGELOG_TEXT.replace(
    "## [Unreleased]\n",
    "## [Unreleased]\n\n## [1.1.0] - 2026-12-01\n",
  ).replace(
    `[Unreleased]: ${REPO}/compare/v1.0.0...HEAD\n`,
    `[Unreleased]: ${REPO}/compare/v1.1.0...HEAD\n[1.1.0]: ${REPO}/compare/v1.0.0...v1.1.0\n`,
  );
  assert.equal(dated, expected);
  assert.deepEqual(datedSection(dated, v("1.1.0")), [
    "2026-12-01",
    "### Added\n\n- A feature.",
  ]);
});

test("the first release links its tag", () => {
  const first = `## [Unreleased]\n\n- One.\n\n[Unreleased]: ${REPO}/commits/main\n`;
  assert.equal(
    dateChangelog(first, v("1.0.0"), "2026-11-03", null),
    `## [Unreleased]

## [1.0.0] - 2026-11-03

- One.

[Unreleased]: ${REPO}/compare/v1.0.0...HEAD
[1.0.0]: ${REPO}/releases/tag/v1.0.0
`,
  );
});

test("dating refuses an empty section, a bad date and a missing section", () => {
  const empty =
    "## [Unreleased]\n\n### Added\n\n## [1.0.0] - 2026-11-03\n\n- One.\n\n[Unreleased]: x\n";
  raisesWith(
    () => dateChangelog(empty, v("1.0.1"), "2026-12-01", v("1.0.0")),
    "has no entry",
  );
  raisesWith(() =>
    dateChangelog(CHANGELOG_TEXT, v("1.1.0"), "2026-12-1", null),
  );
  raisesWith(() =>
    dateChangelog("# Changelog\n", v("1.1.0"), "2026-12-01", null),
  );
  const noLink = "## [Unreleased]\n\n- One.\n";
  raisesWith(
    () => dateChangelog(noLink, v("1.0.0"), "2026-12-01", null),
    "no [Unreleased] link",
  );
});

test("a section without a valid date is not dated", () => {
  assert.equal(datedSection(CHANGELOG_TEXT, v("1.0.0"))[0], "2026-11-03");
  assert.equal(datedSection("## [1.0.0] - soon\n- One.\n", v("1.0.0")), null);
  assert.equal(datedSection(CHANGELOG_TEXT, v("9.9.9")), null);
});

test("main rejects unknown arguments with the usage", () => {
  const [code, text] = main(["publish"], ROOT);
  assert.equal(code, 2);
  assert.ok(text.startsWith("usage: "), text);
});

// The three steps on a git repository, as the workflow runs them.
test("prepare, status and notes on a repository", () => {
  inRepository(
    { version: "1.0.0", changelog: CHANGELOG_TEXT, tags: ["v1.0.0"] },
    (dir) => {
      assert.deepEqual(main(["status"], dir), [0, "1.0.0 skip"]);

      assert.deepEqual(main(["prepare", "patch", "2026-12-01"], dir), [
        0,
        "1.0.1",
      ]);
      const text = readFileSync(join(dir, VERSION_FILE), "utf8");
      assert.equal(text, packageText("1.0.1"));
      assert.deepEqual(main(["status"], dir), [0, "1.0.1 publish"]);
      assert.deepEqual(main(["notes", "1.0.1"], dir), [
        0,
        "### Added\n\n- A feature.",
      ]);

      const [code, error] = main(["prepare", "patch", "2026-12-02"], dir);
      assert.equal(code, 1);
      assert.ok(error.includes("has no entry"), error);
    },
  );
});

// The CHANGELOG of this repository can always release the version of
// package.json. Before the release pull request, `prepare` dates the
// [Unreleased] entries; after it, the version has its dated section, so
// `status` publishes it while it has no tag.
test("this repository can release the version of package.json", () => {
  const changelog = readFileSync(join(ROOT, CHANGELOG), "utf8");
  const version = fileVersion(
    readFileSync(join(ROOT, VERSION_FILE), "utf8"),
  ).toString();
  inRepository({ version, changelog, tags: [] }, (dir) => {
    if (!datedSection(changelog, Version.parse(version))) {
      assert.deepEqual(main(["prepare", "patch", "2026-11-10"], dir), [
        0,
        version,
      ]);
      assert.equal(
        readFileSync(join(dir, VERSION_FILE), "utf8"),
        packageText(version),
      );
    }
    assert.deepEqual(main(["status"], dir), [0, `${version} publish`]);

    const [code, notes] = main(["notes", version], dir);
    assert.equal(code, 0);
    assert.ok(notes.includes("### "), notes);
    assert.ok(!notes.includes("## ["), notes);
    assert.ok(
      readFileSync(join(dir, CHANGELOG), "utf8").includes(
        `[${version}]: ${REPO}/`,
      ),
    );
  });
});

function inRepository({ version, changelog, tags }, body) {
  const dir = mkdtempSync(join(tmpdir(), "agentcat-release-"));
  try {
    writeFileSync(join(dir, VERSION_FILE), packageText(version));
    writeFileSync(join(dir, CHANGELOG), changelog);
    git(dir, "init", "-q");
    git(
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "start",
    );
    for (const tag of tags) git(dir, "-c", "tag.gpgsign=false", "tag", tag);
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(dir, ...args) {
  execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
}

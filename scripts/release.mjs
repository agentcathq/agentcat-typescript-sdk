// scripts/release.mjs
// The release steps of .github/workflows/release.yml, on package.json,
// CHANGELOG.md and the `v*` tags of the repository. The Java SDK
// (scripts/Release.java), the Rust SDK (xtask release) and the Ruby SDK
// (scripts/release.rb) have the same three steps. It needs Node alone: no
// dependency and no `pnpm install`.
//
//   node scripts/release.mjs prepare <patch | minor | major | X.Y.Z> <YYYY-MM-DD>
//   node scripts/release.mjs status
//   node scripts/release.mjs notes <X.Y.Z>
//
// - `prepare` picks the next version, writes it into package.json, turns the
//   [Unreleased] section of the CHANGELOG into the section of that version with
//   the date, and prints the version. `patch`, `minor` and `major` count from
//   the newest `v*` tag. With no tag yet, the first release is the version that
//   package.json holds, whatever the input word. An exact version must be newer
//   than the newest tag. An [Unreleased] section with no entry stops the step:
//   a release needs a change.
// - `status` prints `<version> publish` when the version of package.json has no
//   tag and the CHANGELOG has its dated section, else `<version> skip`.
// - `notes` prints the body of the CHANGELOG section of that version.
//
// scripts/release.test.mjs tests these steps (`node --test`, in ci.yml).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPOSITORY =
  "https://github.com/agentcathq/agentcat-typescript-sdk";
export const VERSION_FILE = "package.json";
export const CHANGELOG = "CHANGELOG.md";
const UNRELEASED = "## [Unreleased]";
export const USAGE =
  "usage: node scripts/release.mjs prepare <patch | minor | major | X.Y.Z> <YYYY-MM-DD> | status | notes <X.Y.Z>";

// MAJOR.MINOR.PATCH with decimal numbers and no leading zero: no pre-release or build part.
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// The top-level "version" of package.json: the only key with an indent of two spaces.
const VERSION_LINE = /^( {2}"version": ")([^"]*)(")/m;
const LINK_LINE = /^\[[^\]]+\]: /;

export class ReleaseError extends Error {}

/** A release version: MAJOR.MINOR.PATCH, with no pre-release or build part. */
export class Version {
  constructor(major, minor, patch) {
    this.major = major;
    this.minor = minor;
    this.patch = patch;
  }

  /** The version that `text` holds, or null. */
  static parse(text) {
    const match = VERSION_PATTERN.exec(String(text));
    if (!match) return null;
    const parts = match.slice(1).map(Number);
    if (!parts.every(Number.isSafeInteger)) return null;
    return new Version(...parts);
  }

  compare(other) {
    return (
      this.major - other.major ||
      this.minor - other.minor ||
      this.patch - other.patch
    );
  }

  equals(other) {
    return this.compare(other) === 0;
  }

  toString() {
    return `${this.major}.${this.minor}.${this.patch}`;
  }
}

/** The newest of the `v<version>` tags; other tags do not count. */
export function newestTag(tags) {
  let newest = null;
  for (const tag of tags) {
    const version = tag.startsWith("v") ? Version.parse(tag.slice(1)) : null;
    if (version && (!newest || version.compare(newest) > 0)) newest = version;
  }
  return newest;
}

/** The version of the release that `input` asks for: see the comment at the top. */
export function nextVersion(input, current, newest) {
  const word = ["patch", "minor", "major"].includes(input);
  const exact = Version.parse(input);
  if (!word && !exact) {
    throw new ReleaseError(
      `${JSON.stringify(input)} is not patch, minor, major or a version X.Y.Z`,
    );
  }
  if (!newest) {
    if (exact && !exact.equals(current)) {
      throw new ReleaseError(
        `the first release is the version of ${VERSION_FILE}, ${current}; set it there to release ${exact}`,
      );
    }
    return current;
  }
  let following;
  if (input === "patch") {
    following = new Version(newest.major, newest.minor, newest.patch + 1);
  } else if (input === "minor") {
    following = new Version(newest.major, newest.minor + 1, 0);
  } else if (input === "major") {
    following = new Version(newest.major + 1, 0, 0);
  } else {
    following = exact;
  }
  if (following.compare(newest) <= 0) {
    throw new ReleaseError(
      `${following} is not newer than the newest tag, v${newest}`,
    );
  }
  return following;
}

/** The version of package.json, or null. */
export function fileVersion(text) {
  try {
    return Version.parse(JSON.parse(text).version);
  } catch {
    return null;
  }
}

/** `text` (package.json) with `version` as its version; the rest stays byte for byte. */
export function setFileVersion(text, version) {
  if (!VERSION_LINE.test(text)) {
    throw new ReleaseError(`${VERSION_FILE} has no top-level "version" line`);
  }
  return text.replace(VERSION_LINE, `$1${version}$3`);
}

/**
 * `changelog` with its [Unreleased] entries moved under `## [<version>] - <date>`,
 * an empty [Unreleased] section above it, and the links of both sections.
 */
export function dateChangelog(changelog, version, date, previous) {
  if (!DATE_PATTERN.test(date)) {
    throw new ReleaseError(`${JSON.stringify(date)} is not a date YYYY-MM-DD`);
  }
  const lines = splitLines(changelog);
  const start = lines.indexOf(UNRELEASED);
  if (start < 0) {
    throw new ReleaseError(`${CHANGELOG} has no ${UNRELEASED} section`);
  }
  const entries = lines.slice(start + 1, sectionEnd(lines, start));
  if (!entries.some((line) => line.startsWith("- "))) {
    throw new ReleaseError(
      `the ${UNRELEASED} section of ${CHANGELOG} has no entry; add the changes of the release first`,
    );
  }
  const link = lines.findIndex((line) => line.startsWith("[Unreleased]: "));
  if (link < 0) throw new ReleaseError(`${CHANGELOG} has no [Unreleased] link`);
  const versionLink = previous
    ? `[${version}]: ${REPOSITORY}/compare/v${previous}...v${version}`
    : `[${version}]: ${REPOSITORY}/releases/tag/v${version}`;

  const out = lines.flatMap((line, index) => {
    if (index === start) return [UNRELEASED, "", `## [${version}] - ${date}`];
    if (index === link) {
      return [
        `[Unreleased]: ${REPOSITORY}/compare/v${version}...HEAD`,
        versionLink,
      ];
    }
    return [line];
  });
  return out.join("\n") + "\n";
}

/** The date and the body of the `## [<version>] - <date>` section, without its blank edges; or null. */
export function datedSection(changelog, version) {
  const lines = splitLines(changelog);
  const heading = `## [${version}] - `;
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return null;
  const date = lines[start].slice(heading.length).trim();
  if (!DATE_PATTERN.test(date)) return null;
  const body = lines.slice(start + 1, sectionEnd(lines, start)).join("\n");
  return [date, body.replace(/^\n+|\n+$/g, "")];
}

/** The lines of `text`, without the line ends. */
function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The index of the line after the section that starts at `start`: the next
 * `## ` heading or the first link line.
 */
function sectionEnd(lines, start) {
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index].startsWith("## ") || LINK_LINE.test(lines[index]))
      return index;
  }
  return lines.length;
}

function prepare(root, input, date) {
  const text = read(root, VERSION_FILE);
  const current = fileVersion(text);
  if (!current) throw new ReleaseError(`${VERSION_FILE} has no valid version`);
  const newest = newestTag(tags(root));
  const version = nextVersion(input, current, newest);
  const changelog = dateChangelog(read(root, CHANGELOG), version, date, newest);
  if (!version.equals(current)) {
    write(root, VERSION_FILE, setFileVersion(text, version));
  }
  write(root, CHANGELOG, changelog);
  return version.toString();
}

function status(root) {
  const version = fileVersion(read(root, VERSION_FILE));
  if (!version) throw new ReleaseError(`${VERSION_FILE} has no valid version`);
  const tagged = tags(root).includes(`v${version}`);
  const dated = datedSection(read(root, CHANGELOG), version) !== null;
  return `${version} ${!tagged && dated ? "publish" : "skip"}`;
}

function notes(root, text) {
  const version = Version.parse(text);
  if (!version) {
    throw new ReleaseError(`${JSON.stringify(text)} is not a version X.Y.Z`);
  }
  const section = datedSection(read(root, CHANGELOG), version);
  if (!section) {
    throw new ReleaseError(`${CHANGELOG} has no dated section for ${version}`);
  }
  return section[1];
}

/** The tags of the repository at `root`. */
function tags(root) {
  let output;
  try {
    output = execFileSync("git", ["tag", "--list"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new ReleaseError(`git tag --list failed: ${detail}`);
  }
  return splitLines(output);
}

function read(root, path) {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch (error) {
    throw new ReleaseError(`cannot read ${path}: ${error.message}`);
  }
}

function write(root, path, text) {
  try {
    writeFileSync(join(root, path), text);
  } catch (error) {
    throw new ReleaseError(`cannot write ${path}: ${error.message}`);
  }
}

/** Returns the exit code and the text for stdout or stderr. */
export function main(
  argv,
  root = fileURLToPath(new URL("..", import.meta.url)),
) {
  try {
    if (argv.length === 3 && argv[0] === "prepare") {
      return [0, prepare(root, argv[1], argv[2])];
    }
    if (argv.length === 1 && argv[0] === "status") return [0, status(root)];
    if (argv.length === 2 && argv[0] === "notes")
      return [0, notes(root, argv[1])];
    return [2, USAGE];
  } catch (error) {
    if (error instanceof ReleaseError) return [1, `release: ${error.message}`];
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [code, text] = main(process.argv.slice(2));
  if (code === 0) console.log(text);
  else console.error(text);
  process.exitCode = code;
}

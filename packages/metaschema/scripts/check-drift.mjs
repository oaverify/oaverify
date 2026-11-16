// Verify each vendored meta-schema still matches what its pinned URL
// serves.
//
//   usage: node scripts/check-drift.mjs
//   exit:  0 all pins match, 1 a pin drifted, 2 could not check
//
// WHAT THIS DETECTS: upstream changing the bytes served at a dated URL.
// Those URLs are supposed to be immutable, so a mismatch means either
// that assumption is wrong or someone hand-edited a vendored file. Both
// are worth knowing about immediately.
//
// WHAT THIS DOES NOT DETECT: a newer revision being published. There is
// no index to enumerate: `.../schema/latest` 404s, the directory listing
// 404s, spec.openapis.org publishes no list of dated URLs, and the
// upstream repository does not carry them either. Probing a hand-written
// list of candidate dates only finds dates you already guessed, which is
// how the 3.1 pin was first set two revisions behind.
//
// So: staying current is a manual check, and this script does not
// pretend otherwise. In CI this runs as the `metaschemas` job of the
// scheduled `pins` workflow, deliberately NOT in `nightly` or the PR
// gate: `pins` is the "did something we pinned move upstream" radar,
// never blocks a PR, and opens no tracking issue, so a third party
// republishing a schema (or spec.openapis.org being unreachable, exit 2)
// cannot read as a code regression. Similar reasoning keeps detection/
// out of CI entirely.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");

// Everything that stops the check from covering exactly the shipped
// versions. Any entry here means exit 2 before a single fetch.
const problems = [];

// Read the pins out of the source rather than restating them, so this
// cannot check a version the package no longer ships. Only the body of
// the METASCHEMA_REVISIONS literal is read: a `"3.1": "2025-11-23"` in a
// comment elsewhere in the file is not a pin. Inside the body every line
// that is not a comment must be a `"version": "YYYY-MM-DD"` entry, which
// may end with a `//` comment, so an entry written another way
// (`"3.1": "latest"`) is reported instead of dropping out of the check.
//
// The text of the declaration has to appear exactly once. This reads
// text and cannot tell code from a comment, so with two copies it would
// be guessing which one the package exports.
const source = readFileSync(join(pkg, "src/index.ts"), "utf8");
const blocks = [
  ...source.matchAll(
    /\bMETASCHEMA_REVISIONS\b[^=;]*=\s*Object\.freeze\(\{\r?\n([\s\S]*?)\r?\n\}\)/g,
  ),
];
const block = blocks.length === 1 ? blocks[0] : null;
const revisions = {};
const declared = new Set();
if (blocks.length > 1) {
  problems.push(
    `found ${blocks.length} METASCHEMA_REVISIONS objects in src/index.ts, expected one`,
  );
} else if (block === null) {
  problems.push("could not find the METASCHEMA_REVISIONS object in src/index.ts");
} else {
  for (const raw of block[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) continue;
    const entry = /^"([^"]+)":\s*"([^"]*)",?(?:\s*\/\/.*)?$/.exec(line);
    if (entry === null) {
      problems.push(`unreadable METASCHEMA_REVISIONS line: ${line}`);
      continue;
    }
    const [, version, revision] = entry;
    if (declared.has(version)) problems.push(`${version} is pinned more than once`);
    declared.add(version);
    if (/^\d{4}-\d{2}-\d{2}$/.test(revision)) revisions[version] = revision;
    else problems.push(`${version} is pinned to "${revision}", not a YYYY-MM-DD revision`);
  }
}

// The documents in src/vendor/ are what the package ships, so that
// directory is the version set and each side must account for the other.
let vendored = [];
try {
  vendored = readdirSync(join(pkg, "src/vendor"));
} catch (err) {
  problems.push(`could not list src/vendor: ${err.code}`);
}
const shipped = vendored
  .map((name) => /^oas-(\d+\.\d+)\.json$/.exec(name)?.[1])
  .filter((version) => version !== undefined);
if (shipped.length === 0) problems.push("no oas-<version>.json in src/vendor");
if (block !== null) {
  for (const version of shipped) {
    if (!declared.has(version)) problems.push(`${version} is vendored but not pinned`);
  }
}
for (const version of declared) {
  if (!shipped.includes(version)) problems.push(`${version} is pinned but not vendored`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-drift: ${problem}`);
  console.error("check-drift: nothing was fetched; the pins were not checked.");
  process.exit(2);
}

// 3.1 and 3.2 are vendored verbatim. 3.0 is published as draft-04 and
// converted, so the fetched document is compared against the checked-in
// *input* to that conversion rather than its output.
const localFor = (version) =>
  version === "3.0"
    ? join(pkg, "scripts/oas-3.0-upstream.json")
    : join(pkg, `src/vendor/oas-${version}.json`);

let drifted = 0;
for (const [version, revision] of Object.entries(revisions)) {
  const url = `https://spec.openapis.org/oas/${version}/schema/${revision}`;
  let upstream;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`check-drift: ${version} -> HTTP ${res.status} for ${url}`);
      process.exit(2);
    }
    upstream = await res.json();
  } catch (err) {
    console.error(`check-drift: ${version} -> fetch failed: ${err.message}`);
    process.exit(2);
  }

  // Compare parsed documents, not bytes: whitespace and key order carry
  // no meaning here, and the local copies have been through a formatter.
  const local = JSON.parse(readFileSync(localFor(version), "utf8"));
  const same = JSON.stringify(sortKeys(upstream)) === JSON.stringify(sortKeys(local));
  console.log(`${same ? "ok   " : "DRIFT"} ${version} @ ${revision}`);
  if (!same) drifted += 1;
}

if (drifted > 0) {
  console.error(
    `\ncheck-drift: ${drifted} pin(s) no longer match upstream.\n` +
      `A dated URL should be immutable, so this means either upstream mutated one\n` +
      `or a vendored file was hand-edited. Diff before assuming which.`,
  );
  process.exit(1);
}

console.log("\ncheck-drift: all pins match. (Says nothing about newer revisions existing.)");

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys(value[k])]),
  );
}

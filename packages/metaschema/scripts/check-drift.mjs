// Verify each vendored meta-schema still matches what its pinned URL
// serves.
//
//   usage: node scripts/check-drift.mjs
//   exit:  0 all pins match, 1 a pin drifted, 2 could not fetch
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
// pretend otherwise. In CI this runs in the scheduled corpus-freshness
// job, deliberately NOT in nightly-upstream or the PR gate: that job is
// the "did something we pinned move upstream" radar, never blocks a PR,
// and does not open the nightly tracking issue, so a third party
// republishing a schema (or spec.openapis.org being unreachable, exit 2)
// cannot read as a code regression. Similar reasoning keeps detection/
// out of CI entirely.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");

// Read the pins out of the source rather than restating them, so this
// cannot check a version the package no longer ships.
const source = readFileSync(join(pkg, "src/index.ts"), "utf8");
const revisions = Object.fromEntries(
  [...source.matchAll(/"(3\.[012])":\s*"(\d{4}-\d{2}-\d{2})"/g)].map((m) => [m[1], m[2]]),
);

if (Object.keys(revisions).length === 0) {
  console.error("check-drift: could not read METASCHEMA_REVISIONS from src/index.ts");
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

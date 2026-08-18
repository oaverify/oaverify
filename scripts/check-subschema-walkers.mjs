// Guard that every schema walker reaches every subschema position
// family, by making the raw position constants unreachable outside the
// module that defines them.
//
// The defect class this closes, and why a review cannot: "where do
// subschemas live" is four constants (single / array / map / mixed-map),
// and a walker consumes them by writing one loop per constant. Omitting
// one loop is invisible. It compiles, every existing test passes, and
// the walker silently steps past a whole family.
//
// At the revision this landed on, four walkers in two packages omitted
// SUBSCHEMA_MIXED_MAP_POSITIONS (`dependencies`): the validator's
// direction transform and document walk, and the stream validator's
// OAS 3.0 normalizer and classifier. Three had a demonstrated verdict
// change, the worst a validation bypass (a `readOnly` property under
// `dependencies` went unenforced on the request leg, so a client could
// send a server-owned field the spec forbids). The fourth was benign.
// #845 had already fixed the same omission in the schema package's
// walkers, which is the argument for a gate: the class recurs, and
// fixing instances has not stopped it.
//
// `subschemaEntries` / `transformSubschemaValue` / `subschemaFamilyOf`
// dispatch on one family table, so a walker built on them cannot omit a
// family and a family added later reaches every walker at once. This
// script is what stops a new walker from going back to hand-written
// loops: import the raw constants outside core and the build fails.
//
// Why a script rather than a lint rule: the exemptions below carry the
// reason each one is legitimate, and that reasoning is the part worth
// keeping. An oxlint no-restricted-imports entry would express the ban
// but not the argument.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The symbols a walker must not classify positions with directly.
 *
 * The four constants are here because consuming them means a loop per
 * family and omitting one is invisible.
 *
 * `isSubschemaKey` is here for a different and sharper reason: it is
 * wrong-by-design for a mixed position. It promises that *every* value
 * at the key is a subschema, so it must answer `false` for
 * `dependencies`, where half the values are property-name arrays. That
 * `false` means "cannot say", and every caller so far has read it as
 * "not a schema position": both `packages/spec` resolvers did, which is
 * how an external `$ref` under `dependencies` went unhoisted. The
 * predicate is a fine question to ask; it is not a way to classify a
 * position. `subschemaFamilyOf` is.
 */
const BANNED_SYMBOLS = [
  "SUBSCHEMA_SINGLE_POSITIONS",
  "SUBSCHEMA_ARRAY_POSITIONS",
  "SUBSCHEMA_MAP_POSITIONS",
  "SUBSCHEMA_MIXED_MAP_POSITIONS",
  "isSubschemaKey",
];

/**
 * Files allowed to name the raw constants, each with the reason the
 * shared iteration cannot serve it.
 *
 * Keep this list short. A new entry means a walker that cannot be
 * expressed through `subschemaEntries`, which is worth a design
 * conversation rather than an exemption.
 */
const EXEMPT = new Map([
  [
    "packages/core/src/subschema-positions.ts",
    "defines the constants and the family table built from them",
  ],
  [
    "packages/schema/src/subschema-positions.ts",
    "re-exports core's module, and nothing else; the position every " +
      "existing importer looks in. `walkSubschemas` lives here and " +
      "walks through subschemaEntries like any other caller",
  ],
  ["packages/schema/src/internals.ts", "re-exports the same, as the internals entry point"],
  [
    "packages/schema/src/compiler/well-formed.ts",
    "checks the shape of each position before iteration is safe, and " +
      "reports a different message per family; a helper that assumes " +
      "well-formed input cannot answer the question this pass asks",
  ],
  [
    "packages/schema/test/subschema-positions-derivation.test.ts",
    "pins the position table against the compiler's keyword table, so " +
      "it must read the sets themselves",
  ],
  [
    "scripts/check-subschema-walkers.mjs",
    "this script, which names the symbols in order to ban them",
  ],
]);

/** Source trees a walker could live in. */
// Every tree a walker could be written in, not just the workspace:
// the dev-only roots (conformance/, framework-tests/, detection/,
// performance/) import from the packages and could hand-roll a walk of
// their own. Nothing outside packages/ and scripts/ names the constants
// today, so this is a standing guard rather than a current finding.
const ROOTS = ["packages", "scripts", "conformance", "framework-tests", "detection", "performance"];
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"];

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
    const full = join(dir, entry);
    // lstat, so a dangling symlink is skipped rather than thrown on
    // and a symlink loop cannot recurse forever.
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      yield* sourceFiles(full);
    } else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      yield full;
    }
  }
}

const errors = [];
let scanned = 0;
const exemptSeen = new Set();

for (const dir of ROOTS) {
  for (const file of sourceFiles(join(root, dir))) {
    const rel = relative(root, file).replaceAll("\\", "/");
    // Comments are stripped first: a file may *discuss* the constants
    // (this script's own header does) without consuming them, and only
    // consuming them is the thing being banned.
    const text = readFileSync(file, "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/\/\/[^\n]*/g, "");
    const used = BANNED_SYMBOLS.filter((name) => text.includes(name));
    scanned += 1;
    if (used.length === 0) continue;
    if (EXEMPT.has(rel)) {
      exemptSeen.add(rel);
      continue;
    }
    errors.push(
      `${rel}: names ${used.join(", ")} directly. Walk with ` +
        `subschemaEntries() (or transformSubschemaValue() when rewriting, ` +
        `subschemaFamilyOf() when classifying a key) so a position family ` +
        `cannot be missed and a mixed one cannot read as absent.`,
    );
  }
}

// A stale exemption is its own defect: it reads as a standing reason
// when the file no longer needs one.
for (const [rel, why] of EXEMPT) {
  if (!exemptSeen.has(rel)) {
    errors.push(`${rel}: exempted as "${why}", but no longer names any of the constants; drop it.`);
  }
}

if (errors.length > 0) {
  console.error("check-subschema-walkers: violations:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `check-subschema-walkers: ${scanned} files scanned, ` +
    `position classification confined to ${EXEMPT.size} stated exemptions.`,
);

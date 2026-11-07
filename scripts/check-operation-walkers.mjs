#!/usr/bin/env node
// Guard that a new document walker finds a Path Item's operations
// through the operation model, by failing when a module under packages/
// that is not listed here names the HTTP method list.
//
// The defect class: "which operations does this Path Item declare" was
// answered by a hand-written loop over the method names in each module
// that needed it. Every loop was right for the fields it knew. The ones
// written before OpenAPI 3.2 stepped past `additionalOperations`, the
// ones that read an entry as written stepped past a Path Item `$ref`,
// and each fix landed in one loop and not its siblings (#1343 and #1345
// are two of those).
//
// `operationsOn`, `effectivePathItem` and `buildOperationModel` in
// `packages/core/src/operation-model.ts` answer the question once. A
// walker built on them cannot miss an operation kind, and a kind added
// later reaches every walker at once.
//
// This script cannot tell a method loop from another use of the list,
// so it bans the list's names outside the files below and lets each
// exemption say what the list is used for there. A file that spells out
// every method by hand without naming the list is outside this check. Why a
// script rather than a lint rule: the reasons are the part worth keeping.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The method list, the validator's alias for it, and the set the stream
 * package exports from it. Matched as whole identifiers.
 */
const BANNED = /\b(?:HTTP_METHODS|HTTP_METHOD_SET|METHODS)\b/;

/**
 * Files allowed to name the method list, each with what it does with it.
 *
 * Three kinds of entry. Some never enumerate operations: they define the
 * list or recognise a method name. Some are an engine's own reading of a
 * `paths` entry, kept on purpose: each decides what is served, and
 * changing one changes verdicts on malformed documents. The rest are
 * loops that have not moved onto the model, and their reasons say what
 * they miss. Moving a loop of the last two kinds is its own reviewed
 * change; when it lands, its entry here goes.
 *
 * A new entry means a walker that cannot use the model, which is worth a
 * design conversation rather than an exemption.
 */
const EXEMPT = new Map([
  ["packages/core/src/types.ts", "defines the list"],
  ["packages/core/src/index.ts", "re-exports it"],
  [
    "packages/core/src/operation-model.ts",
    "the model: `operationsOn` is the loop every other walker should call",
  ],
  [
    "packages/core/src/ref-positions.ts",
    "builds the reference-position table, where each method field is a " +
      "position a version defines; it classifies fields and visits nothing",
  ],
  [
    "packages/router/src/matcher.ts",
    "engine: the runtime router's own reading of a `paths` entry, which " +
      "decides the methods it routes, the HEAD fallback and the allowed set",
  ],
  [
    "packages/cli/src/emit-spec.ts",
    "engine: the standalone emitter's own reading of an effective Path " +
      "Item, which decides what an emitted validator serves",
  ],
  [
    "packages/validator/src/operation-cache.ts",
    "finds which method field holds an already-matched operation, by " +
      "identity, for a label and a pointer; it enumerates no operations",
  ],
  [
    "packages/validator/src/document-walk.ts",
    "exports the list under the name `parameter-locations.ts` imports; its " +
      "own walk calls `operationsOn`",
  ],
  [
    "packages/validator/src/parameter-locations.ts",
    "engine: lists parameter locations the validator cannot serve, for " +
      "the startup gate over what the runtime router routes and for the " +
      "report over what the emitter would serve",
  ],
  [
    "packages/spec/src/overlay.ts",
    "not moved: rewrites the document before resolution and applies an " +
      "operation selector to the fixed method fields only, so an " +
      "`additionalOperations` entry is not touched; a change there changes " +
      "what an overlay does",
  ],
  [
    "packages/overlay-spec/src/translate.ts",
    "recognises a method name in an overlay target or action payload; it reads no document",
  ],
  [
    "packages/check/src/schema-label.ts",
    "recognises a method segment in a JSON pointer to label a finding; it " +
      "enumerates no operations",
  ],
  [
    "packages/stream-validator/src/openapi/body-schema.ts",
    "builds the set a locator's method name is checked against",
  ],
  [
    "packages/stream-validator/src/operation.ts",
    "checks a locator's method name against that set, then reads the one operation it names",
  ],
  [
    "packages/stream-validator/src/analyzer/spec.ts",
    "not moved in full: reads each `paths` entry's method fields as " +
      "written, so a document built in memory with inherited fields lists " +
      "what it always did, and asks `effectivePathItem` only for the " +
      "methods a referencing entry lacks; an `additionalOperations` entry " +
      "is not listed",
  ],
]);

/** TypeScript sources; no package source is written in anything else. */
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
    if (entry === "test") continue;
    const full = join(dir, entry);
    // lstat, so a dangling symlink is skipped rather than thrown on.
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) yield* sourceFiles(full);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext)) && !/\.test\.[cm]?tsx?$/.test(entry)) {
      yield full;
    }
  }
}

const unlisted = [];
const stale = [];
const exemptSeen = new Set();
let scanned = 0;

for (const file of sourceFiles(join(root, "packages"))) {
  const rel = relative(root, file).replaceAll("\\", "/");
  // Comments are stripped first: a file may discuss the list without
  // reading it.
  const text = readFileSync(file, "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/[^\n]*/g, "");
  scanned += 1;
  const name = BANNED.exec(text)?.[0];
  if (name === undefined) continue;
  if (EXEMPT.has(rel)) exemptSeen.add(rel);
  else unlisted.push(`${rel} names ${name}.`);
}

// An exemption for a file that does not name the list is a false claim
// about that file.
for (const rel of EXEMPT.keys()) {
  if (!exemptSeen.has(rel)) stale.push(`${rel} is listed here but does not name the list.`);
}

if (unlisted.length > 0 || stale.length > 0) {
  const lines = [`check-operation-walkers: ${unlisted.length + stale.length} problem(s).`];
  for (const problem of [...unlisted, ...stale]) lines.push(`  ${problem}`);
  if (unlisted.length > 0) {
    lines.push(
      "",
      "To find a Path Item's operations, call operationsOn, effectivePathItem",
      "or buildOperationModel from @oaverify/internal-core/internals: they read",
      "additionalOperations and Path Item references, which a method loop",
      "misses. A module with another use for the list gets an entry in",
      "scripts/check-operation-walkers.mjs that says what the use is.",
    );
  }
  if (stale.length > 0) {
    lines.push("", "Remove a stale entry from scripts/check-operation-walkers.mjs.");
  }
  console.error(lines.join("\n"));
  process.exit(1);
}

console.log(
  `check-operation-walkers: ${scanned} files scanned, ${EXEMPT.size} name the HTTP method list, each for a stated reason.`,
);

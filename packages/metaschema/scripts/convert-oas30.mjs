// Regenerate src/vendor/oas-3.0.json from the published OAS 3.0 schema.
//
// The 3.0 meta-schema is draft-04; the compiler is 2020-12. This applies
// the (small) translation and refuses anything it does not understand.
//
// Deliberately a transform rather than a hand-edited copy: the point of
// the meta-schema route is that the rules come from OpenAPI rather than
// from us, and a vendored blob nobody can re-derive gives that up. Re-run
// against a new upstream revision and diff.
//
// The whole draft-04 surface in this document is three things. Anything
// beyond them should fail loudly rather than be silently tolerated,
// because a silent pass here means we shipped a schema we did not read.
//
//   usage: node convert-oas30.mjs scripts/oas-3.0-upstream.json src/vendor/oas-3.0.json
//
// scripts/oas-3.0-upstream.json is the unmodified published document,
// checked in so the transform's input is reviewable and the output is
// reproducible without network access.

import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node convert-oas30.mjs <in.json> <out.json>");
  process.exit(2);
}

const doc = JSON.parse(readFileSync(inPath, "utf8"));
const applied = [];

// 1. draft-04 spells the identifier `id`.
if (typeof doc.id === "string") {
  doc.$id = doc.id;
  delete doc.id;
  applied.push("id -> $id");
}

// 2. Declare the dialect we actually compile.
if (doc.$schema !== undefined) {
  doc.$schema = "https://json-schema.org/draft/2020-12/schema";
  applied.push("$schema -> 2020-12");
}

// 3. draft-04's `exclusiveMinimum` is a boolean modifier on a sibling
//    `minimum`; 2020-12 makes it the numeric bound itself. Only rewrite
//    where the boolean sits next to a numeric `minimum`, i.e. where it is
//    being *used* as a keyword. The document also *describes* OpenAPI
//    3.0's Schema Object, which has its own boolean `exclusiveMinimum`
//    field; those nodes are data and must survive untouched.
//
//    Telling them apart: a use has a sibling numeric `minimum`, a
//    description has `"type": "boolean"`.
let rewrites = 0;
const walk = (node) => {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node === null || typeof node !== "object") return;

  for (const bound of ["Minimum", "Maximum"]) {
    const flag = `exclusive${bound}`;
    const base = bound.toLowerCase();
    if (node[flag] === true && typeof node[base] === "number") {
      node[flag] = node[base];
      delete node[base];
      rewrites++;
    }
  }
  for (const v of Object.values(node)) walk(v);
};
walk(doc);
if (rewrites > 0) applied.push(`${rewrites} boolean exclusiveMin/Max -> numeric`);

// Nothing else draft-04-shaped may be present. `items` as an array,
// `dependencies`, `additionalItems` and `divisibleBy` all change meaning
// or vanish in 2020-12, so encountering one means this transform is no
// longer sufficient for the upstream document.
const unsupported = [];
const audit = (node, path) => {
  if (Array.isArray(node)) return node.forEach((v, i) => audit(v, `${path}/${i}`));
  if (node === null || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "items" && Array.isArray(v)) unsupported.push(`array-form items at ${path}`);
    if (k === "dependencies" || k === "additionalItems" || k === "divisibleBy") {
      unsupported.push(`${k} at ${path}`);
    }
    if (k === "exclusiveMinimum" || k === "exclusiveMaximum") {
      if (typeof v === "boolean" && node.type !== "boolean") {
        unsupported.push(`unpaired boolean ${k} at ${path}`);
      }
    }
    audit(v, `${path}/${k}`);
  }
};
audit(doc, "");

if (unsupported.length > 0) {
  console.error("draft-04 constructs this transform does not handle:");
  for (const u of unsupported) console.error(`  ${u}`);
  process.exit(1);
}

// `definitions` is left alone. 2020-12 does not define it, but every
// reference to it is a plain JSON pointer (`#/definitions/X`) that
// resolves structurally, so renaming to `$defs` would be churn that
// widens the diff against upstream for no behavioural gain.

writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`converted ${inPath} -> ${outPath}`);
for (const a of applied) console.log(`  ${a}`);

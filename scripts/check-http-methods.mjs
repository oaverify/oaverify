#!/usr/bin/env node
// Assert that no package hand-maintains its own HTTP method list.
//
// Seven of them did. Each was correct on the day it was written, and
// each failed silently in the same direction: a method added to the
// `HttpMethod` union and missed at one site drops that method from
// whatever the site does, with nothing to say so. `query` is the live
// precedent, added by OpenAPI 3.2 and then added to seven lists by hand
// (#898).
//
// `HTTP_METHODS` in `@oaverify/internal-core` is now the single source,
// and `HttpMethod` is derived from it, so the type cannot drift from the
// array. This guards the other half: a new local copy.

import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The one file allowed to spell the list out: the source itself.
const SOURCE = "packages/core/src/types.ts";

/** Two adjacent members are enough to recognise the list without matching prose. */
const MARKERS = ['"patch"', '"trace"'];

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const offenders = [];
let scanned = 0;
for (const file of walk(join(root, "packages"), [])) {
  const rel = relative(root, file);
  if (rel === SOURCE) continue;
  scanned += 1;
  const src = readFileSync(file, "utf8");
  const at = src.indexOf(MARKERS[1]);
  if (at === -1) continue;
  // Adjacent, so a `"trace"` used for anything else does not trip this.
  if (!src.slice(Math.max(0, at - 200), at).includes(MARKERS[0])) continue;
  offenders.push(rel);
}

if (offenders.length > 0) {
  console.error(
    `check-http-methods: ${offenders.length} file(s) spell out the HTTP method list.\n` +
      offenders.map((f) => `  ${f}`).join("\n") +
      `\n\nImport HTTP_METHODS from @oaverify/internal-core instead. It is the\n` +
      `source HttpMethod is derived from, so a local copy can silently miss\n` +
      `a method the union gains (#898).`,
  );
  process.exit(1);
}

console.log(
  `check-http-methods: ${scanned} files scanned, HTTP method list declared only in ${SOURCE}.`,
);

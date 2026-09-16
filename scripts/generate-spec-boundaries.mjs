// Write docs/spec-boundaries.md from the `@specBoundary` tags, or assert the
// committed page against them with `--check`.
//
// Two modes for the reason `check-detection-table.mjs` gives: `pnpm lint` must
// not dirty the tree, so the gate asserts and a separate script rewrites.
// Unlike that one, the input here is the source rather than another generated
// file, so the page can never be stale against something a contributor forgot
// to re-run: editing a tag and not regenerating fails the gate in the same
// commit.
//
// Exit 0 clean; exit 1 with the first difference located.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectBoundaries, renderDoc } from "./spec-boundary-doc.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(root, "packages");
const DOC = join(root, "docs", "spec-boundaries.md");
const DOC_REL = "docs/spec-boundaries.md";

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      out.push({ path: relative(root, full), source: readFileSync(full, "utf8") });
    }
  };
  for (const pkg of readdirSync(PACKAGES).sort()) {
    const src = join(PACKAGES, pkg, "src");
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // A package without a src/ is not this script's business.
    }
  }
  return out;
}

const rows = collectBoundaries(sourceFiles());
const rendered = renderDoc(rows);

if (rows.length === 0) {
  console.error("generate-spec-boundaries: found no boundaries; the collector is wrong");
  process.exit(1);
}

if (!process.argv.includes("--check")) {
  writeFileSync(DOC, rendered);
  console.log(`generate-spec-boundaries: wrote ${DOC_REL}, ${rows.length} boundaries.`);
  process.exit(0);
}

let committed;
try {
  committed = readFileSync(DOC, "utf8");
} catch {
  console.error(`check-boundaries-doc: ${DOC_REL} is missing. Run \`pnpm docs:boundaries\`.`);
  process.exit(1);
}

if (committed !== rendered) {
  const a = committed.split("\n");
  const b = rendered.split("\n");
  const at = a.findIndex((line, i) => line !== b[i]);
  console.error(
    `check-boundaries-doc: ${DOC_REL} does not match the tags it is generated from.\n\n` +
      `  first difference at line ${at + 1}\n` +
      `    committed: ${JSON.stringify(a[at] ?? "<end of file>")}\n` +
      `    from tags: ${JSON.stringify(b[at] ?? "<end of file>")}\n\n` +
      "A @specBoundary was edited without regenerating the page, or the page was\n" +
      "edited by hand. Run `pnpm docs:boundaries` and commit the result.",
  );
  process.exit(1);
}

console.log(`check-boundaries-doc: ${DOC_REL} matches the tags, ${rows.length} boundaries.`);

// Assert the `@specCites` / `@specBoundary` TSDoc contract across the workspace.
//
// Two things a reader of this repo could not do before these tags existed.
// They could not find the places where oaverify knowingly stops matching a
// specification, because those were free prose in at least nine phrasings
// ("does not assert", "asserts nothing", "deviates from", "stricter than",
// "more lenient", "under-asserts", "partial assertion", "does not sanction",
// "does not check"). And they could not read anything from the absence of such
// prose, because absence covered three different states: conformant,
// deliberate boundary nobody wrote down, and defect.
//
// The tags make both answerable. `@specCites` names the specification a
// declaration implements; `@specBoundary` names a place its behaviour departs
// from that specification's text, classified. A declaration carrying a
// `@specCites` and no `@specBoundary` is claiming it implements the cited spec
// as written, which is a contract a reviewer can check.
//
// Checked here:
//   1. Every `@specCites` carries a URL on a known specification host.
//   2. Every `@specBoundary` names one of the six kinds.
//   3. Every `@specBoundary` carries prose saying what the departure is.
//   4. Every `@specBoundary` has a `@specCites` on the same declaration, and
//      carries its own section URL where the declaration cites several specs.
//   5. A `defers` boundary references an issue.
//   6. Every exported `validate*` under packages/formats/src carries a
//      `@specCites`. This was `check-format-docs.mjs`, folded in so that one
//      script owns one notion of "cites a specification".
//
// Rule 6 is the only coverage rule. Everywhere else, a declaration is free to
// carry neither tag; what the tags mean is fixed, and where they are required
// is a separate question answered package by package.
//
// Not checked, and no version of this script can check them: that the cited
// section says what the prose claims, that the chosen kind is the right one,
// or that the set of boundaries is complete. The gate makes the convention
// enforceable going forward. It cannot prove a boundary is not missing.
//
// Exit 0 clean; exit 1 with every problem listed.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KINDS,
  docBlocksOf,
  formatValidatorCitations,
  lintDocBlock,
} from "./spec-boundary-lint.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(root, "packages");

// Every `.ts` file under each package's `src`, excluding tests. A line comment
// rather than a doc block: the glob that describes it carries the characters
// that end one.
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
      out.push(full);
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

const problems = [];
let cited = 0;
let bounded = 0;
const byKind = new Map([...KINDS.keys()].map((k) => [k, 0]));

for (const file of sourceFiles()) {
  const rel = relative(root, file);
  const source = readFileSync(file, "utf8");
  for (const block of docBlocksOf(source)) {
    const result = lintDocBlock(block.doc, `${rel}: ${block.symbol}`);
    problems.push(...result.problems);
    cited += result.cites.length;
    for (const boundary of result.boundaries) {
      bounded += 1;
      byKind.set(boundary.kind, (byKind.get(boundary.kind) ?? 0) + 1);
    }
  }
}

// Rule 6, the citation-coverage rule this script inherited.
//
// The formats package is where this repo has played whack-a-mole hardest: a
// fix lands on `email` and its sibling `idn-email` keeps the defect, or a
// U-label class is written from memory rather than from RFC 5892. Both are
// what happens when the grammar being implemented is in someone's head
// instead of in the file. A citation does not make the code correct; it makes
// the code checkable, which is the step before correct.
const formatsDir = join(PACKAGES, "formats", "src");
let validators = 0;
for (const file of readdirSync(formatsDir).sort()) {
  if (!file.endsWith(".ts") || file === "index.ts") continue;
  const { cited, uncited } = formatValidatorCitations(readFileSync(join(formatsDir, file), "utf8"));
  validators += cited.length + uncited.length;
  for (const name of uncited) {
    problems.push(
      `packages/formats/src/${file}: ${name} has no @specCites naming the spec it implements`,
    );
  }
}

if (validators === 0) {
  console.error(
    "check-spec-boundaries: found no exported validators under packages/formats/src; the matcher is wrong",
  );
  process.exit(1);
}

if (problems.length > 0) {
  console.error("check-spec-boundaries: the spec-citation contract is not met\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    "\n@specCites <url> names the spec a declaration implements.\n" +
      "@specBoundary <kind> [<url>] names where its behaviour departs from that\n" +
      "spec, followed by prose saying what the departure is and why it is right.\n" +
      "Kinds: " +
      [...KINDS.keys()].join(", ") +
      '\nSee AGENTS.md, "Marking a spec boundary".\n' +
      "A citation to a standards body not yet listed is rejected by host:\n" +
      "add it to SPEC_HOSTS in scripts/spec-boundary-lint.mjs rather than\n" +
      "dropping the citation.",
  );
  process.exit(1);
}

const summary = [...byKind.entries()]
  .filter(([, n]) => n > 0)
  .map(([kind, n]) => `${n} ${kind}`)
  .join(", ");
console.log(
  `check-spec-boundaries: ${cited} citations, ${bounded} boundaries` +
    `${summary ? ` (${summary})` : ""}; ${validators} format validators cite a spec.`,
);

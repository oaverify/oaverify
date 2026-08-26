// Assert every exported format validator cites the spec it implements, with a
// link a reader can follow.
//
// The formats package is where this repo has played whack-a-mole hardest: a
// fix lands on `email` and its sibling `idn-email` keeps the defect, or a
// U-label class is written from memory rather than from RFC 5892. Both of
// those are what happens when the grammar being implemented is in someone's
// head instead of in the file. A citation does not make the code correct; it
// makes the code checkable, which is the step before correct.
//
// Checked, for every `export function validate*` in packages/formats/src:
//   1. Its TSDoc carries an `@see`.
//   2. That `@see` carries an http(s) URL.
//   3. The URL is one of the known specification hosts, so `@see the thing I
//      was thinking of, https://example.com/my-notes` does not pass.
//
// Not checked: that the URL resolves, or that the cited section says what the
// code does. The first needs the network and the second needs a human.
//
// Exit 0 clean; exit 1 with every validator listed.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = "packages/formats/src";

/** Hosts that publish a specification, rather than someone's summary of one. */
const SPEC_HOSTS = [
  "datatracker.ietf.org",
  "www.rfc-editor.org",
  "rfc-editor.org",
  "spec.openapis.org",
  "tc39.es",
  "www.unicode.org",
  "unicode.org",
  "json-schema.org",
  "www.w3.org",
];

const dir = join(root, SRC);
const problems = [];
let checked = 0;

for (const file of readdirSync(dir).sort()) {
  if (!file.endsWith(".ts") || file === "index.ts") continue;
  const src = readFileSync(join(dir, file), "utf8");
  const re = /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*export function (validate[A-Za-z0-9]+)/g;
  for (const m of src.matchAll(re)) {
    const [, doc, name] = m;
    checked += 1;
    const where = `${SRC}/${file}: ${name}`;
    const see = /@see\s+([^\n]*)/.exec(doc);
    if (!see) {
      problems.push(`${where} has no @see naming the spec it implements`);
      continue;
    }
    const url = /(https?:\/\/[^\s)]+)/.exec(see[1]);
    if (!url) {
      problems.push(`${where} has an @see with no URL: "${see[1].trim()}"`);
      continue;
    }
    const host = new URL(url[1]).hostname;
    if (!SPEC_HOSTS.includes(host)) {
      problems.push(`${where} cites ${host}, which is not a known specification host`);
    }
  }
}

if (checked === 0) {
  console.error(
    `check-format-docs: found no exported validators under ${SRC}; the matcher is wrong`,
  );
  process.exit(1);
}

if (problems.length > 0) {
  console.error("check-format-docs: a format validator does not cite its specification\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nAdd `@see <spec and section>, <url>` to the validator's TSDoc. A format\n" +
      "whose grammar is not written down is one nobody can check against.",
  );
  process.exit(1);
}

console.log(
  `check-format-docs: ${checked} format validators cite a specification, each with a link.`,
);

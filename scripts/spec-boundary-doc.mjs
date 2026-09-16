// Render the `@specBoundary` tags as docs/spec-boundaries.md.
//
// Pure: collection takes file contents, rendering takes rows. The CLI over
// this is `generate-spec-boundaries.mjs`, which writes the page or asserts the
// committed one against it.
//
// Three transforms exist because a tag body is written for a TSDoc reader and
// the page is Markdown for somebody comparing validators:
//
//   - `{@link x}` is resolved to a bare symbol. TSDoc inline syntax means
//     nothing in the rendered page, and a reader of either surface finds a
//     sibling by name.
//   - A boundary's own URL wins over its declaration's citation. They differ
//     exactly where the boundary names a narrower section, which is the case
//     the ambiguous-anchor rule exists for, and taking the citation's would
//     silently mislabel it.
//   - A label is derived from a URL the citations do not name, so a boundary
//     pointing at a subsection still reads as "RFC 4648 section 3.5" rather
//     than as a bare link.
//
// No deduplication. Two declarations can carry the same decision at different
// layers (`maxDepth` at the compiler and at the validator), and they are two
// entries here on purpose: a reader arrives at one surface or the other, and
// the prose on each says it has a counterpart. Collapsing them would need a
// heuristic for "same decision" that nothing in the tags supports.

import { KINDS, docBlocksOf, lintDocBlock } from "./spec-boundary-lint.mjs";

/** Resolve TSDoc inline links to a bare backticked symbol. */
export function unlink(text) {
  return text.replace(/\{@link\s+([^}|]+?)(?:\s*\|\s*[^}]+)?\}/g, (_, target) => {
    const name = target.trim().split(/[.!#]/).pop() ?? target.trim();
    return `\`${name}\``;
  });
}

/** A citation line's descriptive half, with the URL taken out. */
function citeLabel(header) {
  return header
    .replace(/https?:\/\/\S+/, "")
    .replace(/[,\s]+$/, "")
    .trim();
}

/**
 * A readable name for a spec URL the citations do not label.
 *
 * Only reached when a boundary points at a section its declaration's citation
 * does not name, which is what the ambiguous-anchor rule produces.
 */
export function labelFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const { hostname, pathname, hash } = parsed;
  if (
    hostname === "www.rfc-editor.org" ||
    hostname === "rfc-editor.org" ||
    hostname === "datatracker.ietf.org" ||
    hostname === "www.ietf.org"
  ) {
    const rfc = /\/rfc(\d+)(?:\.(?:html|txt))?\/?$/i.exec(pathname);
    if (rfc) {
      const part = /^#(section|appendix)-([\w.]+)$/i.exec(hash);
      return `RFC ${rfc[1]}${part ? ` ${part[1].toLowerCase()} ${part[2]}` : ""}`;
    }
  }
  if (hostname === "spec.openapis.org") {
    if (/^\/registry\/format(?:\/|$)/.test(pathname)) return "the OpenAPI Format Registry";
    if (/^\/overlay(?:\/|$)/.test(pathname)) return "OpenAPI Overlay 1.0";
    const oas = /^\/oas\/v?(\d+(?:\.\d+)*)(?:\.html|\/)?$/i.exec(pathname);
    if (oas) return `OpenAPI ${oas[1]}`;
  }
  if (hostname === "json-schema.org") return "JSON Schema 2020-12";
  if (hostname === "yaml.org") return "YAML 1.2";
  if (
    (hostname === "docs.oasis-open.org" || hostname === "www.oasis-open.org") &&
    pathname.startsWith("/sarif/")
  ) {
    return "SARIF 2.1.0";
  }
  return url;
}

/** The spec anchor for a boundary, and the label that matches it. */
function anchorOf(boundary, cites) {
  const url = boundary.urls[0] ?? cites[0]?.urls?.[0] ?? "";
  const owner = cites.find((c) => c.urls.includes(url));
  const label = owner ? citeLabel(owner.header) : labelFromUrl(url);
  return { url, label: label || url };
}

/**
 * Every boundary in the workspace, as rows ready to render.
 *
 * `files` is a list of `{ path, source }`, so collection does no IO and the
 * caller decides what a package is.
 */
export function collectBoundaries(files) {
  const rows = [];
  for (const { path, source } of files) {
    const pkg = path.split("/")[1] ?? path;
    for (const block of docBlocksOf(source)) {
      const { boundaries, cites } = lintDocBlock(block.doc, path);
      for (const boundary of boundaries) {
        const { url, label } = anchorOf(boundary, cites);
        rows.push({
          pkg,
          path,
          line: block.line,
          symbol: block.symbol,
          kind: boundary.kind,
          url,
          label,
          body: unlink(boundary.body).trim(),
        });
      }
    }
  }
  rows.sort(
    (a, b) => a.pkg.localeCompare(b.pkg) || a.path.localeCompare(b.path) || a.line - b.line,
  );
  return rows;
}

const INTRO = `# Spec boundaries

This inventory records known specification-related behavior in oaverify:
implementation choices, deliberate restrictions, and defects awaiting repair.
Each entry describes the affected behavior and links to its source and
specification.

Use it to identify constraints relevant to your application. Entries differ
in impact, and the same behavior can appear at several API surfaces. The
counts reflect how the behavior is documented; they do not measure defect
severity or conformance.

We collect these details in one place so users can evaluate them before
adoption. Comparing validators requires equivalent inputs, dialects, and
options. The length of a published limitations list does not establish
relative correctness. See [the comparison methodology](comparison.md) for
the comparisons we have measured.

The inventory grows as behavior is examined. Tests and the
[conformance report](../conformance/REPORT.md) provide additional evidence of
coverage; issue links describe pending repairs. A citation identifies the
intended specification contract. The absence of a recorded boundary does not
establish complete conformance.

This page is generated from the \`@specBoundary\` tags in the source. The gate
checks tag structure and keeps the page current; verifying the claims and
finding omitted boundaries requires review and testing.

**How to read a kind.** Each answers one question: how does our behaviour
relate to the cited text? A kind describes the behavior, not its severity or
whether it is scheduled for repair. A \`chooses\` entry can describe a
conforming implementation choice.
`;

const OUTRO = `
## Regenerating

\`\`\`bash
pnpm docs:boundaries          # rewrite this page from the tags
pnpm check:boundaries-doc     # assert it matches (runs in \`pnpm lint\`)
\`\`\`

Do not edit this file by hand. Edit the \`@specBoundary\` tag it came from and
regenerate; the gate fails if the two disagree.
`;

/** The generated page, as a string. */
export function renderDoc(rows) {
  const out = [INTRO];

  out.push("\n| kind | meaning | entries |\n| ---- | ------- | ----- |");
  for (const [kind, meaning] of KINDS) {
    out.push(
      `| [\`${kind}\`](#${kind}) | ${meaning} | ${rows.filter((r) => r.kind === kind).length} |`,
    );
  }
  out.push(
    `\n${rows.length} documented entries across ${new Set(rows.map((r) => r.path)).size} files.\n`,
  );

  for (const [kind, meaning] of KINDS) {
    const hit = rows.filter((r) => r.kind === kind);
    if (hit.length === 0) continue;
    out.push(`\n## ${kind}\n\n${meaning[0].toUpperCase()}${meaning.slice(1)}.\n`);
    let pkg = "";
    for (const row of hit) {
      if (row.pkg !== pkg) {
        pkg = row.pkg;
        out.push(`\n### packages/${pkg}\n`);
      }
      out.push(`**\`${row.symbol}\`** ([${row.path}:${row.line}](../${row.path}#L${row.line}))`);
      out.push(`\nAgainst ${row.label}${row.url ? ` (<${row.url}>)` : ""}.\n`);
      out.push(`${row.body}\n`);
    }
  }

  out.push(OUTRO);
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

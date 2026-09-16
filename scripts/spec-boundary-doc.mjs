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
  const rfc = /\/rfc(\d+)(?:#(?:section|appendix)-([\w.]+))?/i.exec(url);
  if (rfc) {
    const part = /appendix/i.test(url) ? "appendix" : "section";
    return `RFC ${rfc[1]}${rfc[2] ? ` ${part} ${rfc[2]}` : ""}`;
  }
  if (url.includes("spec.openapis.org/registry/format")) return "the OpenAPI Format Registry";
  if (url.includes("spec.openapis.org/overlay")) return "OpenAPI Overlay 1.0";
  const oas = /spec\.openapis\.org\/oas\/v?([\d.]+)/i.exec(url);
  if (oas) return `OpenAPI ${oas[1].replace(/\.$/, "")}`;
  if (url.includes("json-schema.org")) return "JSON Schema 2020-12";
  if (url.includes("yaml.org")) return "YAML 1.2";
  if (url.includes("oasis-open.org/sarif")) return "SARIF 2.1.0";
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

Every place oaverify knowingly behaves differently from a specification it
implements, what the difference is, and why it stops there.

This page is generated from the \`@specBoundary\` tags in the source. Each
entry links the declaration that carries it, so the reasoning is one click
from the code rather than a copy of it.

**What absence means.** A declaration that cites a specification and carries
no boundary is claiming it implements the cited text as written. That is the
point of the tags, and it is what makes this page worth reading: the gaps are
enumerated, so the rest is a claim somebody can check. What the gate behind it
cannot check is completeness, so this is every boundary that has been written
down, not a proof that none is missing.

**How to read a kind.** Each answers one question: how does our behaviour
differ from the cited text?
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

  out.push("\n| kind | meaning | count |\n| ---- | ------- | ----- |");
  for (const [kind, meaning] of KINDS) {
    out.push(
      `| [\`${kind}\`](#${kind}) | ${meaning} | ${rows.filter((r) => r.kind === kind).length} |`,
    );
  }
  out.push(`\n${rows.length} boundaries across ${new Set(rows.map((r) => r.path)).size} files.\n`);

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

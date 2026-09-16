// The `@specCites` / `@specBoundary` TSDoc contract, as a pure module.
//
// `check-spec-boundaries.mjs` is the CLI over this; the parsing and the rules
// live here so they can be tested without a filesystem walk. The authoring
// procedure and the reasoning are in AGENTS.md, "Marking a spec boundary".
//
// The contract, in one sentence: `@specCites` says which specification a
// declaration implements, `@specBoundary` says where its behaviour stops
// matching that specification's text, and a declaration carrying neither is
// claiming nothing about any specification.

/** Hosts that publish a specification, rather than someone's summary of one. */
export const SPEC_HOSTS = new Set([
  "datatracker.ietf.org",
  "www.rfc-editor.org",
  "rfc-editor.org",
  "spec.openapis.org",
  "tc39.es",
  "www.unicode.org",
  "unicode.org",
  "json-schema.org",
  "www.w3.org",
]);

/**
 * The boundary kinds, each answering "how does our behaviour differ from the
 * cited specification's text?".
 *
 * The set is closed on purpose. An open vocabulary is how the prose this
 * replaces reached nine different phrasings for the same idea.
 */
export const KINDS = new Map([
  ["under-asserts", "accepts what the cited spec forbids"],
  ["narrows", "rejects what the cited spec allows"],
  ["transforms", "accepts the same set, but the value handed on differs"],
  ["chooses", "the spec grants latitude, and this picked one option"],
  ["resolves", "the spec is silent or self-contradictory, and this picked a reading"],
  ["defers", "the cited spec requires it and this does not implement it yet"],
]);

/**
 * Strip the comment furniture from a TSDoc block body, leaving the text a
 * reader sees. Input is what sits between the opening and closing markers.
 */
function docLines(doc) {
  return doc.split("\n").map((line) => line.replace(/^\s*\*? ?/, "").trimEnd());
}

/**
 * Split a TSDoc block into its block tags.
 *
 * A line whose first non-space character is `@` opens a tag; every line after
 * it, up to the next such line, is that tag's body. Text before the first tag
 * is the description and is returned separately.
 */
export function parseBlockTags(doc) {
  const tags = [];
  let description = [];
  let current = null;
  for (const line of docLines(doc)) {
    const opener = /^@([A-Za-z][A-Za-z0-9]*)[ \t]*(.*)$/.exec(line);
    if (opener) {
      if (current) tags.push(current);
      current = { tag: `@${opener[1]}`, header: opener[2].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else description.push(line);
  }
  if (current) tags.push(current);
  return {
    description: description.join("\n").trim(),
    tags: tags.map((t) => ({ ...t, body: t.body.join("\n").trim() })),
  };
}

/** Every http(s) URL in a string. */
function urlsIn(text) {
  return [...text.matchAll(/https?:\/\/[^\s)>,]+/g)].map((m) => m[0]);
}

/**
 * Check one URL, returning a problem string or null. Bare hostnames and
 * anything off the known-specification list fail: `@specCites the thing I was
 * thinking of, https://example.com/my-notes` is the shape this rejects.
 */
function urlProblem(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return `invalid URL "${url}"`;
  }
  if (!SPEC_HOSTS.has(host)) {
    return `cites ${host}, which is not a known specification host`;
  }
  return null;
}

/**
 * Apply the contract to one TSDoc block.
 *
 * `where` is a repo-relative location prefix used in problem text. Returns
 * `{ problems, cites, boundaries }`; an empty `problems` means the block is
 * well formed, which says nothing about whether the cited section supports
 * what the prose claims. No check here can know that.
 */
export function lintDocBlock(doc, where) {
  const problems = [];
  const { tags } = parseBlockTags(doc);
  const cites = [];
  const boundaries = [];

  for (const tag of tags) {
    if (tag.tag === "@specCites") {
      const urls = urlsIn(tag.header);
      if (urls.length === 0) {
        problems.push(`${where}: @specCites carries no URL: "${tag.header}"`);
        continue;
      }
      for (const url of urls) {
        const problem = urlProblem(url);
        if (problem) problems.push(`${where}: @specCites ${problem}`);
      }
      cites.push({ urls, header: tag.header });
      continue;
    }

    if (tag.tag !== "@specBoundary") continue;

    const [kind = "", ...rest] = tag.header.split(/\s+/).filter(Boolean);
    if (!KINDS.has(kind)) {
      problems.push(
        `${where}: @specBoundary kind "${kind}" is not one of ${[...KINDS.keys()].join(", ")}`,
      );
      continue;
    }

    const urls = urlsIn(rest.join(" "));
    for (const url of urls) {
      const problem = urlProblem(url);
      if (problem) problems.push(`${where}: @specBoundary ${problem}`);
    }
    if (rest.length > 0 && urls.length === 0) {
      problems.push(`${where}: @specBoundary ${kind} has trailing text that is not a URL`);
    }

    if (tag.body.length === 0) {
      problems.push(
        `${where}: @specBoundary ${kind} has no prose. Say what this does, what the` +
          ` spec says, and why this is the right stopping point.`,
      );
    }

    if (kind === "defers" && !/#\d+/.test(tag.body)) {
      problems.push(
        `${where}: @specBoundary defers carries no issue reference. An unimplemented` +
          ` requirement needs a "#<number>" a reader can follow.`,
      );
    }

    boundaries.push({ kind, urls, body: tag.body });
  }

  for (const boundary of boundaries) {
    if (cites.length === 0) {
      problems.push(
        `${where}: @specBoundary ${boundary.kind} has no @specCites on the same` +
          ` declaration. A boundary is measured against a cited spec.`,
      );
      continue;
    }
    if (cites.length > 1 && boundary.urls.length === 0) {
      problems.push(
        `${where}: @specBoundary ${boundary.kind} must carry its own URL, because the` +
          ` declaration cites ${cites.length} specs and the anchor is ambiguous.`,
      );
    }
  }

  return { problems, cites, boundaries };
}

/**
 * Every TSDoc block in a source file, with the symbol it documents.
 *
 * The symbol is best effort and is used only in problem text: it reads the
 * first declaration-shaped token after the block and falls back to the line
 * number, so a block over an unusual declaration still reports somewhere a
 * reader can go.
 */
/**
 * Exported `validate*` declarations in one formats source file, split by
 * whether their TSDoc carries a `@specCites`.
 *
 * This is the coverage rule inherited from `check-format-docs.mjs`. It matches
 * the declaration form directly rather than going through `docBlocksOf`,
 * because "every exported validator" is the population it has to enumerate:
 * a block-first walk can only report the blocks that exist, and a validator
 * carrying no TSDoc at all is exactly what this must catch.
 */
export function formatValidatorCitations(source) {
  const cited = [];
  const uncited = [];
  const re =
    /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\/\s*export\s+(?:(?:async\s+)?function\s+|const\s+)(validate[A-Za-z0-9]+)/g;
  const documented = new Set();
  for (const match of source.matchAll(re)) {
    const [, doc, name] = match;
    documented.add(name);
    if (/^\s*\*?\s*@specCites\b/m.test(doc)) cited.push(name);
    else uncited.push(name);
  }
  const bare = /export\s+(?:(?:async\s+)?function\s+|const\s+)(validate[A-Za-z0-9]+)/g;
  for (const match of source.matchAll(bare)) {
    if (!documented.has(match[1])) uncited.push(match[1]);
  }
  return { cited, uncited };
}

export function docBlocksOf(source) {
  const blocks = [];
  const re = /\/\*\*((?:(?!\*\/)[\s\S])*?)\*\//g;
  for (const match of source.matchAll(re)) {
    const doc = match[1];
    const after = source.slice(match.index + match[0].length, match.index + match[0].length + 400);
    const named =
      /^\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(
        after,
      ) ?? /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?:(]/.exec(after);
    const line = source.slice(0, match.index).split("\n").length;
    blocks.push({ doc, symbol: named?.[1] ?? `line ${line}`, line });
  }
  return blocks;
}

/**
 * The `@specCites` / `@specBoundary` parser in `scripts/spec-boundary-lint.mjs`.
 *
 * Tested here rather than beside the script because `scripts/` has no vitest
 * of its own, matching `test/floating-classifier.test.ts`.
 *
 * The gate this parser backs is vacuously green on a tree with no tags, so
 * nothing else exercises it until the first backfill lands. These cases are
 * what stands between a rule being written down and a rule being enforced:
 * every rejection below is a way a tag can be wrong that a reader would
 * otherwise have to catch by eye, which is the failure mode the tags exist to
 * end.
 */

import { describe, expect, it } from "vitest";
import {
  KINDS,
  docBlocksOf,
  formatValidatorCitations,
  lintDocBlock,
  parseBlockTags,
  // @ts-expect-error -- plain ESM module, no declarations emitted for scripts/
} from "../scripts/spec-boundary-lint.mjs";

/** Build a TSDoc block body the way it appears between the comment markers. */
const doc = (...lines: string[]) => `\n${lines.map((l) => ` * ${l}`).join("\n")}\n `;

const RFC = "https://www.rfc-editor.org/rfc/rfc9562#section-4";
const RFC2 = "https://www.rfc-editor.org/rfc/rfc5321#section-4.5.3.1";

const lint = (block: string) => lintDocBlock(block, "where") as { problems: string[] };
const problems = (block: string) => lint(block).problems;

describe("parseBlockTags", () => {
  it("splits description from tags and keeps each tag's body", () => {
    const parsed = parseBlockTags(
      doc("Leading description.", "", "@specCites " + RFC, "@public"),
    ) as { description: string; tags: Array<{ tag: string; header: string; body: string }> };
    expect(parsed.description).toBe("Leading description.");
    expect(parsed.tags.map((t) => t.tag)).toEqual(["@specCites", "@public"]);
    expect(parsed.tags[0]?.header).toBe(RFC);
  });

  it("attributes the lines after a tag to that tag, not the description", () => {
    const parsed = parseBlockTags(
      doc("@specBoundary narrows", "first line", "second line", "@public"),
    ) as { tags: Array<{ tag: string; body: string }> };
    expect(parsed.tags[0]?.body).toBe("first line\nsecond line");
    expect(parsed.tags[1]?.body).toBe("");
  });
});

describe("a well-formed block", () => {
  it("accepts a citation on its own", () => {
    expect(problems(doc("@specCites " + RFC))).toEqual([]);
  });

  it("accepts a citation with descriptive text around the URL", () => {
    expect(problems(doc("@specCites RFC 9562 section 4, " + RFC))).toEqual([]);
  });

  it("accepts a boundary of every kind", () => {
    for (const kind of KINDS.keys()) {
      const body = kind === "defers" ? "Not implemented yet, see #396." : "Why this stops here.";
      expect(problems(doc("@specCites " + RFC, "@specBoundary " + kind, body))).toEqual([]);
    }
  });

  it("accepts a boundary carrying its own section URL", () => {
    expect(problems(doc("@specCites " + RFC, "@specBoundary narrows " + RFC2, "Why."))).toEqual([]);
  });

  it("reports the tags it found", () => {
    const result = lint(doc("@specCites " + RFC, "@specBoundary narrows", "Why.")) as unknown as {
      cites: unknown[];
      boundaries: Array<{ kind: string; body: string }>;
    };
    expect(result.cites).toHaveLength(1);
    expect(result.boundaries).toEqual([{ kind: "narrows", urls: [], body: "Why." }]);
  });

  it("says nothing about a block carrying neither tag", () => {
    expect(problems(doc("Just a description.", "@public"))).toEqual([]);
  });
});

describe("citations", () => {
  it("rejects a citation with no URL", () => {
    expect(problems(doc("@specCites RFC 9562"))[0]).toContain("carries no URL");
  });

  it("rejects a citation to somebody's notes", () => {
    expect(problems(doc("@specCites https://example.com/my-notes"))[0]).toContain(
      "not a known specification host",
    );
  });

  it("rejects a bare scheme as carrying no URL at all", () => {
    expect(problems(doc("@specCites https://"))[0]).toContain("carries no URL");
  });

  it("rejects a URL-shaped string that does not parse", () => {
    expect(problems(doc("@specCites https://[bad"))[0]).toContain("invalid URL");
  });
});

describe("boundaries", () => {
  it("rejects a kind outside the closed set", () => {
    const found = problems(doc("@specCites " + RFC, "@specBoundary relaxes", "Why."));
    expect(found[0]).toContain('kind "relaxes" is not one of');
    expect(found[0]).toContain("under-asserts");
  });

  it("rejects a boundary with no kind at all", () => {
    expect(problems(doc("@specCites " + RFC, "@specBoundary", "Why."))[0]).toContain(
      'kind "" is not one of',
    );
  });

  it("rejects a boundary with no prose", () => {
    expect(problems(doc("@specCites " + RFC, "@specBoundary narrows"))[0]).toContain(
      "has no prose",
    );
  });

  it("rejects a boundary whose prose is only the next tag", () => {
    expect(problems(doc("@specCites " + RFC, "@specBoundary narrows", "@public"))[0]).toContain(
      "has no prose",
    );
  });

  it("rejects a boundary with no citation to measure against", () => {
    expect(problems(doc("@specBoundary narrows", "Why."))[0]).toContain("has no @specCites");
  });

  it("rejects trailing text that is not a URL", () => {
    expect(
      problems(doc("@specCites " + RFC, "@specBoundary narrows section 4.1", "Why."))[0],
    ).toContain("trailing text that is not a URL");
  });

  it("rejects a boundary URL off the specification hosts", () => {
    expect(
      problems(doc("@specCites " + RFC, "@specBoundary narrows https://example.com/x", "Why."))[0],
    ).toContain("not a known specification host");
  });
});

describe("an ambiguous anchor", () => {
  it("rejects several URLs on one citation tag", () => {
    expect(
      problems(doc("@specCites " + RFC + " " + RFC2, "@specBoundary narrows", "Why.")),
    ).toContain(
      "where: @specCites must carry exactly one URL; use a separate tag for each citation",
    );
  });

  it("rejects several URLs on a boundary tag", () => {
    expect(
      problems(doc("@specCites " + RFC, "@specBoundary narrows " + RFC + " " + RFC2, "Why.")),
    ).toContain(
      "where: @specBoundary must carry at most one URL; use a separate tag for each boundary",
    );
  });

  it("requires its own URL when the declaration cites several specs", () => {
    const found = problems(
      doc("@specCites " + RFC, "@specCites " + RFC2, "@specBoundary narrows", "Why."),
    );
    expect(found[0]).toContain("must carry its own URL");
    expect(found[0]).toContain("cites 2 specs");
  });

  it("is satisfied once the boundary names its section", () => {
    expect(
      problems(
        doc("@specCites " + RFC, "@specCites " + RFC2, "@specBoundary narrows " + RFC2, "Why."),
      ),
    ).toEqual([]);
  });
});

describe("defers", () => {
  it("rejects an unimplemented requirement with no issue to follow", () => {
    expect(
      problems(doc("@specCites " + RFC, "@specBoundary defers", "We do not do this yet."))[0],
    ).toContain("no issue reference");
  });

  it("accepts one that references an issue", () => {
    expect(
      problems(doc("@specCites " + RFC, "@specBoundary defers", "Not yet; see #396.")),
    ).toEqual([]);
  });
});

describe("formatValidatorCitations", () => {
  const citations = (source: string) =>
    formatValidatorCitations(source) as { cited: string[]; uncited: string[] };

  it("separates cited validators from uncited ones", () => {
    const source = [
      `/** Good.\n * @specCites ${RFC}\n */`,
      "export function validateUuid(v: string): boolean {}",
      "/** Bad. */",
      "export function validateRegex(v: string): boolean {}",
    ].join("\n");
    expect(citations(source)).toEqual({ cited: ["validateUuid"], uncited: ["validateRegex"] });
  });

  it("catches a validator carrying no TSDoc at all", () => {
    // The gate this replaces matched doc-block-then-declaration, so an
    // undocumented validator was invisible to it rather than reported.
    const source = "export function validateChar(v: string): boolean {}";
    expect(citations(source)).toEqual({ cited: [], uncited: ["validateChar"] });
  });

  it("does not count a validator twice when it is documented", () => {
    const source = [
      `/** D.\n * @specCites ${RFC}\n */`,
      "export const validateIri = () => true;",
    ].join("\n");
    expect(citations(source)).toEqual({ cited: ["validateIri"], uncited: [] });
  });

  it("ignores helpers that are not exported validators", () => {
    const source = [
      "function validateInternal(v: string): boolean {}",
      "export function parseThing(v: string): boolean {}",
    ].join("\n");
    expect(citations(source)).toEqual({ cited: [], uncited: [] });
  });

  it("treats an @see citation as absent, so the migration is enforced", () => {
    const source = [
      `/** D.\n * @see ${RFC}\n */`,
      "export function validateDate(v: string) {}",
    ].join("\n");
    expect(citations(source).uncited).toEqual(["validateDate"]);
  });
});

describe("docBlocksOf", () => {
  it("names the symbol a block documents", () => {
    const source = [
      "/** First. */",
      "export function validateUuid(value: string): boolean {}",
      "/** Second. */",
      "export const KNOWN = 1;",
      "/** Third. */",
      "interface Shape {}",
    ].join("\n");
    expect((docBlocksOf(source) as Array<{ symbol: string }>).map((b) => b.symbol)).toEqual([
      "validateUuid",
      "KNOWN",
      "Shape",
    ]);
  });

  it("names an interface member", () => {
    const source = ["interface X {", "  /** A field. */", "  cookies?: string;", "}"].join("\n");
    expect((docBlocksOf(source) as Array<{ symbol: string }>)[0]?.symbol).toBe("cookies");
  });

  it("falls back to a line number when nothing declaration-shaped follows", () => {
    const source = ["", "/** Floating. */", "", "1 + 1;"].join("\n");
    expect((docBlocksOf(source) as Array<{ symbol: string }>)[0]?.symbol).toBe("line 2");
  });

  it("does not run a block past its closing marker", () => {
    const source = ["/** One. */", "const a = 1;", "/** Two. */", "const b = 2;"].join("\n");
    const blocks = docBlocksOf(source) as Array<{ doc: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.doc).toContain("One.");
    expect(blocks[0]?.doc).not.toContain("Two.");
  });
});

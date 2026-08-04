import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { REDOS_CODES } from "../src/codes.js";
import { checkDocumentRedos } from "../src/redos-check.js";

const withPattern = (pattern: string, extra: Record<string, unknown> = {}) =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1.0.0" },
    paths: {
      "/x": {
        post: {
          operationId: "x",
          requestBody: {
            content: { "application/json": { schema: { type: "string", pattern, ...extra } } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  }) as unknown as OpenAPIDocument;

describe("checkDocumentRedos", () => {
  it("claims ambiguity rather than a certain hang", () => {
    // What is proven is that two paths consume the same input. Whether a
    // given engine turns that into observable cost varies: on this V8,
    // `^.+/.+$` is measurably quadratic while some ambiguous patterns
    // stay flat. The wording has to match the evidence.
    const message = checkDocumentRedos(withPattern("^(a+)+$"))[0]?.message ?? "";
    expect(message).toContain("is ambiguous");
    expect(message).toContain("depends on the engine");
    expect(message).not.toContain("will hang");
  });

  it("reports the textbook nested quantifier", () => {
    const issues = checkDocumentRedos(withPattern("^(a+)+$"));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("ambiguous-pattern");
    expect(issues[0]?.pointer).toBe(
      "/paths/~1x/post/requestBody/content/application~1json/schema/pattern",
    );
    expect(issues[0]?.message).toContain("regexCompiler");
    // The finding carries its own evidence: the shape of an input that
    // matches more than one way, so a reader can judge it rather than
    // trust a verdict.
    expect(issues[0]?.message).toContain("matches more than one way");
    expect(issues[0]?.message).toContain("`aaa");
  });

  it("reports a bounded outer quantifier, where the blowup is polynomial", () => {
    // The case a hand-written analysis missed: the outer `{2,3}` looks
    // bounded, and the cost is n^3 rather than exponential. Measured at
    // 1.1s for 1200 characters, and it does not return at 2000.
    expect(checkDocumentRedos(withPattern("^(a+){2,3}$"))).toHaveLength(1);
  });

  it("checks patternProperties keys, which are regexes too", () => {
    // They are compiled through the same `compilePattern` and run against
    // every property name of every object validated at that position, so
    // a crafted key reaches the engine exactly as a crafted value does.
    // Missed by the first pass; caught in review.
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1.0.0" },
      paths: {},
      components: {
        schemas: {
          A: {
            type: "object",
            patternProperties: { "^(a+)+$": { type: "string" }, "^[a-z]+$": { type: "string" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const issues = checkDocumentRedos(doc);
    expect(issues.map((i) => i.pointer)).toEqual([
      "/components/schemas/A/patternProperties/^(a+)+$",
    ]);
    expect(issues[0]?.message).toContain("crafted property name");
  });

  it("says value for a pattern and property name for a patternProperties key", () => {
    const value = checkDocumentRedos(withPattern("^(a+)+$"))[0]?.message ?? "";
    expect(value).toContain("crafted value");
    expect(value).not.toContain("property name");
  });

  it("stays silent on the shapes real specs are full of", () => {
    const safe = [
      "^[0-9]{3}-[0-9]{4}$",
      "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      "^\\d{4}-\\d{2}-\\d{2}$",
      "^[a-z0-9]+(-[a-z0-9]+)*$",
      "^[A-Z]{2,3}$",
      "^a+b+$",
      "^(a{2}){3}$",
    ];
    for (const pattern of safe) {
      expect(checkDocumentRedos(withPattern(pattern)), pattern).toEqual([]);
    }
  });

  it("declines a pattern that only the no-flag fallback would compile", () => {
    // Consistent with the other pattern rules: the two readings disagree
    // about what some constructs mean, so there is nothing safe to say.
    expect(checkDocumentRedos(withPattern("^(\\01+)+$"))).toEqual([]);
  });

  it("ignores a non-string pattern", () => {
    expect(checkDocumentRedos(withPattern("x", { pattern: 5 }))).toEqual([]);
  });

  it("finds patterns anywhere a schema can be, by pointer", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/x": {
          get: {
            operationId: "x",
            parameters: [{ name: "q", in: "query", schema: { pattern: "^(a+)+$" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: { schemas: { Named: { type: "string", pattern: "^(b+)+$" } } },
    } as unknown as OpenAPIDocument;

    expect(
      checkDocumentRedos(doc)
        .map((i) => i.pointer)
        .sort(),
    ).toEqual(["/components/schemas/Named/pattern", "/paths/~1x/get/parameters/0/schema/pattern"]);
  });

  it("analyses a repeated pattern once", () => {
    // The analysis is the expensive part, and a shared component or a
    // repeated pattern string is common. Two distinct locations, one
    // finding each, and only one analysis behind them.
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1.0.0" },
      paths: {},
      components: {
        schemas: {
          A: { type: "string", pattern: "^(a+)+$" },
          B: { type: "string", pattern: "^(a+)+$" },
        },
      },
    } as unknown as OpenAPIDocument;
    expect(checkDocumentRedos(doc)).toHaveLength(2);
  });
});

// The registry in `@oaverify/check` hand-writes this class's codes,
// because there is no union at the emit site to pin them to. This is
// the other half of that pin: what the pass actually emits.
describe("the emitted code matches the registry", () => {
  it("emits only codes REDOS_CODES lists", () => {
    const issues = checkDocumentRedos(withPattern("^(a+)+$"));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(REDOS_CODES).toContain(issue.code);
  });
});

/**
 * #742: a `type` array is a set, so a set naming one readable type has
 * to read the same whatever order it is written in. Sets naming two or
 * more readable types keep the historical first-member reading; see
 * `effectiveType` for why that is a separate question rather than a
 * fix left half done.
 */
import type { HttpRequest, OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/index.js";

type Params = Record<string, unknown>[];

const specWith = (parameters: Params, version = "3.1.0"): OpenAPIDocument =>
  ({
    openapi: version,
    info: { title: "t", version: "1" },
    paths: { "/w": { get: { parameters, responses: { "200": { description: "ok" } } } } },
  }) as unknown as OpenAPIDocument;

const get = (query: Record<string, string | string[]>): HttpRequest =>
  ({ method: "GET", path: "/w", query }) as HttpRequest;

const outcome = (
  parameters: Params,
  query: Record<string, string | string[]>,
  name = "tags",
  options: Record<string, unknown> = {},
): { valid: boolean; value: unknown } => {
  const result = createValidator(specWith(parameters), {
    returnValues: true,
    ...options,
  }).validateRequest(get(query));
  return { valid: result.valid, value: result.value.query[name] };
};

const param = (type: unknown, rest: Record<string, unknown> = {}) => [
  { name: "tags", in: "query", schema: { type, items: { type: "string" }, ...rest } },
];

describe("#742 one readable member reads the same in any order", () => {
  it("a nullable array splits whichever way it is spelled", () => {
    const expected = { valid: true, value: ["a", "b"] };
    expect(outcome(param(["array", "null"]), { tags: "a,b" })).toEqual(expected);
    expect(outcome(param(["null", "array"]), { tags: "a,b" })).toEqual(expected);
    // The reported case: `["null","array"]` read as `null`, never split,
    // and rejected every request the parameter received.
    expect(outcome(param("array"), { tags: "a,b" })).toEqual(expected);
  });

  it("a nullable scalar coerces whichever way it is spelled", () => {
    for (const type of [
      ["integer", "null"],
      ["null", "integer"],
    ]) {
      expect(outcome(param(type), { tags: "5" })).toEqual({ valid: true, value: 5 });
    }
    for (const type of [
      ["boolean", "null"],
      ["null", "boolean"],
    ]) {
      expect(outcome(param(type), { tags: "true" })).toEqual({ valid: true, value: true });
    }
  });

  it("a one-member array reads as that member written plainly", () => {
    for (const name of ["array", "string", "integer", "number", "boolean"]) {
      const plain = outcome(param(name), { tags: "5" });
      expect(outcome(param([name]), { tags: "5" })).toEqual(plain);
      expect(outcome(param([name, "null"]), { tags: "5" })).toEqual(plain);
    }
  });

  it("holds across the array styles", () => {
    for (const [style, explode, input] of [
      ["form", false, "a,b"],
      ["form", true, ["a", "b"]],
      ["pipeDelimited", false, "a|b"],
      ["spaceDelimited", false, "a b"],
    ] as [string, boolean, string | string[]][]) {
      const one = (type: unknown) =>
        outcome(
          [
            {
              name: "tags",
              in: "query",
              style,
              explode,
              schema: { type, items: { type: "string" } },
            },
          ],
          {
            tags: input,
          },
        );
      expect(one(["null", "array"])).toEqual(one(["array", "null"]));
      expect(one(["null", "array"]).valid).toBe(true);
    }
  });

  it("holds for a header parameter", () => {
    const one = (type: unknown) => {
      const result = createValidator(
        specWith([{ name: "x-tags", in: "header", schema: { type, items: { type: "string" } } }]),
        { returnValues: true },
      ).validateRequest({ method: "GET", path: "/w", headers: { "x-tags": "a,b" } } as HttpRequest);
      return { valid: result.valid, value: result.value.headers["x-tags"] };
    };
    expect(one(["null", "array"])).toEqual(one(["array", "null"]));
    expect(one(["null", "array"])).toEqual({ valid: true, value: ["a", "b"] });
  });

  it("makes a nullable array eligible for the bracketed spelling", () => {
    const opts = { allowBracketedQueryArrays: true };
    for (const type of [
      ["array", "null"],
      ["null", "array"],
    ]) {
      expect(outcome(param(type), { "tags[]": ["a", "b"] }, "tags", opts)).toEqual({
        valid: true,
        value: ["a", "b"],
      });
    }
  });

  it("leaves OAS 3.0 nullable alone", () => {
    const result = createValidator(
      specWith(
        [
          {
            name: "tags",
            in: "query",
            schema: { type: "array", nullable: true, items: { type: "string" } },
          },
        ],
        "3.0.3",
      ),
      { returnValues: true },
    ).validateRequest(get({ tags: "a,b" }));
    expect(result.value.query["tags"]).toEqual(["a", "b"]);
  });
});

describe("#742 two readable members keep the historical reading", () => {
  it("still reads the first member, so order still decides", () => {
    // Pinned deliberately. Every reading is total, so choosing one
    // rejects input the other member accepts; the fix for that is a
    // different shape and is tracked separately. This test exists so
    // the deferral is visible rather than assumed.
    expect(outcome(param(["array", "string"]), { tags: "a,b" })).toEqual({
      valid: true,
      value: ["a", "b"],
    });
    expect(outcome(param(["string", "array"]), { tags: "a,b" })).toEqual({
      valid: true,
      value: "a,b",
    });
  });

  it("accepts what it accepted before for object unions", () => {
    const objectUnion = [
      {
        name: "tags",
        in: "query",
        style: "form",
        explode: true,
        schema: { type: ["object", "boolean"], properties: { z: { type: "string" } } },
      },
    ];
    expect(outcome(objectUnion, { tags: "hello", z: "1" }).valid).toBe(true);
  });
});

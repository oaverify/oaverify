import { describe, expect, it } from "vitest";
import { CodeGen } from "../src/codegen/index.js";
import { createKeywordContext, dynamicRefKeyword, refKeyword } from "../src/keywords/index.js";
import { compile } from "./helpers.js";

const directKeywordContext = (schema: unknown) =>
  createKeywordContext({
    gen: new CodeGen(),
    schema,
    parentSchema: {},
    data: "data",
    path: "path",
    errors: "errors",
    compileSubschema: () => "subschema",
    resolveRef: () => "refTarget",
  });

describe("$ref keyword", () => {
  it("resolves a simple reference into $defs", () => {
    const v = compile({
      $defs: { Pet: { type: "object", required: ["name"] } },
      $ref: "#/$defs/Pet",
    });
    expect(v.validate({ name: "Fido" }).valid).toBe(true);
    expect(v.validate({}).valid).toBe(false);
  });

  it("resolves a nested path within $defs", () => {
    const v = compile({
      $defs: {
        Address: { properties: { zip: { type: "string" } } },
      },
      $ref: "#/$defs/Address/properties/zip",
    });
    expect(v.validate("90210").valid).toBe(true);
    expect(v.validate(90_210).valid).toBe(false);
  });

  it("resolves #anchor references", () => {
    const v = compile({
      $defs: { Tag: { $anchor: "tag", type: "string" } },
      $ref: "#tag",
    });
    expect(v.validate("fish").valid).toBe(true);
    expect(v.validate(1).valid).toBe(false);
  });

  it("handles a self-referential (recursive) schema via cycle cache", () => {
    const tree = {
      $defs: {
        Node: {
          type: "object",
          required: ["value"],
          properties: {
            value: { type: "number" },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
        },
      },
      $ref: "#/$defs/Node",
    };
    const v = compile(tree);
    expect(
      v.validate({
        value: 1,
        children: [
          { value: 2, children: [] },
          { value: 3, children: [{ value: 4 }] },
        ],
      }).valid,
    ).toBe(true);
    expect(v.validate({ value: 1, children: [{ value: "nope" }] }).valid).toBe(false);
  });

  it("throws a clear error for an unknown ref during compile", () => {
    expect(() =>
      compile({
        $ref: "#/$defs/Nope",
      }),
    ).toThrow(/Nope/);
  });

  it("rejects a non-string ref before codegen", () => {
    expect(() => compile({ $ref: 42 } as never)).toThrow(
      /keyword "\$ref" requires a URI-reference string/,
    );
  });

  it("rejects a non-string ref when the keyword is compiled directly", () => {
    expect(() => refKeyword.compile(directKeywordContext(42))).toThrow(
      /keyword "\$ref" requires a URI-reference string/,
    );
  });

  it("decodes percent-encoded JSON Pointer fragments before unescaping", () => {
    // ajv #2447: fragments generated from generic type names often
    // contain URI-encoded chars (e.g. "<" → %3C). The resolver must
    // run `decodeURIComponent` before the ~0/~1 JSON-Pointer unescape
    // so these refs resolve.
    const v = compile({
      $defs: {
        "Record<string,Person>": {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
      $ref: "#/$defs/Record%3Cstring%2CPerson%3E",
    });
    expect(v.validate({ name: "x" }).valid).toBe(true);
    expect(v.validate({ name: 1 }).valid).toBe(false);
  });
});

describe("$dynamicRef fallback", () => {
  it("behaves like $ref when no runtime dynamic scoping is required", () => {
    const v = compile({
      $defs: { Thing: { $dynamicAnchor: "T", type: "string" } },
      $dynamicRef: "#T",
    });
    expect(v.validate("ok").valid).toBe(true);
    expect(v.validate(1).valid).toBe(false);
  });

  it("rejects a non-string dynamic ref before codegen", () => {
    expect(() => compile({ $dynamicRef: 42 } as never)).toThrow(
      /keyword "\$dynamicRef" requires a URI-reference string/,
    );
  });

  it("rejects a non-string dynamic ref when the keyword is compiled directly", () => {
    expect(() => dynamicRefKeyword.compile(directKeywordContext(42))).toThrow(
      /keyword "\$dynamicRef" requires a URI-reference string/,
    );
  });
});

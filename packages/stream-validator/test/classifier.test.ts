import { describe, expect, it } from "vitest";
import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import { classify, ClassifierError } from "../src/classifier/index.js";

// Tests deliberately pass draft-07 and unknown keywords (`dependencies`,
// `frobnicate`) to check how the classifier treats them, so this takes a
// looser type than `SchemaOrBoolean` rather than casting at every call.
function rootStrategy(schema: SchemaOrBoolean | Record<string, unknown>, opts = {}) {
  return classify(schema as SchemaOrBoolean, opts).root;
}

describe("classify: scalars and structure", () => {
  it("classifies a boolean schema as stream", () => {
    expect(rootStrategy(true)).toBe("stream");
    expect(rootStrategy(false)).toBe("stream");
  });

  it("classifies a forward scalar schema as stream", () => {
    expect(rootStrategy({ type: "string", minLength: 1, maxLength: 9, pattern: "^a" })).toBe(
      "stream",
    );
    expect(rootStrategy({ type: "number", minimum: 0, exclusiveMaximum: 10, multipleOf: 2 })).toBe(
      "stream",
    );
  });

  it("an object with scalar properties streams, and each property streams", () => {
    const schema: SchemaObject = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "integer" } },
      required: ["a"],
      additionalProperties: false,
    };
    const c = classify(schema);
    expect(c.root).toBe("stream");
    expect(c.strategyOf(schema.properties?.a as SchemaOrBoolean)).toBe("stream");
  });
});

describe("classify: value equality", () => {
  it("scalar enum/const stream; object/array enum/const buffer", () => {
    expect(rootStrategy({ enum: ["a", 1, true, null] })).toBe("stream");
    expect(rootStrategy({ const: 42 })).toBe("stream");
    expect(rootStrategy({ enum: ["a", { nested: true }] })).toBe("buffer");
    expect(rootStrategy({ const: [1, 2, 3] })).toBe("buffer");
  });
});

describe("classify: composition", () => {
  it("allOf/anyOf/oneOf/not of forward children is tee", () => {
    expect(rootStrategy({ allOf: [{ type: "string" }, { minLength: 1 }] })).toBe("tee");
    expect(rootStrategy({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("tee");
    expect(rootStrategy({ oneOf: [{ const: "a" }, { const: "b" }] })).toBe("tee");
    expect(rootStrategy({ not: { type: "null" } })).toBe("tee");
  });

  it("composition with a non-forward branch is buffer", () => {
    expect(rootStrategy({ oneOf: [{ const: { a: 1 } }, { const: { b: 2 } }] })).toBe("buffer");
    expect(rootStrategy({ not: { enum: [{ a: 1 }] } })).toBe("buffer");
    expect(
      rootStrategy({ allOf: [{ type: "object" }, { oneOf: [{ const: [] }, { const: {} }] }] }),
    ).toBe("buffer");
  });

  it("parity forces anyOf/oneOf to buffer", () => {
    expect(rootStrategy({ oneOf: [{ const: "a" }, { const: "b" }] }, { parity: true })).toBe(
      "buffer",
    );
    expect(rootStrategy({ anyOf: [{ type: "string" }] }, { parity: true })).toBe("buffer");
    // allOf/not are not forced by parity.
    expect(rootStrategy({ allOf: [{ type: "string" }] }, { parity: true })).toBe("tee");
  });
});

describe("classify: always-buffer applicators", () => {
  it("dependentSchemas and discriminator buffer", () => {
    expect(rootStrategy({ dependentSchemas: { a: { required: ["b"] } } })).toBe("buffer");
    expect(
      rootStrategy({ discriminator: { propertyName: "kind" }, oneOf: [{ type: "object" }] }),
    ).toBe("buffer");
  });

  it("draft-07 dependencies: array-form streams, schema-form buffers", () => {
    expect(rootStrategy({ dependencies: { a: ["b", "c"] } })).toBe("stream");
    expect(rootStrategy({ dependencies: { a: { required: ["b"] } } })).toBe("buffer");
  });
});

describe("classify: contains", () => {
  it("forward predicate streams; non-forward predicate buffers", () => {
    expect(rootStrategy({ type: "array", contains: { type: "string" } })).toBe("stream");
    expect(rootStrategy({ type: "array", contains: { const: { a: 1 } } })).toBe("buffer");
  });
});

describe("classify: member applicators do not force the parent to buffer", () => {
  it("a buffer property value leaves the object streaming", () => {
    const schema: SchemaObject = {
      type: "object",
      properties: { kind: { oneOf: [{ const: { a: 1 } }, { const: { b: 2 } }] } },
    };
    const c = classify(schema);
    expect(c.root).toBe("stream");
    expect(c.strategyOf(schema.properties?.kind as SchemaOrBoolean)).toBe("buffer");
  });

  it("a buffer array item leaves the array streaming", () => {
    const schema: SchemaObject = { type: "array", items: { const: { a: 1 } } };
    const c = classify(schema);
    expect(c.root).toBe("stream");
    expect(c.strategyOf(schema.items as SchemaOrBoolean)).toBe("buffer");
  });
});

describe("classify: $ref graph and SCC fixpoint", () => {
  it("a $ref to a buffer target is buffer at the reference site", () => {
    const schema: SchemaObject = {
      allOf: [{ $ref: "#/$defs/Obj" }],
      $defs: { Obj: { oneOf: [{ const: { a: 1 } }, { const: { b: 2 } }] } },
    };
    expect(classify(schema).root).toBe("buffer");
  });

  it("a purely-forward recursive schema stays stream (recursive spine call)", () => {
    const schema: SchemaObject = {
      type: "object",
      properties: { children: { type: "array", items: { $ref: "#" } } },
    };
    expect(classify(schema).root).toBe("stream");
  });

  it("a ref cycle that reaches a buffer node is buffer throughout the cycle", () => {
    const schema: SchemaObject = {
      $ref: "#/$defs/A",
      $defs: {
        A: { allOf: [{ $ref: "#/$defs/B" }] },
        B: { allOf: [{ $ref: "#/$defs/A" }], oneOf: [{ const: { x: 1 } }, { const: { y: 2 } }] },
      },
    };
    const c = classify(schema);
    expect(c.root).toBe("buffer");
    const defs = schema.$defs as Record<string, SchemaOrBoolean>;
    expect(c.strategyOf(defs.A as SchemaOrBoolean)).toBe("buffer");
    expect(c.strategyOf(defs.B as SchemaOrBoolean)).toBe("buffer");
  });

  it("resolves root, JSON-pointer, and anchor refs", () => {
    expect(classify({ $ref: "#", type: "object" }).root).toBe("stream");
    expect(classify({ $ref: "#/$defs/S", $defs: { S: { type: "string" } } }).root).toBe("stream");
    expect(
      classify({ $ref: "#named", $defs: { S: { $anchor: "named", type: "string" } } }).root,
    ).toBe("stream");
  });
});

describe("classify: compile-time fast-fail (REJECT)", () => {
  it("rejects unevaluatedProperties / unevaluatedItems", () => {
    expect(() => classify({ type: "object", unevaluatedProperties: false })).toThrow(
      ClassifierError,
    );
    expect(() => classify({ type: "array", unevaluatedItems: false })).toThrow(ClassifierError);
  });

  it("rejects an unknown keyword, naming it and the path", () => {
    try {
      classify({
        type: "object",
        properties: { a: { frobnicate: true } as unknown as SchemaOrBoolean },
      });
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClassifierError);
      expect((err as ClassifierError).keyword).toBe("frobnicate");
      expect((err as ClassifierError).path).toBe("properties.a");
    }
  });

  it("rejects an unresolvable $ref", () => {
    expect(() => classify({ $ref: "#/$defs/Missing" })).toThrow(ClassifierError);
    expect(() => classify({ $ref: "https://example.com/x" })).toThrow(ClassifierError);
  });

  it("ignores x- specification extensions", () => {
    expect(rootStrategy({ type: "string", "x-internal": true } as SchemaObject)).toBe("stream");
  });

  it("treats a registered custom keyword as a delegable buffer", () => {
    expect(rootStrategy({ myKeyword: 1 } as SchemaObject, { customKeywords: ["myKeyword"] })).toBe(
      "buffer",
    );
  });

  it("does not flag folded partner keywords (then/else, minContains/maxContains)", () => {
    // `then` / `else` are real JSON Schema keywords here; the
    // no-thenable lint guards against accidental thenables, not this.
    // oxlint-disable-next-line unicorn/no-thenable
    const ifThenElse = { if: { type: "string" }, then: { minLength: 1 }, else: { maxLength: 2 } };
    expect(rootStrategy(ifThenElse as SchemaObject)).toBe("tee");
    expect(
      rootStrategy({ type: "array", contains: { type: "string" }, minContains: 1, maxContains: 3 }),
    ).toBe("stream");
  });
});

describe("classify: unbounded warnings", () => {
  it("warns on pattern/format without maxLength", () => {
    const c = classify({ type: "string", pattern: "^a+$" });
    expect(c.warnings.some((w) => w.kind === "unbounded-string")).toBe(true);
    expect(classify({ type: "string", pattern: "^a$", maxLength: 4 }).warnings).toHaveLength(0);
  });

  it("warns on uniqueItems without maxItems", () => {
    const c = classify({ type: "array", uniqueItems: true });
    expect(c.warnings.some((w) => w.kind === "unbounded-unique-items")).toBe(true);
  });

  it("enforceBounds turns a warning into a thrown error", () => {
    expect(() => classify({ type: "string", format: "email" }, { enforceBounds: true })).toThrow(
      ClassifierError,
    );
  });
});

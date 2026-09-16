import { describe, expect, it } from "vitest";
import { compileSchema, openapi31Dialect } from "../src/index.js";

describe("composed finite values", () => {
  it("locates the sibling-properties conflict at the composition", () => {
    const schema = {
      type: "object" as const,
      allOf: [{ properties: { status: { enum: ["awaitingReview", "inProgress", "completed"] } } }],
      properties: { status: { enum: ["inProgress", "complete"] } },
    };
    const compiled = compileSchema(schema, { dialect: openapi31Dialect, pointer: "/schema" });
    expect(compiled.validate({ status: "inProgress" }).valid).toBe(true);
    expect(compiled.validate({ status: "complete" }).valid).toBe(false);
    expect(compiled.stats.schemaLintIssues).toEqual([
      expect.objectContaining({ code: "unsatisfiable/composed-enum-members", pointer: "/schema" }),
    ]);
  });
});

const CROSS = "unsatisfiable/composed-enum-members";
const EMPTY = "unsatisfiable/composed-enum-empty";
const crossing = [{ enum: ["A", "B"] }, { enum: ["B", "C"] }];
const propertyFrame = (constraints: unknown[]) => ({
  allOf: constraints.map((c) => ({ properties: { v: c } })),
});
const lint = (schema: unknown, dialect = openapi31Dialect) =>
  compileSchema(schema as never, { dialect, pointer: "/schema" }).stats.schemaLintIssues.filter(
    (i) => i.code.startsWith("unsatisfiable/composed-enum"),
  );

import { jsonSchemaDialect, oas30Dialect } from "../src/index.js";
import { collectComposedEnumIssues } from "../src/compiler/composed-enum.js";

const without = (name: string) => ({
  ...jsonSchemaDialect,
  vocabularies: jsonSchemaDialect.vocabularies.map((v) => ({
    ...v,
    keywords: v.keywords.filter((k) => k.keyword !== name),
  })),
});

describe("finite conjunction semantics", () => {
  it.each([
    [[{ enum: ["A", "B"] }, { enum: ["B", "A", "A"] }]],
    [[{ enum: ["A", "B", "C"] }, { const: "A" }]],
    [[...crossing, { const: "B" }]],
    [[{ allOf: crossing }, { const: "B" }]],
  ])("keeps equal sets and complete explicit narrowing silent: %j", (constraints) => {
    expect(lint(propertyFrame(constraints))).toEqual([]);
  });

  it("computes the total intersection, beyond pairwise overlap", () => {
    const issues = lint(propertyFrame([...crossing, { enum: ["A", "C"] }]));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe(EMPTY);
    expect(issues[0]?.contributors).toHaveLength(3);
    expect(issues[0]?.message).toContain("finite intersection: []");
  });

  it("compares object keys without order and arrays with order", () => {
    const issue = lint({
      allOf: [{ enum: [{ a: 1, b: 2 }, [1, 2]] }, { enum: [{ b: 2, a: 1 }, [2, 1]] }],
    })[0];
    expect(issue?.code).toBe(CROSS);
    expect(issue?.message).toContain('finite intersection: [{"a":1,"b":2}]');
    expect(lint({ allOf: [{ enum: [[1, 2]] }, { enum: [[2, 1]] }] })[0]?.code).toBe(EMPTY);
  });

  it.each([false, true])("limits an empty property claim with required=%s", (required) => {
    const schema = {
      ...propertyFrame([{ enum: ["A"] }, { const: "B" }]),
      ...(required ? { required: ["v"] } : {}),
    };
    const compiled = compileSchema(schema as never, { dialect: openapi31Dialect });
    expect(compiled.validate({}).valid).toBe(!required);
    expect(compiled.validate(42).valid).toBe(true);
    const issue = lint(schema)[0];
    expect(issue?.message).toContain('Property "v" cannot be present in an object');
    expect(issue?.message.includes("it is required")).toBe(required);
  });

  it("keeps alternatives and predicates separate", () => {
    for (const keyword of ["oneOf", "anyOf"])
      expect(lint({ [keyword]: crossing.map((c) => ({ properties: { v: c } })) })).toEqual([]);
    for (const keyword of ["not", "if", "then", "else"])
      expect(lint({ [keyword]: propertyFrame(crossing) })).toEqual([]);
    expect(
      lint({
        properties: { v: crossing[0] },
        dependentSchemas: { trigger: { properties: { v: crossing[1] } } },
      }),
    ).toEqual([]);
  });

  it("includes inherited assertions while inspecting an alternative", () => {
    expect(
      lint({ const: "B", oneOf: [{ allOf: crossing }, { const: "D" }] }).filter(
        (i) => i.code === CROSS,
      ),
    ).toEqual([]);
    const schema = {
      anyOf: [
        { type: "object", required: ["v"], ...propertyFrame([{ const: "A" }, { const: "B" }]) },
        { type: "null" },
      ],
    };
    expect(compileSchema(schema as never, { dialect: openapi31Dialect }).validate(null).valid).toBe(
      true,
    );
    expect(lint(schema)[0]?.pointer).toBe("/schema/anyOf/0");
  });

  it("does not apply additionalProperties to adjacent declared names", () => {
    expect(
      lint({ properties: { v: { enum: ["A", "B"] } }, additionalProperties: { enum: ["C"] } }),
    ).toEqual([]);
    const schema = { ...propertyFrame(crossing), additionalProperties: { const: "B" } };
    expect(lint(schema)).toEqual([]);
    expect(
      lint({
        properties: { v: { enum: ["A"] } },
        allOf: [{ additionalProperties: { const: "B" } }],
      })[0]?.code,
    ).toBe(EMPTY);
  });

  it("withholds crossing around patterns but retains sound empty evidence", () => {
    expect(
      lint({ ...propertyFrame(crossing), patternProperties: { "^v$": { const: "B" } } }),
    ).toEqual([]);
    expect(
      lint({
        ...propertyFrame([{ const: "A" }, { const: "B" }]),
        patternProperties: { "^v$": {} },
      })[0]?.code,
    ).toBe(EMPTY);
    expect(lint({ ...propertyFrame(crossing), unevaluatedProperties: { const: "B" } })).toEqual([]);
  });

  it("does not merge item indices, contains, or prefix and tail positions", () => {
    expect(lint({ prefixItems: [{ const: "A" }, { const: "B" }] })).toEqual([]);
    expect(lint({ items: { enum: ["A", "B"] }, contains: { const: "B" } })).toEqual([]);
    expect(lint({ prefixItems: [{ const: "A" }], items: { const: "B" } })).toEqual([]);
    expect(lint({ allOf: crossing.map((c) => ({ items: c })) })[0]?.code).toBe(CROSS);
    expect(
      lint({ allOf: [{ prefixItems: [{ const: "A" }] }, { items: { const: "B" } }] })[0]?.code,
    ).toBe(EMPTY);
  });

  it.each([openapi31Dialect, oas30Dialect])("honors registered const under %j", (dialect) => {
    expect(lint(propertyFrame([...crossing, { const: "B" }]), dialect)).toEqual([]);
    expect(lint(propertyFrame([{ const: "A" }, { const: "B" }]), dialect)[0]?.code).toBe(EMPTY);
  });

  it("honors an inactive const in a custom dialect", () => {
    expect(lint(propertyFrame([...crossing, { const: "B" }]), without("const"))[0]?.code).toBe(
      CROSS,
    );
    expect(lint(propertyFrame(crossing), without("enum"))).toEqual([]);
    expect(lint(propertyFrame(crossing), without("properties"))).toEqual([]);
  });

  it("honors OAS 3.0 ref sibling suppression", () => {
    const schema = {
      $defs: { A: crossing[0] },
      properties: { v: { $ref: "#/$defs/A", ...crossing[1] } },
    };
    expect(lint(schema, oas30Dialect)).toEqual([]);
    expect(lint(schema)[0]?.code).toBe(CROSS);
  });

  it("does not infer a finite intersection from composed type", () => {
    expect(lint({ allOf: [{ enum: ["A", "B"] }, { type: "integer" }] })).toEqual([]);
  });
});

describe("finite evidence positions and bounds", () => {
  it("addresses a property-level composition and its declarations", () => {
    const issue = lint({ properties: { "a/b~": { allOf: crossing } } })[0];
    expect(issue?.pointer).toBe("/schema/properties/a~1b~0");
    expect(issue?.schemaPath).toEqual(["properties", "a/b~"]);
    expect(issue?.contributors?.map((c) => c.pointer)).toEqual([
      "/schema/properties/a~1b~0/allOf/0/enum",
      "/schema/properties/a~1b~0/allOf/1/enum",
    ]);
  });

  it("keeps an actual ancestor address for nested joins", () => {
    const issue = lint({
      allOf: crossing.map((c) => ({ properties: { outer: { properties: { inner: c } } } })),
    })[0];
    expect(issue?.pointer).toBe("/schema");
    expect(issue?.message).toContain('["outer","inner"]');
    expect(issue?.contributors?.map((c) => c.pointer)).toEqual([
      "/schema/allOf/0/properties/outer/properties/inner/enum",
      "/schema/allOf/1/properties/outer/properties/inner/enum",
    ]);
  });

  it("retains distinct reference use sites", () => {
    const schema = {
      $defs: { Base: crossing[0] },
      properties: {
        a: { $ref: "#/$defs/Base", ...crossing[1] },
        b: { $ref: "#/$defs/Base", ...crossing[1] },
      },
    };
    expect(lint(schema).map((i) => i.pointer)).toEqual([
      "/schema/properties/a",
      "/schema/properties/b",
    ]);
  });

  it("keeps bare-schema contributor paths across refs without inventing addresses", () => {
    const schema = { $defs: { A: crossing[0] }, $ref: "#/$defs/A", ...crossing[1] };
    const issue = compileSchema(schema as never, {
      dialect: openapi31Dialect,
    }).stats.schemaLintIssues.find((i) => i.code === CROSS);
    expect(
      issue?.contributors?.some(
        (c) => c.pointer === undefined && c.schemaPath === undefined && c.path === "$defs.A.enum",
      ),
    ).toBe(true);
  });

  const direct = (schema: unknown, resolve?: (ref: string, from: object) => unknown) =>
    collectComposedEnumIssues(schema, { known: () => true, refSuppressesSiblings: false, resolve });
  it.each(["$ref", "$dynamicRef"])(
    "withholds crossing on unresolved %s while retaining empty subsets",
    (key) => {
      expect(direct({ allOf: [...crossing, { [key]: "missing" }] })).toEqual([]);
      expect(
        direct({ allOf: [{ const: "A" }, { const: "B" }, { [key]: "missing" }] })[0]?.code,
      ).toBe(EMPTY);
    },
  );

  it("bounds cyclic and depth-limited conjunctions conservatively", () => {
    const cyclic = { allOf: [...crossing, { $ref: "self" }] };
    expect(direct(cyclic, () => cyclic)).toEqual([]);
    let hidden: unknown = { const: "B" };
    for (let i = 0; i < 50; i++) hidden = { allOf: [hidden] };
    expect(direct({ allOf: [...crossing, hidden] })).toEqual([]);
    expect(direct({ allOf: [{ const: "A" }, { const: "B" }, hidden] })[0]?.code).toBe(EMPTY);
  });

  it("bounds wide work and large finite comparisons", () => {
    expect(
      direct({
        allOf: [...crossing, ...Array.from({ length: 21_000 }, () => ({})), { const: "B" }],
      }),
    ).toEqual([]);
    const values = Array.from({ length: 1000 }, (_, i) => i);
    expect(direct({ allOf: [{ enum: values }, { enum: [...values].reverse() }] })).toEqual([]);
  });

  it("withholds malformed finite contributions", () => {
    expect(direct({ allOf: [...crossing, { enum: "B" }] })).toEqual([]);
    expect(() => lint({ allOf: [...crossing, { enum: "B" }] })).toThrow(/enum/);
  });

  it.each(["flat", "tree", "predicate"] as const)(
    "preserves generated source and runtime output in %s mode",
    (output) => {
      const schema = propertyFrame(crossing);
      const on = compileSchema(schema as never, {
        dialect: openapi31Dialect,
        output,
        retainSource: true,
      });
      const off = compileSchema(schema as never, {
        dialect: openapi31Dialect,
        output,
        retainSource: true,
        schemaLint: "off",
      });
      expect(on.source).toBe(off.source);
      for (const value of [{ v: "A" }, { v: "B" }, { v: "C" }, {}])
        expect(on.validate(value)).toEqual(off.validate(value));
      expect(off.stats.schemaLintIssues).toEqual([]);
    },
  );
});

describe("fresh review regressions", () => {
  it("does not report inherited finite evidence again in alternative arms", () => {
    expect(lint({ allOf: [{ const: "A" }, { const: "B" }], anyOf: [{}, {}] })).toHaveLength(1);
    expect(lint({ allOf: crossing, anyOf: [{}, {}] })).toEqual([]);
  });
  it("withholds crossing with another unresolved alternative group", () => {
    expect(
      lint({ allOf: [{ anyOf: [{ const: "B" }] }, { anyOf: [{ allOf: crossing }] }] }),
    ).toEqual([]);
  });
  it("does not diagnose authored values changed by runtime literal serialization", () => {
    const schema = JSON.parse(
      '{"allOf":[{"enum":[{"__proto__":"A"}]},{"enum":[{"__proto__":"B"}]}]}',
    );
    expect(compileSchema(schema, { dialect: openapi31Dialect }).validate({}).valid).toBe(true);
    expect(lint(schema)).toEqual([]);
  });
  it("budgets property joins as well as schema visits", () => {
    let calls = 0;
    const schema = {
      properties: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`p${i}`, {}])),
      allOf: Array.from({ length: 3000 }, () => ({ additionalProperties: {} })),
    };
    expect(
      collectComposedEnumIssues(schema, {
        known: () => {
          calls++;
          return true;
        },
        refSuppressesSiblings: false,
      }),
    ).toEqual([]);
    expect(calls).toBeLessThan(200_000);
  });
});

it("withholds a bare nested-resource fragment that cannot address the document", () => {
  const schema = {
    properties: {
      x: {
        $id: "https://example.test/child",
        $defs: { A: { enum: ["A", "B"] } },
        $ref: "#/$defs/A",
        enum: ["B", "C"],
      },
    },
  };
  const issue = compileSchema(schema as never, {
    dialect: openapi31Dialect,
    pointer: "",
  }).stats.schemaLintIssues.find((i) => i.code === CROSS);
  expect(issue?.pointer).toBe("/properties/x");
  expect(issue?.contributors?.[1]?.pointer).toBeUndefined();
  expect(issue?.contributors?.[1]?.path).toBe("$defs.A.enum");
});

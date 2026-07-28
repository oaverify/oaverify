/* eslint-disable unicorn/no-thenable -- `then` is a JSON Schema keyword here */
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema } from "../src/compiler/compiler.js";
import { jsonSchemaDialect, oas30Dialect, openapi31Dialect } from "../src/keywords/vocabulary.js";

describe("schema lint", () => {
  const lint = (schema: SchemaOrBoolean, mode?: "off" | "warn" | "strict") =>
    compileSchema(schema, { dialect: jsonSchemaDialect, schemaLint: mode }).stats.schemaLintIssues;

  // Schemas that use $dynamicRef need a $dynamicAnchor somewhere
  // reachable. A self-anchored root works for both test cases.
  const dynamicSchema = {
    $dynamicAnchor: "meta",
    properties: { next: { $dynamicRef: "#meta" } },
    minimumx: 5, // also a typo
  } as unknown as SchemaOrBoolean;

  it("defaults to warn: flags $dynamicRef but not unknown keywords", () => {
    const issues = compileSchema(dynamicSchema, { dialect: jsonSchemaDialect }).stats
      .schemaLintIssues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "partial-feature",
      keyword: "$dynamicRef",
    });
  });

  it('"off" produces no issues even for clear problems', () => {
    const issues = lint(dynamicSchema, "off");
    expect(issues).toEqual([]);
  });

  it('"strict" flags unknown keywords in addition to partial features', () => {
    const issues = lint({ minimumx: 5, minimum: 0 } as unknown as SchemaOrBoolean, "strict");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "unknown-keyword",
      keyword: "minimumx",
    });
    expect(issues[0]?.message).toContain("<root>");
  });

  it('"strict" tolerates x-* extensions', () => {
    const issues = lint(
      { "x-codeSamples": [{ lang: "ts", source: "" }], minimum: 0 } as unknown as SchemaOrBoolean,
      "strict",
    );
    expect(issues).toEqual([]);
  });

  it('"strict" tolerates the JSON Schema 2020-12 content vocabulary', () => {
    const issues = lint(
      {
        type: "string",
        contentEncoding: "base64",
        contentMediaType: "application/jwt",
        contentSchema: { type: "object" },
      } as unknown as SchemaOrBoolean,
      "strict",
    );
    expect(issues).toEqual([]);
  });

  it('"strict" tolerates `xml` and `externalDocs` under the OpenAPI dialects', () => {
    const schema = {
      type: "string",
      xml: { name: "Msg" },
      externalDocs: { url: "https://example.com/docs" },
    } as unknown as SchemaOrBoolean;
    // Base JSON Schema dialect does NOT recognize `xml` / `externalDocs`;
    // they're OpenAPI extensions, not core JSON Schema keywords.
    const baseIssues = compileSchema(schema, {
      dialect: jsonSchemaDialect,
      schemaLint: "strict",
    }).stats.schemaLintIssues;
    expect(baseIssues.map((i) => i.keyword).sort()).toEqual(["externalDocs", "xml"]);
    // Both OpenAPI dialects DO recognize them.
    for (const dialect of [openapi31Dialect, oas30Dialect]) {
      const issues = compileSchema(schema, { dialect, schemaLint: "strict" }).stats
        .schemaLintIssues;
      expect(issues).toEqual([]);
    }
  });

  it('"strict" tolerates the standard $-prefixed metadata keys', () => {
    const issues = lint(
      {
        $id: "https://example.com/s",
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $comment: "note",
        $defs: { x: { type: "string" } },
        title: "t",
      } as unknown as SchemaOrBoolean,
      "strict",
    );
    expect(issues).toEqual([]);
  });

  it("walks into nested subschema positions", () => {
    const issues = lint(
      {
        properties: {
          a: { type: "string", minLenght: 3 }, // typo
        },
      } as unknown as SchemaOrBoolean,
      "strict",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "unknown-keyword",
      keyword: "minLenght",
      path: "properties.a",
    });
  });

  it("tolerates `then` / `else` alongside `if` via implements", () => {
    const schema = {
      if: { type: "string" },
      then: { minLength: 1 },
      else: { type: "number" },
    } as unknown as SchemaOrBoolean;
    expect(lint(schema, "strict")).toEqual([]);
  });

  it("does not descend into `enum` / `const` / `default` values", () => {
    // Literal values happen to contain a key called `minimumx`; the
    // linter must not mistake them for schema objects.
    const issues = lint(
      {
        const: { minimumx: 5 },
        enum: [{ minimumx: 5 }, { nopenotaschema: true }],
      } as unknown as SchemaOrBoolean,
      "strict",
    );
    expect(issues).toEqual([]);
  });
});

describe("strict mode: silent-rewrite/ref-siblings-oas30", () => {
  // The compiler resolves $refs eagerly, so test fixtures need a real
  // target for each ref. A self-contained $defs/Pet works for every
  // dialect (the linter looks at the sibling shape, not the target).
  const withTarget = (overrides: Record<string, unknown>) =>
    ({
      $defs: { Pet: { type: "object", properties: { name: { type: "string" } } } },
      ...overrides,
    }) as unknown as SchemaOrBoolean;

  const oas30Lint = (schema: SchemaOrBoolean) =>
    compileSchema(schema, { dialect: oas30Dialect }).stats.schemaLintIssues;

  it("flags non-metadata siblings of $ref under OAS 3.0", () => {
    const schema = withTarget({
      properties: {
        wrapper: { $ref: "#/$defs/Pet", required: ["name"] },
      },
    });
    const issues = oas30Lint(schema);
    const sib = issues.filter((i) => i.code === "silent-rewrite/ref-siblings-oas30");
    expect(sib).toHaveLength(1);
    expect(sib[0]?.keyword).toBe("required");
  });

  it("tolerates `description` and `summary` siblings of $ref under OAS 3.0", () => {
    const schema = withTarget({
      properties: {
        wrapper: { $ref: "#/$defs/Pet", description: "A pet", summary: "Pet ref" },
      },
    });
    const issues = oas30Lint(schema).filter((i) => i.code === "silent-rewrite/ref-siblings-oas30");
    expect(issues).toEqual([]);
  });

  it("does NOT fire under JSON Schema 2020-12 / OpenAPI 3.1 (refs allow siblings)", () => {
    const schema = withTarget({
      properties: {
        wrapper: { $ref: "#/$defs/Pet", required: ["name"] },
      },
    });
    for (const dialect of [jsonSchemaDialect, openapi31Dialect]) {
      const issues = compileSchema(schema, { dialect }).stats.schemaLintIssues.filter(
        (i) => i.code === "silent-rewrite/ref-siblings-oas30",
      );
      expect(issues).toEqual([]);
    }
  });
});

describe("schema lint: required-not-in-properties (instance-position aware)", () => {
  const flagged = (schema: unknown) =>
    compileSchema(schema as SchemaOrBoolean, {
      dialect: jsonSchemaDialect,
    }).stats.schemaLintIssues.filter((i) => i.code === "silent-rewrite/required-not-in-properties");

  it("flags a name nothing reachable declares", () => {
    const issues = flagged({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["nam"],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('"nam"');
  });

  it("does not flag a branch whose property is declared on an ancestor", () => {
    // The false positive that made the old rule 2.6% signal: a oneOf
    // branch validates the SAME instance, so requestedAmount is
    // reachable from the parent.
    expect(
      flagged({
        type: "object",
        properties: {
          requestedAmount: { type: "number" },
          requestedPercentage: { type: "number" },
        },
        oneOf: [{ required: ["requestedAmount"] }, { required: ["requestedPercentage"] }],
      }),
    ).toEqual([]);
  });

  it("never flags under a not ancestor", () => {
    // `required` under `not` is a negative constraint; the name need
    // never be declared anywhere.
    expect(
      flagged({
        type: "object",
        properties: { a: { type: "string" } },
        not: { required: ["nowhere"] },
      }),
    ).toEqual([]);
  });

  it("catches the unsatisfiable case the old guard suppressed", () => {
    // The false negative: the old rule skipped any schema that composed,
    // which is exactly where these live. `cusip` exists one level down
    // under `notification`, so the top-level required can never be met.
    const issues = flagged({
      type: "object",
      properties: {
        eventType: { type: "string" },
        notification: { type: "object", properties: { cusip: { type: "string" } } },
      },
      allOf: [{ required: ["eventType", "cusip"] }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('"cusip"');
  });

  it("stays silent when any contributor can supply unknown names", () => {
    for (const extra of [
      { additionalProperties: true },
      { additionalProperties: { type: "string" } },
      { patternProperties: { "^x-": { type: "string" } } },
    ]) {
      expect(
        flagged({ type: "object", properties: {}, required: ["anything"], ...extra }),
        JSON.stringify(extra),
      ).toEqual([]);
    }
  });

  it("resolves $ref contributors", () => {
    expect(
      flagged({
        $defs: { Named: { type: "object", properties: { name: { type: "string" } } } },
        allOf: [{ $ref: "#/$defs/Named" }],
        required: ["name"],
      }),
    ).toEqual([]);
  });

  it("resets the chain at a child instance", () => {
    // `items` validates a different instance, so the parent's
    // properties are not reachable inside it.
    const issues = flagged({
      type: "object",
      properties: { outer: { type: "string" } },
      items: { type: "object", properties: {}, required: ["outer"] },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toContain("items");
  });

  it("sees a sibling that constrains the same child instance", () => {
    // The names are declared by `properties.id`, and the `required`
    // sits under `allOf[0].then.properties.id`. Both constrain the same
    // child instance, so tracking only the walk's own ancestors would
    // flag this: the declaration is on the other side of the
    // composition.
    expect(
      flagged({
        type: "object",
        allOf: [
          { if: { properties: { kind: {} } }, then: { properties: { id: { required: ["ssn"] } } } },
        ],
        properties: {
          kind: { type: "string" },
          id: { type: "object", properties: { ssn: { type: "string" } } },
        },
      }),
    ).toEqual([]);
  });

  it("reaches a component behind a nested $ref", () => {
    // Only a body schema's root `$ref` is unwrapped before compilation,
    // so a rule that does not follow refs never visits this `required`
    // at all. It is unsatisfiable: `Item` declares no `total`.
    const issues = flagged({
      type: "array",
      items: { $ref: "#/$defs/Item" },
      $defs: {
        Item: { type: "object", properties: { id: { type: "string" } }, required: ["id", "total"] },
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('"total"');
  });

  it("does not flag a definition whose only use site supplies the name", () => {
    // `Summary` requires `flag`, which its sibling in the composition
    // declares. Reached through the ref, the instance can carry it.
    expect(
      flagged({
        $defs: { Summary: { type: "object", properties: {}, required: ["flag"] } },
        allOf: [{ $ref: "#/$defs/Summary" }],
        properties: { flag: { type: "boolean" } },
      }),
    ).toEqual([]);
  });

  it("treats dependentSchemas as constraining the same instance", () => {
    expect(
      flagged({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        dependentSchemas: { a: { required: ["b"] } },
      }),
    ).toEqual([]);
  });

  it("terminates on a self-referential schema", () => {
    expect(
      flagged({
        $defs: {
          Node: {
            type: "object",
            properties: { child: { $ref: "#/$defs/Node" } },
            required: ["child"],
          },
        },
        allOf: [{ $ref: "#/$defs/Node" }],
      }),
    ).toEqual([]);
  });

  it("visits a component once per instance position, not once per path", () => {
    // A diamond `$ref` graph: every level references the next twice. The
    // walk used to dedupe against the current path, so each level
    // doubled the work and 22 levels took ten seconds (#511). The
    // property under test is termination in reasonable time; the bound
    // is loose enough not to be a benchmark, and the old behaviour is
    // orders of magnitude outside it.
    const N = 24;
    const $defs: Record<string, unknown> = {};
    for (let i = 0; i < N; i += 1) {
      $defs[`S${i}`] = {
        anyOf: [{ $ref: `#/$defs/S${i + 1}` }, { $ref: `#/$defs/S${i + 1}` }],
      };
    }
    $defs[`S${N}`] = { type: "object", properties: { a: { type: "string" } } };

    const started = performance.now();
    expect(flagged({ $defs, allOf: [{ $ref: "#/$defs/S0" }] })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("stays linear when the duplication is under properties", () => {
    const N = 24;
    const $defs: Record<string, unknown> = {};
    for (let i = 0; i < N; i += 1) {
      $defs[`S${i}`] = {
        type: "object",
        properties: { a: { $ref: `#/$defs/S${i + 1}` }, b: { $ref: `#/$defs/S${i + 1}` } },
      };
    }
    $defs[`S${N}`] = { type: "object", properties: { a: { type: "string" } } };

    const started = performance.now();
    expect(flagged({ $defs, allOf: [{ $ref: "#/$defs/S0" }] })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("still judges one component separately at each instance position", () => {
    // The dedupe key is (node, schemas constraining the instance), not
    // the node alone. `Needs` requires `x`; at `ok` a sibling declares
    // it and at `bad` nothing does, so skipping the second visit would
    // lose a real finding.
    const issues = flagged({
      type: "object",
      properties: {
        ok: {
          type: "object",
          allOf: [{ $ref: "#/$defs/Needs" }],
          properties: { x: { type: "string" } },
        },
        bad: { type: "object", allOf: [{ $ref: "#/$defs/Needs" }] },
      },
      $defs: { Needs: { required: ["x"] } },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toContain("bad");
  });
});

describe("strict mode: silent-rewrite/redundant-composition-branches", () => {
  const lint = (schema: SchemaOrBoolean) =>
    compileSchema(schema, { dialect: jsonSchemaDialect }).stats.schemaLintIssues;

  it("flags literally identical oneOf branches", () => {
    const schema = {
      oneOf: [{ type: "string" }, { type: "string" }],
    } as unknown as SchemaOrBoolean;
    const issues = lint(schema).filter(
      (i) => i.code === "silent-rewrite/redundant-composition-branches",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("oneOf[1]");
  });

  it("flags branches that differ only in description / title (annotation-only)", () => {
    const schema = {
      anyOf: [
        { type: "string", description: "first" },
        { type: "string", title: "second" },
      ],
    } as unknown as SchemaOrBoolean;
    const issues = lint(schema).filter(
      (i) => i.code === "silent-rewrite/redundant-composition-branches",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.keyword).toBe("anyOf");
  });

  it("does not flag branches that genuinely differ", () => {
    const schema = {
      oneOf: [{ type: "string" }, { type: "number" }],
    } as unknown as SchemaOrBoolean;
    const issues = lint(schema).filter(
      (i) => i.code === "silent-rewrite/redundant-composition-branches",
    );
    expect(issues).toEqual([]);
  });

  it("emits one finding per duplicate group, not N for N copies", () => {
    const schema = {
      oneOf: [{ type: "string" }, { type: "string" }, { type: "string" }],
    } as unknown as SchemaOrBoolean;
    const issues = lint(schema).filter(
      (i) => i.code === "silent-rewrite/redundant-composition-branches",
    );
    // Each later branch flags once against the first; 3 copies → 2 findings.
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.path)).toEqual(["oneOf[1]", "oneOf[2]"]);
  });

  it("does not flag allOf duplicates (intersection, not branch collapse)", () => {
    const schema = {
      allOf: [{ type: "string" }, { type: "string" }],
    } as unknown as SchemaOrBoolean;
    const issues = lint(schema).filter(
      (i) => i.code === "silent-rewrite/redundant-composition-branches",
    );
    expect(issues).toEqual([]);
  });
});

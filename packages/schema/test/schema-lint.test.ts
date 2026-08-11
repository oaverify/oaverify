/* eslint-disable unicorn/no-thenable -- `then` is a JSON Schema keyword here */
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import type { SchemaLintIssue } from "../src/compiler/compiler.js";
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

  // $dynamicRef carried the only `partial` in the built-in dialect
  // while it resolved statically against the anchor map. It resolves
  // against the runtime dynamic scope now, so there are no degraded
  // semantics to report and warn mode has nothing to say here.
  it("defaults to warn: reports neither $dynamicRef nor unknown keywords", () => {
    const issues = compileSchema(dynamicSchema, { dialect: jsonSchemaDialect }).stats
      .schemaLintIssues;
    expect(issues).toEqual([]);
  });

  it("reports a partial feature when a dialect declares one", () => {
    const partialDialect = {
      ...jsonSchemaDialect,
      vocabularies: jsonSchemaDialect.vocabularies.map((vocab) => ({
        ...vocab,
        keywords: vocab.keywords.map((kw) =>
          kw.keyword === "$dynamicRef" ? { ...kw, partial: "only partly supported" } : kw,
        ),
      })),
    };
    const issues = compileSchema(dynamicSchema, { dialect: partialDialect }).stats.schemaLintIssues;
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

describe("schema lint: machine-readable position (#517)", () => {
  const lintAt = (schema: unknown, pointer?: string) =>
    compileSchema(schema as SchemaOrBoolean, {
      dialect: jsonSchemaDialect,
      schemaLint: "strict",
      ...(pointer === undefined ? {} : { pointer }),
    }).stats.schemaLintIssues;

  it("reports no pointer when the caller compiled a bare schema", () => {
    const [issue] = lintAt({ properties: { a: { nope: 1 } } });
    expect(issue?.code).toBe("unknown-keyword");
    expect(issue?.pointer).toBeUndefined();
    // schemaPath still works: it needs no document.
    expect(issue?.schemaPath).toEqual(["properties", "a"]);
  });

  it("reports a resolving pointer when the caller said where the schema sits", () => {
    const [issue] = lintAt(
      { properties: { a: { nope: 1 } } },
      "/paths/~1t/get/requestBody/content/application~1json/schema",
    );
    expect(issue?.pointer).toBe(
      "/paths/~1t/get/requestBody/content/application~1json/schema/properties/a",
    );
    expect(issue?.schemaPath).toEqual(["properties", "a"]);
  });

  it("keeps a key containing a dot addressable, which the dotted path cannot", () => {
    // `path` renders this as `properties.a.b.nope`, indistinguishable
    // from a nested `b`. The segments and the pointer are not
    // ambiguous.
    const [issue] = lintAt({ properties: { "a.b": { nope: 1 } } }, "");
    expect(issue?.schemaPath).toEqual(["properties", "a.b"]);
    expect(issue?.pointer).toBe("/properties/a.b");
  });

  it("reports no pointer for a lint issue inside a ref target of a bare schema", () => {
    // The absence contract has to hold through a `$ref` too: a caller
    // who named no document gets no document address, however local
    // the ref looks.
    const issues = lintAt({
      $defs: { T: { type: "object", properties: { name: {} }, required: ["nam"] } },
      $ref: "#/$defs/T",
    });
    const required = issues.filter((i) => i.code === "silent-rewrite/required-not-in-properties");
    expect(required).toHaveLength(1);
    expect(required[0]?.pointer).toBeUndefined();
    expect(issues.every((i) => i.pointer === undefined)).toBe(true);
  });

  it("addresses the duplicate branch, not the node holding the composition", () => {
    // The only rule that sets its own position; the stamping pass skips
    // it deliberately, so a wrong index here goes unnoticed.
    const [issue] = compileSchema(
      {
        properties: {
          a: { oneOf: [{ type: "string" }, { type: "number" }, { type: "string" }] },
        },
      } as unknown as SchemaOrBoolean,
      { dialect: jsonSchemaDialect, schemaLint: "strict", pointer: "" },
    ).stats.schemaLintIssues.filter(
      (i) => i.code === "silent-rewrite/redundant-composition-branches",
    );

    // Branch 2 duplicates branch 0, and it is branch 2 that is wrong.
    expect(issue?.pointer).toBe("/properties/a/oneOf/2");
    expect(issue?.schemaPath).toEqual(["properties", "a", "oneOf", 2]);
  });

  it("populates location alongside the deprecated context alias", () => {
    // Both names carry the same value for one major. Without this, the
    // alias could stop being written and the human output would quietly
    // lose its operation label with every gate still green.
    const [issue] = compileSchema(
      { properties: { a: { nope: 1 } } } as unknown as SchemaOrBoolean,
      {
        dialect: jsonSchemaDialect,
        schemaLint: "strict",
        label: "POST /things request body (application/json)",
      },
    ).stats.schemaLintIssues;

    expect(issue?.location).toBe("POST /things request body (application/json)");
  });

  it("re-roots the pointer at the ref target while path keeps naming the use site", () => {
    // The two addressing rules, both right, now both machine-readable.
    // `required` is checked at the instance position it applies to, so
    // `path` stays at the use site; the offending array is written in
    // the component, so `pointer` names that.
    const doc = {
      components: {
        schemas: {
          Target: { type: "object", properties: { name: { type: "string" } }, required: ["nam"] },
        },
      },
      $ref: "#/components/schemas/Target",
    };
    const issues = compileSchema(doc as unknown as SchemaOrBoolean, {
      dialect: jsonSchemaDialect,
      schemaLint: "strict",
      pointer: "/paths/~1t/post/requestBody/content/application~1json/schema",
    }).stats.schemaLintIssues.filter((i) => i.code === "silent-rewrite/required-not-in-properties");

    expect(issues).toHaveLength(1);
    expect(issues[0]?.pointer).toBe("/components/schemas/Target/required");
    // Not re-rooted, because that is not where the finding applies.
    expect(issues[0]?.path).toBe("");
    // No segment list spans a ref hop.
    expect(issues[0]?.schemaPath).toBeUndefined();
  });
});

describe("the two frames `path` renders in (#594)", () => {
  // `path` names where a reader has to go to act. Which frame that is
  // depends on the rule, and both halves are documented contract on
  // SchemaLintIssue.path, so both are pinned here: a rule that quietly
  // switched frames would otherwise change user-visible output, and the
  // CLI dedup key with it, under a green gate.
  const shared = {
    $defs: {
      Inner: { type: "object", required: ["nope"], properties: { yes: { type: "string" } } },
    },
    type: "object",
    properties: {
      // Declares `nope` alongside, so the required lint does not fire here.
      a: { allOf: [{ $ref: "#/$defs/Inner" }, { properties: { nope: { type: "string" } } }] },
      b: { allOf: [{ $ref: "#/$defs/Inner" }] },
    },
  };

  const lint = (schema: unknown, pointer?: string) =>
    compileSchema(schema as SchemaOrBoolean, {
      dialect: jsonSchemaDialect,
      schemaLint: "strict",
      ...(pointer === undefined ? {} : { pointer }),
    }).stats.schemaLintIssues;

  it("renders the use site for the required lint, which no other field names", () => {
    const [issue] = lint(shared, "").filter(
      (i) => i.code === "silent-rewrite/required-not-in-properties",
    );

    // The route that is broken. `properties.a` composes the missing
    // name in, so only `b` is reachable-and-wrong.
    expect(issue?.path).toBe("properties.b.allOf[0]");
    // The text to look at is shared, and correct for `a`.
    expect(issue?.pointer).toBe("/$defs/Inner/required");
    // Which says the finding is route-scoped, without saying which route.
    expect(issue?.anchor).toBe("scoped-definition");
  });

  it("renders the definition for every other rule, re-rooted at the ref", () => {
    const [issue] = lint(
      {
        $defs: { Inner: { type: "object", properties: { y: { exclusiveMinimumm: 3 } } } },
        properties: { a: { $ref: "#/$defs/Inner" } },
      },
      "",
    ).filter((i) => i.code === "unknown-keyword" && i.anchor === "definition");

    // The dotted document path of the target, not the `properties.a`
    // route that reached it.
    expect(issue?.path).toBe("$defs.Inner.properties.y");
    expect(issue?.pointer).toBe("/$defs/Inner/properties/y");
    // The hop ends the segment list; the render carries on past it.
    expect(issue?.schemaPath).toBeUndefined();
  });

  it('gives a self-contained caller a resolving pointer behind a ref for `pointer: ""`', () => {
    // The recipe documented on CompileOptions.pointer. Without it the
    // finding behind the hop has `path` and nothing else.
    const schema = {
      $defs: { Inner: { type: "object", properties: { y: { exclusiveMinimumm: 3 } } } },
      properties: { a: { $ref: "#/$defs/Inner" } },
    };

    const bare = lint(schema).filter((i) => i.schemaPath === undefined);
    expect(bare[0]?.pointer).toBeUndefined();

    const rooted = lint(schema, "").filter((i) => i.schemaPath === undefined);
    expect(rooted[0]?.pointer).toBe("/$defs/Inner/properties/y");
    expect(rooted[0]?.anchor).toBe("definition");
  });

  /**
   * Every code declares which frame it renders `path` in.
   *
   * The tests above pin the two frames against the rules that use them
   * today, so they catch an existing rule switching. They cannot catch
   * a *new* rule picking a frame silently, and `SchemaLintIssue.path`
   * states the frame as contract, so a rule that picks one without
   * saying makes the documentation wrong under a green gate.
   *
   * This map closes that. `Record` over the `code` union is exhaustive,
   * so adding a member fails `pnpm typecheck` here until its author has
   * decided which frame it reports in and said so on the field.
   *
   * It is a declaration, not a measurement: it records the intent the
   * TSDoc carries. The behaviour is pinned by the two tests above.
   */
  const FRAME: Record<SchemaLintIssue["code"], "definition" | "use-site"> = {
    "partial-feature": "definition",
    "unknown-keyword": "definition",
    "annotation-value-type": "definition",
    "silent-rewrite/ref-siblings-oas30": "definition",
    "silent-rewrite/redundant-composition-branches": "definition",
    "silent-rewrite/discriminator-unroutable": "definition",
    "silent-rewrite/pattern-not-unicode-mode": "definition",
    "unsatisfiable/pattern-length": "definition",
    "unsatisfiable/enum-member-type": "definition",
    // The one rule whose verdict depends on the route that reached the
    // text, so the definition can name a position where it does not
    // hold. Reports `anchor: "scoped-definition"`.
    "silent-rewrite/required-not-in-properties": "use-site",
  };

  it("declares a frame for every code, and only the required lint uses the use site", () => {
    expect(Object.entries(FRAME).filter(([, frame]) => frame === "use-site")).toEqual([
      ["silent-rewrite/required-not-in-properties", "use-site"],
    ]);
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

describe("silent-rewrite/pattern-not-unicode-mode", () => {
  const CODE = "silent-rewrite/pattern-not-unicode-mode";
  const lintFor = (schema: SchemaOrBoolean, regexCompiler?: (source: string) => RegExp) =>
    compileSchema(schema, {
      dialect: jsonSchemaDialect,
      regexCompiler,
    }).stats.schemaLintIssues.filter((i) => i.code === CODE);

  it("flags a pattern that only compiles without the u flag", () => {
    // `\_` is an Annex B identity escape: fine flagless, a SyntaxError
    // under "u". The runtime falls back, which is what this reports.
    const issues = lintFor({ type: "string", pattern: "\\_" } as unknown as SchemaOrBoolean);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.keyword).toBe("pattern");
    expect(issues[0]?.message).toContain('"u" flag');
  });

  it("flags a patternProperties key the same way", () => {
    const schema = {
      type: "object",
      patternProperties: { "a{,2}": { type: "string" } },
    } as unknown as SchemaOrBoolean;
    const issues = lintFor(schema);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.keyword).toBe("patternProperties");
    expect(issues[0]?.message).toContain('"a{,2}"');
  });

  it("stays silent for a pattern that compiles under u", () => {
    expect(lintFor({ type: "string", pattern: "^[a-z]+$" } as unknown as SchemaOrBoolean)).toEqual(
      [],
    );
  });

  it("stays out of the way of a pattern invalid under both modes", () => {
    // Not a rewrite: the compile throws (with the more informative
    // u-mode error), so there is no finding for this rule to make.
    expect(() => lintFor({ type: "string", pattern: "(" } as unknown as SchemaOrBoolean)).toThrow(
      SyntaxError,
    );
  });

  it("is suppressed when a custom regexCompiler is supplied", () => {
    // The custom compiler replaces the u-mode-with-fallback path
    // entirely, so the fallback this rule reports can never fire.
    const issues = lintFor(
      { type: "string", pattern: "\\_" } as unknown as SchemaOrBoolean,
      (source) => new RegExp(source),
    );
    expect(issues).toEqual([]);
  });
});

// The lint walk follows `$ref` (#523) to reach component schemas an
// operation-scoped compile cannot see. Its resolver is not the one
// codegen uses: it is called without a base URI, so a relative ref under
// an `$id` is unresolvable to it and resolvable to the compiler. Lint is
// advisory, so a pointer it cannot follow costs coverage of that subtree.
// The compile still has to succeed (#536).
describe("a $ref the lint walk cannot follow", () => {
  // draft2020-12/refRemote.json, "base URI change". `folderInteger.json`
  // resolves against the nested `$id`, which the lint resolver drops.
  const baseUriChange = {
    $id: "http://localhost:1234/draft2020-12/",
    items: { $id: "baseUriChange/", items: { $ref: "folderInteger.json" } },
  } as unknown as SchemaOrBoolean;
  const external = new Map<string, SchemaOrBoolean>([
    [
      "http://localhost:1234/draft2020-12/baseUriChange/folderInteger.json",
      { type: "integer" } as unknown as SchemaOrBoolean,
    ],
  ]);

  it("does not fail the compile", () => {
    const compiled = compileSchema(baseUriChange, {
      dialect: jsonSchemaDialect,
      external,
      schemaLint: "warn",
    });
    expect(compiled.validate([[1]]).valid).toBe(true);
    expect(compiled.validate([["not an integer"]]).valid).toBe(false);
  });

  it("reaches the same verdict whether or not lint runs", () => {
    const compileWith = (schemaLint: "off" | "warn" | "strict") =>
      compileSchema(baseUriChange, { dialect: jsonSchemaDialect, external, schemaLint });
    const off = compileWith("off");
    for (const mode of ["warn", "strict"] as const) {
      const compiled = compileWith(mode);
      for (const data of [[[1]], [["x"]], [[true]]]) {
        expect(compiled.validate(data).valid).toBe(off.validate(data).valid);
      }
    }
  });

  it("still follows a ref it can resolve", () => {
    // Absolute target, so the lint resolver reaches it. The typo lives
    // only in the external document, which the structural walk never
    // visits: flagging it proves the ref was followed, not just tolerated.
    const schema = {
      $id: "http://localhost:1234/root.json",
      properties: { a: { $ref: "http://localhost:1234/target.json" } },
    } as unknown as SchemaOrBoolean;
    const issues = compileSchema(schema, {
      dialect: jsonSchemaDialect,
      external: new Map<string, SchemaOrBoolean>([
        ["http://localhost:1234/target.json", { minimumx: 5 } as unknown as SchemaOrBoolean],
      ]),
      schemaLint: "strict",
    }).stats.schemaLintIssues;
    expect(issues.map((i) => i.keyword)).toContain("minimumx");
  });
});

describe("annotation value types", () => {
  const lint = (schema: SchemaOrBoolean, mode?: "off" | "warn" | "strict") =>
    compileSchema(schema, { dialect: jsonSchemaDialect, schemaLint: mode }).stats.schemaLintIssues;

  it("flags a null description, the shape a YAML author writes by accident", () => {
    // `description:` with nothing after it parses to null, and the text
    // the author meant to write is simply gone. Nothing else in the
    // pipeline sees this: annotations emit no code, so the compiled
    // validator is byte-identical either way.
    const issues = lint({ type: "string", description: null } as unknown as SchemaOrBoolean);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "annotation-value-type",
      keyword: "description",
    });
    expect(issues[0]?.message).toContain("string");
    expect(issues[0]?.message).toContain("null");
  });

  it("does not block construction", () => {
    // The whole reason this is a lint issue rather than a well-formedness
    // error. A mistyped annotation cannot change what the validator
    // accepts, so refusing to build would harden the runtime path
    // against a defect the runtime cannot observe.
    const compiled = compileSchema(
      { type: "string", description: null } as unknown as SchemaOrBoolean,
      {
        dialect: jsonSchemaDialect,
      },
    );
    expect(compiled.validate("ok").valid).toBe(true);
    expect(compiled.validate(5).valid).toBe(false);
  });

  it("fires in warn as well as strict", () => {
    // A null description is never intentional, so it does not wait for
    // an opt-in the way an unknown keyword does.
    expect(lint({ description: null } as unknown as SchemaOrBoolean, "warn")).toHaveLength(1);
    expect(lint({ description: null } as unknown as SchemaOrBoolean, "strict")).toHaveLength(1);
    expect(lint({ description: null } as unknown as SchemaOrBoolean, "off")).toEqual([]);
  });

  it("checks the annotations whose type is part of their contract", () => {
    expect(lint({ title: null } as unknown as SchemaOrBoolean)[0]).toMatchObject({
      code: "annotation-value-type",
      keyword: "title",
    });
    expect(lint({ deprecated: "yes" } as unknown as SchemaOrBoolean)[0]).toMatchObject({
      code: "annotation-value-type",
      keyword: "deprecated",
    });
    expect(lint({ readOnly: 1 } as unknown as SchemaOrBoolean)[0]).toMatchObject({
      code: "annotation-value-type",
      keyword: "readOnly",
    });
  });

  it("flags an examples that is not an array", () => {
    // 2020-12 requires `examples` to hold an array. The shape that hits
    // this is a 3.0 Example Object map left unconverted in a document
    // upgraded to 3.1: inert, since nothing reading 2020-12 `examples`
    // sees those values, and invisible to the document meta-schema,
    // which stubs the Schema Object from 3.1 on (#555).
    const issues = lint({
      type: "string",
      examples: { standardCode: { value: "ABC" } },
    } as unknown as SchemaOrBoolean);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "annotation-value-type", keyword: "examples" });
    expect(issues[0]?.message).toContain("should be an array");
    expect(issues[0]?.message).toContain("got object");
  });

  it("accepts an examples array whatever its members are", () => {
    // Only the keyword's own type is constrained; the members are
    // arbitrary values by definition.
    expect(
      lint({ type: "string", examples: ["a", 1, null, { any: "thing" }] } as SchemaOrBoolean),
    ).toEqual([]);
  });

  it("leaves example and default alone, where any value is legal", () => {
    expect(lint({ example: null, default: null } as unknown as SchemaOrBoolean)).toEqual([]);
  });

  it("reads the article correctly for vowel-initial types", () => {
    // Generated output is read by people; the template said "a object"
    // until the array arm made the seam obvious.
    // `xml` is OpenAPI-vocabulary, so it needs that dialect to be a
    // known annotation at all.
    const objectTyped = compileSchema({ xml: "name" } as unknown as SchemaOrBoolean, {
      dialect: openapi31Dialect,
    }).stats.schemaLintIssues;
    expect(objectTyped[0]?.message).toContain("should be an object");
    expect(lint({ title: null } as unknown as SchemaOrBoolean)[0]?.message).toContain(
      "should be a string",
    );
  });

  it("checks object-typed annotations by type, not by shape", () => {
    // `xml` and `externalDocs` are `type: object` in the OpenAPI spec,
    // so a string there is the wrong type and is reported. Whether
    // `xml.name` is a legal XML name is the document meta-schema's job:
    // duplicating a fragment of it here would be a second source of
    // truth for OpenAPI's own rules.
    const bad = compileSchema(
      { type: "string", xml: "elementName" } as unknown as SchemaOrBoolean,
      { dialect: openapi31Dialect },
    ).stats.schemaLintIssues;
    expect(bad[0]).toMatchObject({ code: "annotation-value-type", keyword: "xml" });

    const shapeNotChecked = compileSchema(
      { type: "string", xml: { notARealXmlField: true } } as unknown as SchemaOrBoolean,
      { dialect: openapi31Dialect },
    ).stats.schemaLintIssues;
    expect(shapeNotChecked).toEqual([]);
  });

  it("does not accept null or an array for an object-typed annotation", () => {
    // `typeof null === "object"` and `typeof [] === "object"`, so a bare
    // typeof check would pass both. Neither is a JSON object.
    for (const value of [null, []]) {
      const issues = compileSchema(
        { type: "string", externalDocs: value } as unknown as SchemaOrBoolean,
        { dialect: openapi31Dialect },
      ).stats.schemaLintIssues;
      expect(
        issues.map((i) => i.keyword),
        JSON.stringify(value),
      ).toContain("externalDocs");
      // And the message names the JSON type it actually got. A bare
      // typeof would say "object" for both, which tells the author
      // nothing about what they wrote.
      const issue = issues.find((i) => i.keyword === "externalDocs");
      expect(issue?.message, JSON.stringify(value)).toContain(
        Array.isArray(value) ? "array" : "null",
      );
    }
  });

  it("leaves annotations alone where any value is legal", () => {
    // Not an omission: `default`, `example` and `examples` carry
    // instance values, so null is a legitimate thing to write there.
    // Flagging them would be a false positive on correct schemas.
    expect(lint({ type: "string", default: null } as unknown as SchemaOrBoolean)).toEqual([]);
    expect(lint({ type: "string", example: null } as unknown as SchemaOrBoolean)).toEqual([]);
    expect(lint({ type: "string", examples: [null] } as unknown as SchemaOrBoolean)).toEqual([]);
  });

  it("says nothing about correctly-typed annotations", () => {
    const issues = lint({
      type: "string",
      title: "A name",
      description: "The name of the thing",
      deprecated: false,
      readOnly: true,
    } as unknown as SchemaOrBoolean);
    expect(issues).toEqual([]);
  });

  it("finds them inside a nested schema, not just at the root", () => {
    const issues = lint({
      type: "object",
      properties: { statusDate: { type: "string", description: null } },
    } as unknown as SchemaOrBoolean);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toContain("statusDate");
  });

  it("applies under the OpenAPI dialects too", () => {
    for (const dialect of [openapi31Dialect, oas30Dialect]) {
      const issues = compileSchema(
        { type: "string", description: null } as unknown as SchemaOrBoolean,
        {
          dialect,
        },
      ).stats.schemaLintIssues;
      expect(issues.map((i) => i.code)).toContain("annotation-value-type");
    }
  });
});

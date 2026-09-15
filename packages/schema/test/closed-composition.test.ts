/* eslint-disable unicorn/no-thenable -- `then` is a JSON Schema keyword here */
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import type { SchemaLintIssue } from "../src/compiler/compiler.js";
import { compileSchema } from "../src/compiler/compiler.js";
import { oas30Dialect, openapi31Dialect } from "../src/keywords/vocabulary.js";

/**
 * `unsatisfiable/composed-properties`, against the coverage table the
 * engagement agreed. Row numbers are the table's, so a case can be
 * traced back to the decision that put it there.
 */
describe("unsatisfiable/composed-properties", () => {
  const CODE = "unsatisfiable/composed-properties";

  const lintWith = (
    dialect: typeof openapi31Dialect,
    schema: SchemaOrBoolean,
    mode?: "off" | "warn" | "strict",
  ): SchemaLintIssue[] =>
    compileSchema(schema, { dialect, schemaLint: mode }).stats.schemaLintIssues.filter(
      (issue) => issue.code === CODE,
    );
  const lint31 = (schema: SchemaOrBoolean, mode?: "off" | "warn" | "strict") =>
    lintWith(openapi31Dialect, schema, mode);
  const lint30 = (schema: SchemaOrBoolean, mode?: "off" | "warn" | "strict") =>
    lintWith(oas30Dialect, schema, mode);

  const Pet = {
    type: "object",
    properties: { name: { type: "string" }, petType: { type: "string" } },
    required: ["name", "petType"],
  };

  describe("the close on the node the composition hangs off", () => {
    it("row 1: allOf with no adjacent declarations", () => {
      const issues = lint31({
        $defs: { Pet },
        allOf: [{ $ref: "#/$defs/Pet" }],
        additionalProperties: false,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.keyword).toBe("additionalProperties");
      expect(issues[0]?.message).toContain('"name"');
      expect(issues[0]?.message).toContain('"petType"');
    });

    it("row 2: $ref plus an adjacent close", () => {
      expect(
        lint31({ $defs: { Pet }, $ref: "#/$defs/Pet", additionalProperties: false }),
      ).toHaveLength(1);
    });

    it("row 3: oneOf plus an adjacent close", () => {
      expect(
        lint31({ $defs: { Pet }, oneOf: [{ $ref: "#/$defs/Pet" }], additionalProperties: false }),
      ).toHaveLength(1);
    });

    it("row 4: anyOf of $ref branches beside a discriminator", () => {
      const issues = lint31({
        $defs: { Pet },
        anyOf: [{ $ref: "#/$defs/Pet" }, { properties: { other: {} } }],
        discriminator: { propertyName: "petType" },
        additionalProperties: false,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain('"other"');
    });

    it("row 10: a close with no composition at all is silent", () => {
      expect(
        lint31({ type: "object", properties: { a: {} }, additionalProperties: false }),
      ).toEqual([]);
    });

    it("row 7: unevaluatedProperties in the same shape is silent", () => {
      expect(
        lint31({ $defs: { Pet }, allOf: [{ $ref: "#/$defs/Pet" }], unevaluatedProperties: false }),
      ).toEqual([]);
    });

    it("row 9: a composition declaring no properties is silent", () => {
      expect(
        lint31({ allOf: [{ type: "object" }, { maxProperties: 0 }], additionalProperties: false }),
      ).toEqual([]);
    });

    /**
     * Row 11's stated case, a composition reachable only through an
     * unresolvable `$ref`, cannot be built through `compileSchema`: the
     * compiler rejects such a document before any verdict is readable.
     * What is reachable is the other half of the same guard, the depth
     * bound, so that is what is pinned here.
     */
    it("row 11: a composition deeper than the walk's bound suppresses", () => {
      let chain: Record<string, unknown> = { properties: { deep: {} } };
      for (let i = 0; i < 30; i += 1) chain = { allOf: [chain] };
      expect(lint31({ ...chain, additionalProperties: false })).toEqual([]);
    });

    it("row 12: properties reachable only through `not` are not declarations", () => {
      expect(lint31({ not: { properties: { secret: {} } }, additionalProperties: false })).toEqual(
        [],
      );
    });

    it("row 23: then without if is inert and declares nothing", () => {
      expect(lint31({ then: { properties: { a: {} } }, additionalProperties: false })).toEqual([]);
    });

    it("row 23: then beside an if does declare", () => {
      const issues = lint31({
        if: { type: "object" },
        then: { properties: { a: {} } },
        additionalProperties: false,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain('"a"');
    });

    it("row 17: schemaLint off reports nothing", () => {
      expect(
        lint31(
          { $defs: { Pet }, allOf: [{ $ref: "#/$defs/Pet" }], additionalProperties: false },
          "off",
        ),
      ).toEqual([]);
    });

    it("row 18: a self-referential composition terminates and invents nothing", () => {
      const issues = lint31({
        $defs: { Node: { allOf: [{ $ref: "#/$defs/Node" }] } },
        allOf: [{ $ref: "#/$defs/Node" }],
        additionalProperties: false,
      });
      expect(issues).toEqual([]);
    });
  });

  describe("clause 2 relaxed: adjacent properties that do not cover the composition", () => {
    /**
     * `guru-atlassian.com_jira-3.0.1`'s `CustomContextVariable`, which
     * the "no adjacent properties" form of this rule would have missed.
     * Its `user` arm requires `accountId`, which the close rejects, so
     * that arm admits no instance at all.
     */
    it("row 8: reports the names the adjacent declarations miss", () => {
      const issues = lint30({
        type: "object",
        additionalProperties: false,
        properties: { type: { type: "string" } },
        required: ["type"],
        oneOf: [
          { properties: { accountId: {}, type: {} }, required: ["accountId", "type"] },
          { properties: { id: {}, key: {}, type: {} }, required: ["type"] },
        ],
      });
      expect(issues).toHaveLength(1);
      const message = issues[0]?.message ?? "";
      expect(message).toContain('"accountId"');
      expect(message).toContain('"id"');
      expect(message).toContain('"key"');
      // The adjacent declaration covers this one, so it is not dead.
      expect(message).not.toContain('"type"');
    });

    it("row 8: adjacent declarations covering the composition are silent", () => {
      expect(
        lint31({
          properties: { a: {}, b: {} },
          additionalProperties: false,
          allOf: [{ properties: { a: {} } }, { properties: { b: {} } }],
        }),
      ).toEqual([]);
    });
  });

  describe("the close on an allOf branch", () => {
    it("row 5: a closed branch beside one declaring properties", () => {
      const issues = lint31({
        allOf: [{ additionalProperties: false }, { properties: { name: {} } }],
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("allOf[0]");
      expect(issues[0]?.message).toContain('"name"');
    });

    it("row 6: properties two hops out through a $ref branch", () => {
      const issues = lint31({
        $defs: { Pet, Wrapper: { allOf: [{ $ref: "#/$defs/Pet" }] } },
        allOf: [
          { additionalProperties: false, properties: { src: {} } },
          { $ref: "#/$defs/Wrapper" },
        ],
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("allOf[0]");
      expect(issues[0]?.message).toContain('"name"');
      // Its own adjacent declaration is not dead.
      expect(issues[0]?.message).not.toContain('"src"');
    });

    it("row 22: an anyOf sibling's arms are still declarations", () => {
      const issues = lint31({
        allOf: [
          { additionalProperties: false },
          { anyOf: [{ properties: { a: {} } }, { properties: { b: {} } }] },
        ],
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain('"a"');
      expect(issues[0]?.message).toContain('"b"');
    });

    it("a closed branch under oneOf is the union idiom, not a defect", () => {
      expect(
        lint31({
          oneOf: [{ additionalProperties: false }, { properties: { a: {} } }],
        }),
      ).toEqual([]);
    });

    it("the enclosing node's own properties count as declarations", () => {
      const issues = lint31({
        properties: { a: {} },
        allOf: [{ additionalProperties: false }],
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("allOf[0]");
      expect(issues[0]?.message).toContain('"a"');
    });

    it("reports a branch reachable from two enclosing nodes once", () => {
      // Nested inline `allOf` puts the close in reach of the root and of
      // the branch between them, and both see a declaration.
      const issues = lint31({
        allOf: [{ properties: { b: {} }, allOf: [{ additionalProperties: false }] }],
      });
      expect(issues.map((issue) => issue.path)).toEqual(["allOf[0].allOf[0]"]);
    });

    it("reports a branch once, not twice, when its own subtree also declares", () => {
      const issues = lint31({
        allOf: [
          { additionalProperties: false, oneOf: [{ properties: { own: {} } }] },
          { properties: { sibling: {} } },
        ],
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("allOf[0]");
      expect(issues[0]?.message).toContain('"own"');
      expect(issues[0]?.message).toContain('"sibling"');
    });
  });

  describe("composed patternProperties", () => {
    it("row 20: reported with no adjacent declarations, without naming a witness", () => {
      const issues = lint31({
        allOf: [{ patternProperties: { "^x-": { type: "string" } } }],
        additionalProperties: false,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).toContain('composed "patternProperties" can match');
    });

    it("row 21: suppressed where the close declares names of its own", () => {
      expect(
        lint31({
          properties: { a: {} },
          allOf: [{ patternProperties: { "^a$": {} } }],
          additionalProperties: false,
        }),
      ).toEqual([]);
    });

    it("an adjacent patternProperties beside the close suppresses", () => {
      expect(
        lint31({
          $defs: { Pet },
          allOf: [{ $ref: "#/$defs/Pet" }],
          patternProperties: { "^.*$": {} },
          additionalProperties: false,
        }),
      ).toEqual([]);
    });
  });

  describe("OAS 3.0", () => {
    it("row 13: reports the allOf form and never names unevaluatedProperties", () => {
      const issues = lint30({
        $defs: { Pet },
        allOf: [{ $ref: "#/$defs/Pet" }],
        additionalProperties: false,
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.message).not.toContain("unevaluated");
      expect(issues[0]?.message).not.toContain("Unevaluated");
      expect(issues[0]?.message).toContain("OAS 3.0 cannot close a composed object");
    });

    // The closing node sits under `properties` rather than at the root:
    // under 3.0 a root that is a `$ref` has no addressable members, so
    // `$defs` beside one is unreachable and the compile fails first.
    it("row 14: a $ref sibling close is discarded, so this rule stays out of it", () => {
      expect(
        lint30({
          $defs: { Pet },
          properties: { pet: { $ref: "#/$defs/Pet", additionalProperties: false } },
        }),
      ).toEqual([]);
    });

    it("row 15: $ref plus allOf plus a close, siblings discarded", () => {
      expect(
        lint30({
          $defs: { Pet },
          properties: {
            pet: {
              $ref: "#/$defs/Pet",
              allOf: [{ properties: { a: {} } }],
              additionalProperties: false,
            },
          },
        }),
      ).toEqual([]);
    });

    it("row 16: the closed-branch form, which 3.0 documents carry most of", () => {
      const issues = lint30({
        $defs: { Pet },
        allOf: [{ $ref: "#/$defs/Pet" }, { type: "object", additionalProperties: false }],
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("allOf[1]");
      expect(issues[0]?.message).not.toContain("unevaluated");
    });

    it("3.1 names the keyword, and says to move it up from a branch", () => {
      const onNode = lint31({
        $defs: { Pet },
        allOf: [{ $ref: "#/$defs/Pet" }],
        additionalProperties: false,
      });
      expect(onNode[0]?.message).toContain('Use "unevaluatedProperties": false here instead.');
      const onBranch = lint31({
        allOf: [{ additionalProperties: false }, { properties: { name: {} } }],
      });
      expect(onBranch[0]?.message).toContain("enclosing composition");
    });
  });

  describe("row 19: addressing", () => {
    it("addresses the node holding the close, in the definition frame", () => {
      const issues = compileSchema(
        {
          $defs: { Pet, Closed: { allOf: [{ $ref: "#/$defs/Pet" }], additionalProperties: false } },
          properties: { pet: { $ref: "#/$defs/Closed" } },
        },
        { dialect: openapi31Dialect, pointer: "" },
      ).stats.schemaLintIssues.filter(
        (issue) => issue.code === CODE && issue.anchor === "definition",
      );
      expect(issues).toHaveLength(1);
      // Re-rooted at the definition: the text to edit is the component,
      // once, however many use sites reach it.
      expect(issues[0]?.pointer).toBe("/$defs/Closed");
      expect(issues[0]?.anchor).toBe("definition");
      expect(issues[0]?.path).toBe("$defs.Closed");
    });

    it("addresses the branch, not the enclosing node, for the branch form", () => {
      const issues = compileSchema(
        { allOf: [{ additionalProperties: false }, { properties: { name: {} } }] },
        { dialect: openapi31Dialect, pointer: "" },
      ).stats.schemaLintIssues.filter((issue) => issue.code === CODE);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.pointer).toBe("/allOf/0");
      expect(issues[0]?.schemaPath).toEqual(["allOf", 0]);
      expect(issues[0]?.anchor).toBe("node");
    });
  });
});

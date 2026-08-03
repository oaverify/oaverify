import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema } from "../src/compiler/compiler.js";
import { jsonSchemaDialect, oas30Dialect, openapi31Dialect } from "../src/keywords/vocabulary.js";

/**
 * `unsatisfiable/enum-member-type` (#514): an `enum` member the sibling
 * `type` can never admit.
 *
 * The rule's value is that a finding is provable, so most of what
 * follows is about where it stays silent.
 */

type Dialect = typeof jsonSchemaDialect;

const lint = (schema: unknown, dialect: Dialect = jsonSchemaDialect) =>
  compileSchema(schema as SchemaOrBoolean, {
    dialect,
    schemaLint: "strict",
  }).stats.schemaLintIssues.filter((i) => i.code === "unsatisfiable/enum-member-type");

describe("enum members the sibling type cannot admit", () => {
  it("reports every member of an enum that contradicts the type", () => {
    const [issue] = lint({ type: "string", enum: [1, 2, 3] });

    expect(issue?.keyword).toBe("enum");
    expect(issue?.message).toContain('"type": string can never admit');
    expect(issue?.message).toContain("[0] 1, [1] 2, [2] 3");
    // The position is dead as well as the members, and says so.
    expect(issue?.message).toContain("every member is dead");
  });

  it("reports only the dead member when the enum is partly usable", () => {
    // The position still validates `"a"`, so the finding is about the
    // member. Reporting the whole enum here would be the over-report.
    const [issue] = lint({ type: "string", enum: ["a", 2] });

    expect(issue?.message).toContain("a member");
    expect(issue?.message).toContain("[1] 2");
    expect(issue?.message).toContain("can never be selected");
    expect(issue?.message).not.toContain("every member is dead");
  });

  it("accepts a member matching any branch of a union type", () => {
    expect(lint({ type: ["string", "integer"], enum: ["a", 2] })).toEqual([]);
  });

  it("treats a whole-number float as an integer, as JSON Schema does", () => {
    expect(lint({ type: "integer", enum: [1, 2.0] })).toEqual([]);
    expect(lint({ type: "integer", enum: [1.5] })).toHaveLength(1);
  });

  it("distinguishes null, array and object members", () => {
    expect(lint({ type: "object", enum: [null, [], {}] })[0]?.message).toContain(
      "[0] null, [1] []",
    );
    expect(lint({ type: "null", enum: [null] })).toEqual([]);
  });

  it("names the position, and <root> at the top", () => {
    expect(lint({ type: "string", enum: [1] })[0]?.message).toContain("at <root>");
    expect(lint({ properties: { status: { type: "string", enum: [1] } } })[0]?.message).toContain(
      'at "properties.status"',
    );
  });
});

describe("where it stays silent rather than widening", () => {
  it("says nothing without a type", () => {
    expect(lint({ enum: [1, "a", null] })).toEqual([]);
  });

  it("never sees a type name outside JSON Schema's seven", () => {
    // Well-formedness rejects those before any lint runs, so the guard
    // in `declaredTypes` is for a direct caller rather than for this
    // path. Pinned because it is the reason the guard looks unreachable.
    expect(() => lint({ type: "text", enum: [1] })).toThrow(/unknown type name "text"/);
    expect(() => lint({ type: ["string", "text"], enum: [1] })).toThrow(/unknown type name/);
  });

  it("says nothing for an empty or absent enum", () => {
    expect(lint({ type: "string", enum: [] })).toEqual([]);
    expect(lint({ type: "string" })).toEqual([]);
  });

  it("says nothing when every member fits", () => {
    expect(lint({ type: "string", enum: ["a", "b"] })).toEqual([]);
  });
});

describe("nullable, which is a keyword in OAS 3.0 and not in 3.1", () => {
  const schema = { type: "string", nullable: true, enum: ["a", null] };

  it("accepts a null member beside nullable: true under OAS 3.0", () => {
    // Valid OAS 3.0. Redocly's equivalent rule reports it anyway, and
    // inheriting that false positive is the thing to avoid.
    expect(lint(schema, oas30Dialect)).toEqual([]);
  });

  it("reports the same schema under 3.1, where nullable does nothing", () => {
    // Not an inconsistency: under 3.1 the key is an unrecognised
    // extension, so `null` really cannot be selected.
    const [issue] = lint(schema, openapi31Dialect);
    expect(issue?.message).toContain("[1] null");
  });

  it("still reports a member that nullable does not rescue, under 3.0", () => {
    expect(lint({ type: "string", nullable: true, enum: [1] }, oas30Dialect)).toHaveLength(1);
  });
});

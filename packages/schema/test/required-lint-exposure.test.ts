/**
 * The compiler's resolver is the required lint's only route through a `$ref`.
 * A reference it refuses counts as "cannot enumerate", so the lint stays quiet
 * rather than reading an inherited member or an undecoded key as the target.
 */
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema } from "../src/compiler/compiler.js";
import { collectRequiredIssues } from "../src/compiler/required-lint.js";
import { jsonSchemaDialect } from "../src/keywords/vocabulary.js";

const REQUIRED = "silent-rewrite/required-not-in-properties";

const refused = (ref: string, defs: Record<string, unknown> = {}) => ({
  properties: { a: {} },
  required: ["x"],
  allOf: [{ $ref: ref }],
  $defs: defs,
});

describe("required lint: a reference the resolver refuses", () => {
  it.each([
    ["an inherited member", "#/__proto__", {}],
    ["a dangling pointer", "#/$defs/none", {}],
    ["a literal key spelled like the encoded pointer", "#/$defs/a%20b", { "a%20b": {} }],
    ["a member the resolver places out of scope", "#/$defs/T", { T: {} }],
  ])("stays quiet on %s", (_name, ref, defs) => {
    expect(collectRequiredIssues(refused(ref, defs), { resolve: () => undefined })).toEqual([]);
  });

  it("stays quiet when the resolver throws", () => {
    const resolve = () => {
      throw new Error("not found");
    };
    expect(collectRequiredIssues(refused("#/$defs/T", { T: {} }), { resolve })).toEqual([]);
  });
});

describe("required lint: public compile paths", () => {
  const issues = (schema: unknown) =>
    compileSchema(schema as SchemaOrBoolean, { dialect: jsonSchemaDialect, schemaLint: "strict" })
      .stats.schemaLintIssues.filter((i) => i.code === REQUIRED)
      .map(({ code, path }) => ({ code, path }));
  const codes = (schema: unknown): string[] => issues(schema).map((i) => i.code);

  it("follows a percent-encoded pointer to the member it names", () => {
    expect(codes(refused("#/$defs/a%20b", { "a b": { properties: { x: {} } } }))).toEqual([]);
    expect(codes(refused("#/$defs/a%20b", { "a b": { properties: { b: {} } } }))).toEqual([
      REQUIRED,
    ]);
  });

  // `then` or `else` with no `if` is never compiled, so it declares no name
  // for the instance and its references, resolved or not, do not hide a
  // finding on the live node beside it.
  describe.each(["then", "else"])("a %s with no if", (branch) => {
    const withBranch = (body: string, extra = "") =>
      JSON.parse(`{"properties":{"a":{}},"required":["x"],"${branch}":${body}${extra}}`);

    it.each(["#/__proto__", "#/$defs/none", "#/properties/a"])(
      "reports the live node beside a reference to %s",
      (ref) => {
        expect(codes(withBranch(`{"$ref":"${ref}"}`))).toEqual([REQUIRED]);
      },
    );

    it("reports the live node when the branch declares the name inline", () => {
      expect(codes(withBranch(`{"properties":{"x":{}}}`))).toEqual([REQUIRED]);
    });

    it("stays quiet when an if makes the branch apply", () => {
      expect(codes(withBranch(`{"properties":{"x":{}}}`, `,"if":{}`))).toEqual([]);
    });

    it("lets a required inside the branch see the branch's own names", () => {
      expect(codes(JSON.parse(`{"${branch}":{"properties":{"b":{}},"required":["b"]}}`))).toEqual(
        [],
      );
    });

    it("does not read the branch's refused target for findings of its own", () => {
      const schema = withBranch(
        `{"$ref":"#/$defs/a%20b"}`,
        `,"$defs":{"a%20b":{"required":["zz"]}}`,
      );
      expect(issues(schema)).toEqual([{ code: REQUIRED, path: "" }]);
    });
  });

  // Inside a branch that cannot apply, every other branch counts, so a dead
  // subtree reports what it would if each branch applied.
  it.each([
    ["a sibling dead branch", `{"then":{"required":["x"]},"else":{"properties":{"x":{}}}}`],
    ["a nested dead branch", `{"then":{"required":["x"],"then":{"properties":{"x":{}}}}}`],
    [
      "a dead branch under another dependentSchemas entry",
      `{"dependentSchemas":{"a":{"then":{"required":["x"]}},"b":{"else":{"properties":{"x":{}}}}}}`,
    ],
  ])("lets a dead branch's required see %s", (_name, schema) => {
    expect(codes(JSON.parse(schema))).toEqual([]);
  });

  // Known difference from reading every branch as live: the path to `p` no
  // longer runs through the root's dead `then`, so its `y` does not reach the
  // dead branch under `p`.
  it("does not widen a live path through a dead branch above it", () => {
    const schema = JSON.parse(`{
      "properties": { "p": { "then": { "required": ["y"] } } },
      "then": { "properties": { "p": { "properties": { "y": {} } } } }
    }`);
    expect(issues(schema)).toEqual([{ code: REQUIRED, path: "properties.p.then" }]);
  });

  it("keeps a shared component's finding at the first reference site", () => {
    const schema = JSON.parse(`{
      "properties": {
        "a": { "then": { "$ref": "#/__proto__" }, "$ref": "#/$defs/S" },
        "b": { "$ref": "#/$defs/S" }
      },
      "$defs": { "S": { "properties": { "q": {} }, "required": ["zz"] } }
    }`);
    expect(issues(schema)).toEqual([{ code: REQUIRED, path: "properties.a" }]);
  });

  it("compiles a schema whose unreached $defs holds a refused reference", () => {
    const unreached = { $defs: { Unused: refused("#/__proto__") } };
    expect(codes(unreached)).toEqual([]);
  });
});

describe("required lint: dead branches sharing a target", () => {
  // Each level's `then` and `else` both reach the next level, with no `if`
  // anywhere. Every dead branch must share one instance, or each path through
  // the diamond is walked on its own.
  it("visits a dead-branch diamond once per level", () => {
    const depth = 12;
    const $defs: Record<string, unknown> = {
      [`S${depth}`]: { properties: { x: {} }, required: ["x"] },
    };
    for (let i = 0; i < depth; i++) {
      const next = { $ref: `#/$defs/S${i + 1}` };
      $defs[`S${i}`] = JSON.parse(
        `{"then":${JSON.stringify(next)},"else":${JSON.stringify(next)}}`,
      );
    }
    let calls = 0;
    const resolve = (ref: string) => {
      calls += 1;
      return $defs[ref.slice("#/$defs/".length)];
    };
    expect(collectRequiredIssues({ allOf: [{ $ref: "#/$defs/S0" }], $defs }, { resolve })).toEqual(
      [],
    );
    expect(calls).toBeLessThan(depth * 20);
  });
});

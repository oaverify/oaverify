import { describe, expect, it } from "vitest";
import { UnrecognisedTargetError, parseTarget } from "../src/parse-target.js";

describe("parseTarget", () => {
  it("parses dot-names", () => {
    expect(parseTarget("$.info")).toEqual([{ kind: "name", name: "info" }]);
    expect(parseTarget("$.paths.pets.get")).toEqual([
      { kind: "name", name: "paths" },
      { kind: "name", name: "pets" },
      { kind: "name", name: "get" },
    ]);
  });

  it("parses bracket-quoted keys (single and double quotes)", () => {
    expect(parseTarget("$.paths['/pets']")).toEqual([
      { kind: "name", name: "paths" },
      { kind: "key", key: "/pets" },
    ]);
    expect(parseTarget('$.paths["/pets/{id}"]')).toEqual([
      { kind: "name", name: "paths" },
      { kind: "key", key: "/pets/{id}" },
    ]);
  });

  it("parses wildcards in dot and bracket forms", () => {
    expect(parseTarget("$.paths.*")).toEqual([
      { kind: "name", name: "paths" },
      { kind: "wildcard" },
    ]);
    expect(parseTarget("$.servers[*]")).toEqual([
      { kind: "name", name: "servers" },
      { kind: "wildcard" },
    ]);
  });

  it("parses bracket-index", () => {
    expect(parseTarget("$.servers[0]")).toEqual([
      { kind: "name", name: "servers" },
      { kind: "index", index: 0 },
    ]);
  });

  it("parses single-field equality filters", () => {
    expect(parseTarget("$.tags[?(@.name=='Pets')]")).toEqual([
      { kind: "name", name: "tags" },
      { kind: "filter", expr: { kind: "field-eq", field: "name", value: "Pets" } },
    ]);
  });

  it("parses two-field AND filters", () => {
    expect(
      parseTarget("$.paths['/x'].get.parameters[?(@.name=='limit' && @.in=='query')]"),
    ).toEqual([
      { kind: "name", name: "paths" },
      { kind: "key", key: "/x" },
      { kind: "name", name: "get" },
      { kind: "name", name: "parameters" },
      {
        kind: "filter",
        expr: {
          kind: "field-eq-and",
          a: { field: "name", value: "limit" },
          b: { field: "in", value: "query" },
        },
      },
    ]);
  });

  it("parses array-containment filters", () => {
    expect(parseTarget("$.paths.*.*[?(@.tags contains 'internal')]")).toEqual([
      { kind: "name", name: "paths" },
      { kind: "wildcard" },
      { kind: "wildcard" },
      { kind: "filter", expr: { kind: "field-contains", field: "tags", value: "internal" } },
    ]);
  });

  it("rejects an empty path", () => {
    expect(() => parseTarget("")).toThrow(UnrecognisedTargetError);
  });

  it("rejects targets without a leading `$`", () => {
    expect(() => parseTarget("info")).toThrow(/expected leading `\$`/);
  });

  it("rejects recursive descent (`..`)", () => {
    expect(() => parseTarget("$..parameters")).toThrow(/recursive descent/);
  });

  it("rejects unsupported filter operators", () => {
    expect(() => parseTarget("$.tags[?(@.name>'a')]")).toThrow(/unsupported filter operator/);
  });

  it("rejects AND between non-equality clauses", () => {
    expect(() => parseTarget("$.x[?(@.a contains 'a' && @.b contains 'b')]")).toThrow(
      /AND-joined filter/,
    );
  });

  it("UnrecognisedTargetError carries the offending target", () => {
    try {
      parseTarget("$.x..y");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnrecognisedTargetError);
      expect((err as UnrecognisedTargetError).target).toBe("$.x..y");
    }
  });
});

describe("quoted target escapes", () => {
  it.each([
    [String.raw`$['a\\b']`, String.raw`a\b`],
    [String.raw`$["a\\b"]`, String.raw`a\b`],
    [String.raw`$['a\'b']`, "a'b"],
    [String.raw`$["a\"b"]`, 'a"b'],
    [String.raw`$['a\"b']`, 'a"b'],
    [String.raw`$["a\'b"]`, "a'b"],
    [String.raw`$['a\\\'b']`, "a\\'b"],
    [String.raw`$["a\\\"b"]`, 'a\\"b'],
    [String.raw`$['a\\']`, "a\\"],
    [String.raw`$['\\\\']`, "\\\\"],
    [String.raw`$['\\n']`, String.raw`\n`],
    ["$['ordinary/key']", "ordinary/key"],
    ["$['']", ""],
  ])("decodes %s once", (target, key) => {
    expect(parseTarget(target)).toEqual([{ kind: "key", key }]);
  });

  it.each([
    String.raw`$['a\q']`,
    String.raw`$['a\n']`,
    String.raw`$['a\u0062']`,
    String.raw`$['a\u00XX']`,
    String.raw`$['a\/b']`,
    "$['a" + "\\",
    String.raw`$['a\']`,
  ])("rejects unsupported or incomplete escapes in %s", (target) => {
    expect(() => parseTarget(target)).toThrow(UnrecognisedTargetError);
    expect(() => parseTarget(target)).toThrow(/escape|unterminated/);
    try {
      parseTarget(target);
    } catch (error) {
      expect((error as UnrecognisedTargetError).target).toBe(target);
    }
  });

  it("decodes filter values with the same rules as keys", () => {
    expect(parseTarget(String.raw`$.tags[?(@.name=='a\\\'b')]`)[1]).toEqual({
      kind: "filter",
      expr: { kind: "field-eq", field: "name", value: "a\\'b" },
    });
    expect(parseTarget(String.raw`$.paths.*.*[?(@.tags contains 'a\\b')]`)[3]).toEqual({
      kind: "filter",
      expr: { kind: "field-contains", field: "tags", value: String.raw`a\b` },
    });
    expect(() => parseTarget(String.raw`$.tags[?(@.name=='a\q')]`)).toThrow(
      UnrecognisedTargetError,
    );
  });
});

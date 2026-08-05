import { describe, expect, it } from "vitest";
import type { CheckFinding } from "../src/finding.js";
import { applySkip, parseSkipKeys, SkipKeyError } from "../src/skip.js";

const finding = (cls: string, code: string): CheckFinding =>
  ({
    class: cls,
    code,
    severity: "warning",
    message: "m",
    location: "l",
    target: {},
  }) as unknown as CheckFinding;

const parse = (...entries: string[]): ReturnType<typeof parseSkipKeys> => parseSkipKeys(entries);

describe("the key grammar, shared with --severity", () => {
  it("takes an exact code", () => {
    expect(parse("format-not-validated")).toEqual([
      { kind: "code", value: "format-not-validated" },
    ]);
  });

  it("takes a family", () => {
    expect(parse("unsatisfiable/*")).toEqual([{ kind: "family", value: "unsatisfiable" }]);
  });

  it("takes a class", () => {
    expect(parse("redos")).toEqual([{ kind: "class", value: "redos" }]);
  });

  it("takes a comma-separated list and a repeated flag", () => {
    expect(parse("redos,unused-tag", "examples")).toHaveLength(3);
  });

  it("ignores empty entries rather than refusing them", () => {
    // A trailing comma in a CI file is not a typo worth failing on.
    expect(parse("redos,")).toHaveLength(1);
    expect(parse("")).toEqual([]);
  });

  it("refuses a key that names nothing, and names the real members", () => {
    expect(() => parse("unsatisfiable/pattern-lenght")).toThrow(SkipKeyError);
    expect(() => parse("unsatisfiable/pattern-lenght")).toThrow(/"unsatisfiable\/" holds/);
    expect(() => parse("nonsense")).toThrow(/is not a class/);
    expect(() => parse("nosuch/*")).toThrow(/is not a code family/);
  });
});

describe("malformed cannot be skipped", () => {
  // The exit-4 signal. Suppressing it would turn "this document does
  // not compile" into a clean report.
  it("refuses the class spelling", () => {
    expect(() => parse("malformed")).toThrow(SkipKeyError);
    expect(() => parse("malformed")).toThrow(/cannot be skipped/);
  });

  it("refuses the code spelling", () => {
    // Easy to lose: parseFindingKey resolves `malformed-schema` as an
    // ordinary code by design, so only this check stops it.
    expect(() => parse("malformed-schema")).toThrow(SkipKeyError);
    expect(() => parse("malformed-schema")).toThrow(/cannot be skipped/);
  });

  it("refuses it inside a list, not just alone", () => {
    expect(() => parse("redos,malformed")).toThrow(SkipKeyError);
  });
});

describe("what applySkip drops", () => {
  const findings = [
    finding("schema", "format-not-validated"),
    finding("schema", "unsatisfiable/pattern-length"),
    finding("schema", "unsatisfiable/enum-member-type"),
    finding("redos", "ambiguous-pattern"),
    finding("hygiene", "unused-tag"),
  ];

  it("drops by exact code and leaves the rest", () => {
    const { findings: kept, dropped } = applySkip(findings, parse("format-not-validated"));
    expect(dropped).toBe(1);
    expect(kept.map((f) => f.code)).not.toContain("format-not-validated");
    expect(kept).toHaveLength(4);
  });

  it("drops a whole family", () => {
    const { findings: kept } = applySkip(findings, parse("unsatisfiable/*"));
    expect(kept.map((f) => f.code)).toEqual([
      "format-not-validated",
      "ambiguous-pattern",
      "unused-tag",
    ]);
  });

  it("drops a whole class", () => {
    const { findings: kept } = applySkip(findings, parse("schema"));
    expect(kept.map((f) => f.class)).toEqual(["redos", "hygiene"]);
  });

  it("changes nothing when no keys are given", () => {
    const result = applySkip(findings, []);
    expect(result.findings).toEqual(findings);
    expect(result.skipped).toEqual([]);
    expect(result.dropped).toBe(0);
  });
});

describe("the skip report", () => {
  const findings = [
    finding("schema", "format-not-validated"),
    finding("redos", "ambiguous-pattern"),
  ];

  it("reports one entry per key, in the order given", () => {
    const { skipped } = applySkip(findings, parse("redos,format-not-validated"));
    expect(skipped).toEqual([
      { key: "redos", count: 1 },
      { key: "format-not-validated", count: 1 },
    ]);
  });

  it("reports a key that matched nothing, with a count of zero", () => {
    // The interesting case: a CI flag suppressing a code that no longer
    // fires. Dropping the entry would make it invisible, which is the
    // failure that suppression-without-a-report causes.
    const { skipped, dropped } = applySkip(findings, parse("unused-tag"));
    expect(skipped).toEqual([{ key: "unused-tag", count: 0 }]);
    expect(dropped).toBe(0);
  });

  it("writes a family key back with its star", () => {
    const { skipped } = applySkip(findings, parse("unsatisfiable/*"));
    expect(skipped[0]?.key).toBe("unsatisfiable/*");
  });

  it("counts a finding against each key that matched it, and drops it once", () => {
    // Overlapping keys: the per-key counts say what each key is doing,
    // and `dropped` is the number that left the array.
    const result = applySkip(findings, parse("redos,ambiguous-pattern"));
    expect(result.skipped).toEqual([
      { key: "redos", count: 1 },
      { key: "ambiguous-pattern", count: 1 },
    ]);
    expect(result.dropped).toBe(1);
    expect(result.findings).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { CHECK_FAMILIES } from "../src/codes.js";
import { parseFindingKey } from "../src/finding-key.js";

describe("what a key names", () => {
  it("resolves a class", () => {
    expect(parseFindingKey("redos")).toEqual({ ok: true, key: { kind: "class", value: "redos" } });
  });

  it("resolves a family, without the star", () => {
    expect(parseFindingKey("unsatisfiable/*")).toEqual({
      ok: true,
      key: { kind: "family", value: "unsatisfiable" },
    });
  });

  it("resolves an exact code", () => {
    expect(parseFindingKey("unsatisfiable/pattern-length")).toEqual({
      ok: true,
      key: { kind: "code", value: "unsatisfiable/pattern-length" },
    });
  });

  it("resolves a malformed code as an ordinary code", () => {
    // Refusing `malformed` is each caller's job, because each owes the
    // reader a different sentence about why.
    expect(parseFindingKey("malformed-schema")).toEqual({
      ok: true,
      key: { kind: "code", value: "malformed-schema" },
    });
  });
});

describe("what it refuses", () => {
  it("refuses an empty key", () => {
    expect(parseFindingKey("")).toEqual({ ok: false, reason: "no key" });
  });

  it("refuses a family that does not exist, naming the ones that do", () => {
    const result = parseFindingKey("nosuch/*");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(`"nosuch" is not a code family`);
    for (const family of CHECK_FAMILIES) expect(result.reason).toContain(family);
  });

  it("refuses a star anywhere but the end", () => {
    expect(parseFindingKey("unsat*/pattern")).toEqual({
      ok: false,
      reason: `"*" is only allowed as a trailing "/*"`,
    });
  });

  it("refuses a mistyped code, naming its family's real members", () => {
    const result = parseFindingKey("unsatisfiable/pattern-lenght");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(`is not a code oaverify emits`);
    expect(result.reason).toContain(`"unsatisfiable/" holds`);
    expect(result.reason).toContain("unsatisfiable/pattern-length");
  });

  it("refuses a bare word that is neither class nor code", () => {
    const result = parseFindingKey("nonsense");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(`"nonsense" is not a class`);
    expect(result.reason).toContain("redos");
  });
});

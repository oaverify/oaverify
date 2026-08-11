import { describe, expect, it } from "vitest";
import { CHECK_CODES } from "../src/codes.js";
import { CHECK_RULES, ruleFor } from "../src/rules.js";

describe("every code describes itself", () => {
  // The `Record<CheckCode, CheckRule>` annotation already makes a
  // missing code a typecheck error. This covers the direction it
  // cannot: a title that is present and useless.
  it("has a title for every code and no extras", () => {
    expect(new Set(Object.keys(CHECK_RULES))).toEqual(new Set(CHECK_CODES));
  });

  it("does not restate the id as its own description", () => {
    // What `shortDescription` did before the catalogue existed, and the
    // thing the catalogue is for. A title equal to the code, or one
    // that is the code with the punctuation taken out, has added
    // nothing.
    for (const [code, rule] of Object.entries(CHECK_RULES)) {
      expect(rule.title).not.toBe(code);
      expect(rule.title.replace(/\W/g, "")).not.toBe(code.replace(/\W/g, ""));
      expect(rule.title.length).toBeGreaterThan(code.length);
    }
  });

  it("keeps titles to one line", () => {
    // Read as a rule label in an editor and as SARIF's
    // `shortDescription`, both of which are single-line slots.
    for (const rule of Object.values(CHECK_RULES)) {
      expect(rule.title).not.toContain("\n");
      expect(rule.title.length).toBeLessThanOrEqual(80);
    }
  });

  it("gives an explanation only where there is something to explain", () => {
    // Not every rule earns one, and inventing prose for
    // `unused-component` would add words without adding facts. The
    // codes that do carry one are the codes whose messages used to.
    const explained = Object.entries(CHECK_RULES)
      .filter(([, rule]) => rule.explanation !== undefined)
      .map(([code]) => code)
      .sort();
    expect(explained).toEqual([
      "ambiguous-pattern",
      "example-invalid",
      "example-uncheckable",
      "format-not-validated",
    ]);
  });
});

describe("looking a rule up", () => {
  it("finds a known code", () => {
    expect(ruleFor("unused-tag")?.title).toBe("a declared tag no operation references");
  });

  it("returns nothing for a code it does not know", () => {
    // `CheckFinding.code` is widened with `string`, so a consumer
    // pinned at one version meets codes from a later one. Nothing,
    // rather than an invented title a caller could not tell from a
    // real one.
    expect(ruleFor("invented-later")).toBeUndefined();
  });

  it("is not fooled by an inherited property name", () => {
    expect(ruleFor("toString")).toBeUndefined();
    expect(ruleFor("constructor")).toBeUndefined();
  });
});

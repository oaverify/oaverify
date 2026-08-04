import { describe, expect, it } from "vitest";
import { checkDocumentRedos } from "../src/redos-check.js";
import {
  CHECK_CODES,
  CHECK_FAMILIES,
  CODES_BY_CLASS,
  EXAMPLES_CODES,
  MALFORMED_CODES,
  REDOS_CODES,
} from "../src/codes.js";
import { CHECK_CLASSES } from "@oaverify/check";

// The union-pinned slices fail the typecheck on drift. These three are
// hand-written against a literal at an emit site, so they need a test.
describe("the hand-written slices still match their emit sites", () => {
  it("redos emits the code the registry lists", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": {
          get: {
            parameters: [
              { name: "q", in: "query", schema: { type: "string", pattern: "^(a+)+$" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const issues = checkDocumentRedos(doc as never);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(REDOS_CODES).toContain(issue.code);
  });

  // Both need a compiled validator to produce, which `check` owns.
  it("lists the codes each of examples and malformed emits", () => {
    expect([...EXAMPLES_CODES]).toEqual(["example-invalid", "example-uncheckable"]);
    expect([...MALFORMED_CODES]).toEqual(["malformed-schema"]);
  });
});

describe("the registry covers the classes it claims to", () => {
  it("has an entry for every selectable class, plus malformed", () => {
    expect(Object.keys(CODES_BY_CLASS).sort()).toEqual([...CHECK_CLASSES, "malformed"].sort());
  });

  it("holds no duplicate code across classes", () => {
    const all = Object.values(CODES_BY_CLASS).flatMap((codes) => [...codes]);
    expect(all.length).toBe(CHECK_CODES.size);
  });

  it("derives families from the codes that have one", () => {
    expect([...CHECK_FAMILIES].sort()).toEqual(["silent-rewrite", "unsatisfiable"]);
    for (const family of CHECK_FAMILIES) {
      expect([...CHECK_CODES].some((code) => code.startsWith(`${family}/`))).toBe(true);
    }
  });
});

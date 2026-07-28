import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";
import { failure, petSpec } from "./fixtures.js";

// These exercise the real (un-shimmed) validator: the `output` knob, the
// flat default, and the per-call `maxErrors` total. The shimmed
// `createValidator` in fixtures.ts is for the logic-focused suites.

const badPost = {
  method: "POST",
  path: "/pets",
  contentType: "application/json",
  // missing required X-Tenant header AND missing required body `name`:
  // at least two problems, in two different locations.
  body: { age: -1 },
} as const;

describe("validator output modes", () => {
  it("defaults to flat output", () => {
    const v = createValidator(petSpec());
    const r = v.validateRequest(badPost);
    expect(r.valid).toBe(false);
    expect(Array.isArray(failure(r).errors)).toBe(true);
    expect("error" in r).toBe(false);
    expect(v.output).toBe("flat");
  });

  it("defaults to maxErrors: 1 as a per-call total across locations", () => {
    const v = createValidator(petSpec());
    const r = v.validateRequest(badPost);
    expect(failure(r).errors).toHaveLength(1);
    expect(failure(r).truncated).toBe(true);
  });

  it("collects every location's errors when uncapped", () => {
    const v = createValidator(petSpec(), { maxErrors: Number.POSITIVE_INFINITY });
    const r = v.validateRequest(badPost);
    // header + body problems both present.
    expect(failure(r).errors.length).toBeGreaterThan(1);
    expect(failure(r).truncated).toBe(false);
  });

  it("caps the per-call total at an explicit maxErrors", () => {
    const v = createValidator(petSpec(), { maxErrors: 2 });
    const r = v.validateRequest(badPost);
    expect(failure(r).errors.length).toBeLessThanOrEqual(2);
  });

  it("a valid request is { valid: true } with no error fields", () => {
    const v = createValidator(petSpec());
    const r = v.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      headers: { "x-tenant": "acme" },
      body: { name: "Fido" },
    });
    expect(r).toEqual({ valid: true });
  });

  describe('output: "tree"', () => {
    it("returns a nested tree under error", () => {
      const v = createValidator(petSpec(), {
        output: "tree",
        maxErrors: Number.POSITIVE_INFINITY,
      });
      const r = v.validateRequest(badPost);
      expect(r.valid).toBe(false);
      expect(failure(r).error.code).toBe("request");
      expect(failure(r).error.children.length).toBeGreaterThan(0);
      expect("errors" in r).toBe(false);
      expect(v.output).toBe("tree");
    });
  });

  describe('output: "predicate"', () => {
    it("returns a bare boolean", () => {
      const v = createValidator(petSpec(), { output: "predicate" });
      expect(v.validateRequest(badPost)).toBe(false);
      expect(
        v.validateRequest({
          method: "POST",
          path: "/pets",
          contentType: "application/json",
          headers: { "x-tenant": "acme" },
          body: { name: "Fido" },
        }),
      ).toBe(true);
      expect(v.output).toBe("predicate");
    });
  });

  it("flat leaves carry their HTTP location in the path prefix", () => {
    const v = createValidator(petSpec(), { maxErrors: Number.POSITIVE_INFINITY });
    const r = v.validateRequest(badPost);
    const locations = new Set(failure(r).errors.map((e) => e.path[0]));
    // body problems land under ["body", ...]; header problems elsewhere.
    expect(locations.has("body")).toBe(true);
  });

  it("a route miss is a single route leaf in flat mode", () => {
    const v = createValidator(petSpec());
    const r = v.validateRequest({ method: "POST", path: "/nope" });
    expect(failure(r).errors).toHaveLength(1);
    expect(failure(r).errors[0]?.code).toBe("route");
  });
});

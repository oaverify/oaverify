import { httpStatusFor, type OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

/**
 * A `security` field that is not a list (#883).
 *
 * `compileOperationSecurity` tested `effective.length === 0` and then
 * called `effective.map`. A mapping has no `length`, so the guard missed
 * and every `validateRequest` threw
 * `TypeError: effective.map is not a function`. It is one missing `- `:
 *
 * ```yaml
 * security:
 *     apiKey: []
 * ```
 *
 * The shape #837 settled for `parameters` is to read a non-array as
 * absent. That answer is deliberately **not** taken here. Its
 * consequence for `parameters` is that nothing asserts them; the same
 * consequence for `security` is that an operation whose author did
 * require a credential serves every anonymous request. This file already
 * fails closed twice over, for an undeclared scheme name and for a
 * malformed `apiKey` definition, so an unreadable requirement joins them
 * and the request gets a 401.
 *
 * The readers that do not issue a verdict take the opposite answer, and
 * for the same reason `parameters` did: the hygiene lint and the overlay
 * must not crash, because `oaverify check` has to reach the conformance
 * pass that reports `must be array` at the pointer. Those are pinned in
 * `@oaverify/internal-spec`'s lint and overlay suites.
 */

const doc = (
  extra: Record<string, unknown>,
  opExtra: Record<string, unknown> = {},
): OpenAPIDocument =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    components: {
      securitySchemes: { k: { type: "apiKey", in: "header", name: "x-k" } },
    },
    ...extra,
    paths: {
      "/t": { get: { responses: { "200": { description: "ok" } }, ...opExtra } },
    },
  }) as unknown as OpenAPIDocument;

const NOT_A_LIST = { k: [] };

describe("a security field that is not a list", () => {
  for (const [label, build] of [
    ["on an operation", () => doc({}, { security: NOT_A_LIST })],
    ["on the document", () => doc({ security: NOT_A_LIST })],
  ] as const) {
    for (const mode of ["shape", "strict"] as const) {
      it(`returns a verdict instead of throwing, ${label} in ${mode} mode`, () => {
        const v = createValidator(build(), { validateSecurity: mode });
        expect(() => v.validateRequest({ method: "GET", path: "/t" })).not.toThrow();
      });

      it(`rejects rather than serving the request, ${label} in ${mode} mode`, () => {
        const v = createValidator(build(), { validateSecurity: mode });
        const result = v.validateRequest({ method: "GET", path: "/t" });
        expect(result.valid).toBe(false);
      });
    }
  }

  it("reports the failure as security, so the status is 401 rather than 400", () => {
    const v = createValidator(doc({}, { security: NOT_A_LIST }), { validateSecurity: "shape" });
    const result = v.validateRequest({ method: "GET", path: "/t" });
    if (result.valid) throw new Error("expected the request to be rejected");
    expect(result.errors?.[0]?.code).toBe("security");
    expect(httpStatusFor(result.errors ?? [])).toBe(401);
  });

  it("names the field rather than inventing a scheme name", () => {
    const v = createValidator(doc({}, { security: NOT_A_LIST }), { validateSecurity: "shape" });
    const result = v.validateRequest({ method: "GET", path: "/t" });
    if (result.valid) throw new Error("expected the request to be rejected");
    expect(result.errors?.[0]?.message).toContain("is not a list of security requirement objects");
    // `declared` carries the field, not `k`: the mapping's keys would be
    // a guess at a shape that failed to parse.
    expect(result.errors?.[0]?.params).toEqual({ declared: [["security"]] });
  });

  it("still passes a credential-carrying request when the list is readable", () => {
    const v = createValidator(doc({}, { security: [{ k: [] }] }), { validateSecurity: "shape" });
    expect(v.validateRequest({ method: "GET", path: "/t", headers: { "x-k": "v" } }).valid).toBe(
      true,
    );
    expect(v.validateRequest({ method: "GET", path: "/t" }).valid).toBe(false);
  });

  it("leaves an empty list meaning no security, which is not the same shape", () => {
    const v = createValidator(doc({ security: [{ k: [] }] }, { security: [] }), {
      validateSecurity: "shape",
    });
    expect(v.validateRequest({ method: "GET", path: "/t" }).valid).toBe(true);
  });

  it("reads `security:` with nothing under it as declaring nothing", () => {
    const v = createValidator(doc({}, { security: null }), { validateSecurity: "shape" });
    expect(v.validateRequest({ method: "GET", path: "/t" }).valid).toBe(true);
  });

  it("reads a document-level `security:` with nothing under it the same way", () => {
    // `operation.security ?? document.security` resolves an operation's
    // `null` to the document's value, so an op-level null with no
    // document-level value collapses to `undefined` and never reaches
    // the not-an-array branch. The document-level null does, and reading
    // it as unreadable failed every request to every operation,
    // including one carrying the credential.
    const v = createValidator(doc({ security: null }), { validateSecurity: "shape" });
    expect(v.validateRequest({ method: "GET", path: "/t" }).valid).toBe(true);
    expect(v.validateRequest({ method: "GET", path: "/t", headers: { "x-k": "v" } }).valid).toBe(
      true,
    );
  });
});

describe("a security list whose element is not a requirement object", () => {
  // ```yaml
  // security:
  //   -
  // ```
  // parses as `[null]`. The list is an array, so it passes the container
  // guard and used to reach `Object.keys(null)`: the same raw TypeError
  // out of `validateRequest`, and the same `oaverify check` exit 3.

  for (const [label, build] of [
    ["on an operation", () => doc({}, { security: [null] })],
    ["on the document", () => doc({ security: [null] })],
  ] as const) {
    it(`fails closed rather than throwing, ${label}`, () => {
      const v = createValidator(build(), { validateSecurity: "shape" });
      expect(() => v.validateRequest({ method: "GET", path: "/t" })).not.toThrow();
      expect(v.validateRequest({ method: "GET", path: "/t" }).valid).toBe(false);
    });
  }

  it("lets a readable alternative the request satisfies still pass", () => {
    // `checkSecurity` ORs across requirements: only one alternative has
    // to hold, and the unreadable one is never the one that does.
    const v = createValidator(doc({}, { security: [{ k: [] }, null] }), {
      validateSecurity: "shape",
    });
    expect(v.validateRequest({ method: "GET", path: "/t", headers: { "x-k": "v" } }).valid).toBe(
      true,
    );
    expect(v.validateRequest({ method: "GET", path: "/t" }).valid).toBe(false);
  });
});

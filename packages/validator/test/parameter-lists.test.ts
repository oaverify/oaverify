import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

/**
 * A `parameters` field that is not a list (#837).
 *
 * `buildOperationCache` spread the field into an array literal, so a
 * mapping reached `TypeError: (pathMatch.operation.parameters ?? []).map
 * is not a function or its return value is not iterable` out of
 * `validateRequest`. That named a private
 * expression, at request time, for a defect in the document. It is one
 * missing `- ` in YAML:
 *
 * ```yaml
 * parameters:
 *     name: id
 *     in: path
 * ```
 *
 * A non-array now reads as no parameters, matching how the cache already
 * treats a `null` entry. Refusing at construction was the other option
 * and is deliberately not taken: the conformance pass locates the defect,
 * reporting `must be array` at the offending pointer, and a throw here
 * would pre-empt it with a worse message.
 *
 * The consequence is that nothing asserts the parameters the document
 * meant to declare, so a request omitting a required one is reported
 * valid. That is the cost of reading a malformed list as empty, and the
 * reason the same walk in the hygiene lint and the overlay reader was
 * taught the same shape: `oaverify check` has to reach the pass that
 * names it rather than exiting on a raw `TypeError`.
 */

const doc = (pathItem: Record<string, unknown>): OpenAPIDocument =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: { "/t": pathItem },
  }) as unknown as OpenAPIDocument;

const ok = { responses: { "200": { description: "ok" } } };

describe("a parameters field that is not a list", () => {
  it("returns a verdict instead of throwing, on an operation", () => {
    const v = createValidator(doc({ get: { ...ok, parameters: { name: "id", in: "query" } } }));
    expect(() => v.validateRequest({ method: "GET", path: "/t" })).not.toThrow();
    expect(v.validateRequest({ method: "GET", path: "/t" }).valid).toBe(true);
  });

  it("returns a verdict instead of throwing, on a path item", () => {
    const v = createValidator(doc({ parameters: { name: "id", in: "query" }, get: ok }));
    expect(() => v.validateRequest({ method: "GET", path: "/t" })).not.toThrow();
    expect(v.validateRequest({ method: "GET", path: "/t" }).valid).toBe(true);
  });

  it("reads a non-array as no parameters, whatever the JSON type", () => {
    for (const parameters of ["id", 42, true, null, {}]) {
      const v = createValidator(doc({ get: { ...ok, parameters } }));
      expect(
        v.validateRequest({ method: "GET", path: "/t" }).valid,
        JSON.stringify(parameters),
      ).toBe(true);
    }
  });

  it("still validates the parameters a sibling operation declares properly", () => {
    // The bad list must not disturb the operation next to it.
    const v = createValidator(
      doc({
        get: { ...ok, parameters: { name: "id", in: "query" } },
        post: {
          ...ok,
          parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
        },
      }),
    );
    expect(v.validateRequest({ method: "GET", path: "/t" }).valid).toBe(true);
    const missing = v.validateRequest({ method: "POST", path: "/t" });
    expect(missing.valid).toBe(false);
  });

  it("asserts nothing for a parameter the malformed list meant to declare", () => {
    // The mapping was meant to declare a required `id`. Reading it as no
    // parameters means nothing asserts `id`, so a request without it is
    // valid. That is the documented cost, and `oaverify check` is what
    // tells the author their list is malformed.
    const v = createValidator(
      doc({ get: { ...ok, parameters: { name: "id", in: "query", required: true } } }),
    );
    expect(v.validateRequest({ method: "GET", path: "/t" }).valid).toBe(true);
  });
});

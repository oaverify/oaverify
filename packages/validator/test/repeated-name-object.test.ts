/**
 * A repeated parameter name against an object-typed schema.
 *
 * The verdict is not in question: `style: form` does not spread an
 * object across repeats the way `style: cookie` and `deepObject` do, so
 * the request is malformed. The message was. `deserialize` reads
 * `raw[0]` for an object-typed parameter, so the schema saw a string
 * and answered "must be object", describing a value the caller never
 * sent and saying nothing about the repeat that produced it (#889).
 *
 * One shape with two entry points: newly reachable for a cookie since
 * #826 let `HttpRequest.cookies` carry an array, and pre-existing for a
 * query parameter whose name repeats.
 */
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

const objectSchema = {
  type: "object",
  properties: { R: { type: "string" }, G: { type: "string" } },
};

const spec = (location: "query" | "cookie", param: Record<string, unknown>): OpenAPIDocument =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/t": {
        get: {
          parameters: [{ name: "p", in: location, required: true, schema: objectSchema, ...param }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  }) as OpenAPIDocument;

function run(
  doc: OpenAPIDocument,
  location: "query" | "cookie",
  value: string | string[],
): { valid: boolean; message?: string } {
  const v = createValidator(doc);
  const req = {
    method: "GET",
    path: "/t",
    [location === "query" ? "query" : "cookies"]: { p: value },
  };
  const r = v.validateRequest(req as never) as { valid: boolean; errors?: { message: string }[] };
  return { valid: r.valid, message: r.errors?.[0]?.message };
}

describe("a repeated name against an object schema", () => {
  // Where the style carries the object in one value, a repeat is this
  // defect. `style: form` with `explode: true` on a query parameter is
  // the exception: there the object IS spread across keys, so the
  // assembler runs and a repeated `p` is simply not one of those keys.
  const carriesInOneValue: Array<["query" | "cookie", boolean]> = [
    ["query", false],
    ["cookie", false],
    ["cookie", true],
  ];
  for (const [location, explode] of carriesInOneValue) {
    it(`${location}: names the repeat, not the type it produced (explode: ${explode})`, () => {
      const r = run(spec(location, { style: "form", explode }), location, ["R,100", "G,200"]);
      expect(r.valid).toBe(false);
      expect(r.message).toMatch(/sent more than once/);
      // The symptom the caller could do nothing with.
      expect(r.message).not.toMatch(/must be object/);
    });
  }

  it("query, explode true: a repeat is absence, because the object lives in spread keys", () => {
    // Not the new message, and deliberately so: `assembleObjectQueryParam`
    // looks for `R` and `G`, finds neither, and the parameter is absent.
    // Pinned because it is the boundary of the fix above.
    const r = run(spec("query", { style: "form", explode: true }), "query", ["R,100", "G,200"]);
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/missing required query parameter/);
    expect(r.message).not.toMatch(/must be object/);
  });

  for (const location of ["query", "cookie"] as const) {
    it(`${location}: still accepts the single value this style carries`, () => {
      const r = run(spec(location, { style: "form", explode: false }), location, "R,100,G,200");
      expect(r.valid).toBe(true);
    });

    it(`${location}: leaves a repeated name against an array schema alone`, () => {
      const doc = spec(location, { style: "form" });
      const param = (doc.paths!["/t"]!.get!.parameters as { schema: unknown }[])[0]!;
      param.schema = { type: "array", items: { type: "string" } };
      expect(run(doc, location, ["a", "b"]).valid).toBe(true);
    });
  }
});

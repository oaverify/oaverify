import type { OpenAPIDocument, ParameterObject } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { assembleObjectCookieParam } from "../src/param-assembly.js";
import { deserialize } from "../src/deserialize.js";
import { createValidator } from "../src/validator.js";

/**
 * OpenAPI 3.2 `style: cookie`. Analogous to `form`, but delimited by
 * RFC 6265's "; " and with explode defaulting to true, so an exploded
 * object arrives as one crumb per property and nothing is stored under
 * the parameter's own name.
 */

/** The `returnValues` accumulator, as much of it as these cases read. */
interface RequestValuesLike {
  cookies: Record<string, unknown>;
}

const cookieSpec = (
  param: Record<string, unknown>,
  schema: Record<string, unknown>,
): OpenAPIDocument =>
  ({
    openapi: "3.2.0",
    info: { title: "t", version: "1" },
    paths: {
      "/t": {
        get: {
          parameters: [{ name: "p", in: "cookie", required: true, schema, ...param }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  }) as OpenAPIDocument;

const objectSchema = {
  type: "object",
  properties: { R: { type: "string" }, G: { type: "string" } },
};

function run(
  doc: OpenAPIDocument,
  cookies: Record<string, string>,
): { valid: boolean; value?: RequestValuesLike; message?: string } {
  const v = createValidator(doc, { returnValues: true });
  const r = v.validateRequest({ method: "GET", path: "/t", cookies } as never) as {
    valid: boolean;
    value?: RequestValuesLike;
    errors?: { message: string }[];
  };
  return { valid: r.valid, value: r.value, message: r.errors?.[0]?.message };
}

describe("style: cookie, end to end", () => {
  // Every expectation below is a row of the OpenAPI 3.2 Style Examples
  // table, or the Style Values row defining what the style escapes.
  it("assembles an exploded object from its crumbs", () => {
    const r = run(cookieSpec({ style: "cookie" }, objectSchema), { R: "100", G: "200" });
    expect(r.valid).toBe(true);
    expect(r.value?.cookies.p).toEqual({ R: "100", G: "200" });
  });

  it("defaults explode to true, so the crumbs are read without it being declared", () => {
    const declared = run(cookieSpec({ style: "cookie", explode: true }, objectSchema), {
      R: "100",
      G: "200",
    });
    const defaulted = run(cookieSpec({ style: "cookie" }, objectSchema), { R: "100", G: "200" });
    expect(defaulted).toEqual(declared);
  });

  it("reads a non-exploded object from one comma-joined crumb", () => {
    const r = run(cookieSpec({ style: "cookie", explode: false }, objectSchema), {
      p: "R,100,G,200",
    });
    expect(r.valid).toBe(true);
    expect(r.value?.cookies.p).toEqual({ R: "100", G: "200" });
  });

  it("reads a non-exploded array from one comma-joined crumb", () => {
    const r = run(
      cookieSpec({ style: "cookie", explode: false }, { type: "array", items: { type: "string" } }),
      { p: "blue,black,brown" },
    );
    expect(r.valid).toBe(true);
    expect(r.value?.cookies.p).toEqual(["blue", "black", "brown"]);
  });

  it("reads a scalar under its own name", () => {
    const r = run(cookieSpec({ style: "cookie" }, { type: "string" }), { p: "blue" });
    expect(r.valid).toBe(true);
    expect(r.value?.cookies.p).toBe("blue");
  });

  it("leaves an apparent percent triple encoded, since the style escapes nothing", () => {
    const r = run(cookieSpec({ style: "cookie" }, { type: "string" }), { p: "blue%20black" });
    expect(r.valid).toBe(true);
    expect(r.value?.cookies.p).toBe("blue%20black");
  });

  it("reports an exploded object absent when no declared property arrived", () => {
    const r = run(cookieSpec({ style: "cookie" }, objectSchema), { other: "1" });
    expect(r.valid).toBe(false);
    expect(r.message).toBe('missing required cookie parameter "p"');
  });

  it("takes the declared properties only, ignoring a crumb the schema does not name", () => {
    const r = run(cookieSpec({ style: "cookie" }, objectSchema), {
      R: "100",
      G: "200",
      session: "abc",
    });
    expect(r.valid).toBe(true);
    expect(r.value?.cookies.p).toEqual({ R: "100", G: "200" });
  });

  it("coerces a property with the type its schema declares", () => {
    const r = run(
      cookieSpec({ style: "cookie" }, { type: "object", properties: { R: { type: "integer" } } }),
      {
        R: "100",
      },
    );
    expect(r.valid).toBe(true);
    expect(r.value?.cookies.p).toEqual({ R: 100 });
  });

  it("does not assemble a form-styled cookie object, on any version", () => {
    // Appendix D: form "is always incorrect" in a cookie for multiple
    // values, so no reading of these crumbs is the specified one and
    // the parameter stays missing. `style: cookie` is what asks for the
    // assembly. Pins the choice, which is a judgement call rather than
    // a rule the specification settles.
    for (const openapi of ["3.0.3", "3.1.0", "3.2.0"]) {
      const doc = cookieSpec({ style: "form", explode: true }, objectSchema);
      const r = run({ ...doc, openapi } as OpenAPIDocument, { R: "100", G: "200" });
      expect(r.valid, openapi).toBe(false);
      expect(r.message, openapi).toBe('missing required cookie parameter "p"');
    }
  });
});

describe("assembleObjectCookieParam", () => {
  const p = (extra: Record<string, unknown>): ParameterObject =>
    ({ name: "p", in: "cookie", schema: objectSchema, ...extra }) as ParameterObject;

  it("assembles when the style is declared and explode is left to its default", () => {
    expect(assembleObjectCookieParam(p({ style: "cookie" }), { R: "100" })).toEqual({
      value: { R: "100" },
    });
  });

  it("recognises the shape but reports no value when no declared property arrived", () => {
    expect(assembleObjectCookieParam(p({ style: "cookie" }), { other: "1" })).toEqual({
      value: undefined,
    });
  });

  it("declines every shape that is read by name instead", () => {
    // `undefined` sends the caller to the ordinary by-name lookup, and
    // is a different answer from `{ value: undefined }` above.
    expect(
      assembleObjectCookieParam(p({ style: "cookie", explode: false }), { R: "1" }),
    ).toBeUndefined();
    expect(assembleObjectCookieParam(p({ style: "form" }), { R: "1" })).toBeUndefined();
    expect(assembleObjectCookieParam(p({}), { R: "1" })).toBeUndefined();
    expect(
      assembleObjectCookieParam(p({ style: "cookie", schema: { type: "string" } }), { R: "1" }),
    ).toBeUndefined();
    expect(
      assembleObjectCookieParam({ ...p({ style: "cookie" }), in: "query" } as ParameterObject, {
        R: "1",
      }),
    ).toBeUndefined();
  });
});

describe("deserialize, style: cookie", () => {
  it("joins an exploded object with the RFC 6265 delimiter when no properties are declared", () => {
    // The residual path: with no `properties` to read, the assembler
    // declines and the joined crumbs arrive here as one string.
    expect(
      deserialize("R=100; G=200", {
        name: "p",
        in: "cookie",
        style: "cookie",
        schema: { type: "object" },
      } as ParameterObject),
    ).toEqual({ R: "100", G: "200" });
  });
});

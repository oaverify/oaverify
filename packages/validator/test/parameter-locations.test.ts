import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

/**
 * A parameter location this validator cannot read a value for (#836).
 *
 * Before the construction gate, `validateParameter`'s `switch` had no
 * `default`: a required such parameter threw
 * `TypeError: path is not iterable` out of `validateRequest`, and an
 * optional one was skipped, leaving the request reported valid on an
 * operation nothing had checked. Both halves are covered here, because
 * the silent half is the one a crash-only reproducer misses.
 *
 * Every case asserts the message as well as the throw: the message is
 * the whole product for a defect the user has to fix in their own
 * document.
 */

const doc = (
  version: string,
  pathItem: Record<string, unknown>,
  components?: Record<string, unknown>,
): OpenAPIDocument =>
  ({
    openapi: version,
    info: { title: "t", version: "1" },
    paths: { "/t": pathItem },
    ...(components === undefined ? {} : { components }),
  }) as OpenAPIDocument;

const get = (parameters: unknown[]): Record<string, unknown> => ({
  get: { parameters, responses: { "200": { description: "ok" } } },
});

const stringSchema = { type: "string" };

describe("a parameter location the validator does not serve", () => {
  it("refuses a required 3.2 querystring parameter, naming it as unimplemented", () => {
    expect(() =>
      createValidator(
        doc("3.2.0", get([{ name: "q", in: "querystring", required: true, schema: stringSchema }])),
      ),
    ).toThrow(
      'createValidator: GET /t declares parameter "q" with in: "querystring", a location this ' +
        "validator does not serve. It is legal in OpenAPI 3.2 and is not implemented here. " +
        "Remove the parameter, or declare it in query, header, path or cookie.",
    );
  });

  it("refuses an optional one too, which is the half that used to pass silently", () => {
    expect(() =>
      createValidator(doc("3.2.0", get([{ name: "q", in: "querystring", schema: stringSchema }]))),
    ).toThrow(/in: "querystring"/);
  });

  it("refuses a querystring parameter in a 3.1 document", () => {
    // Illegal there as well as unimplemented, and the message says only
    // the second. Deliberate: the refusal and the reader's next action
    // are the same either way, and the conformance pass in
    // `@oaverify/check` is what reports the illegality.
    expect(() =>
      createValidator(
        doc("3.1.0", get([{ name: "q", in: "querystring", required: true, schema: stringSchema }])),
      ),
    ).toThrow(/legal in OpenAPI 3.2 and is not implemented here/);
  });

  it("refuses a Swagger 2.0 body parameter, pointing at requestBody", () => {
    expect(() =>
      createValidator(
        doc("3.0.3", get([{ name: "payload", in: "body", required: true, schema: stringSchema }])),
      ),
    ).toThrow(
      'createValidator: GET /t declares parameter "payload" with in: "body", which is not a ' +
        "parameter location in OpenAPI 3.x. Use path, query, header or cookie. A Swagger 2.0 " +
        "body parameter becomes requestBody.",
    );
  });

  it("refuses an optional body parameter", () => {
    expect(() =>
      createValidator(doc("3.0.3", get([{ name: "payload", in: "body", schema: stringSchema }]))),
    ).toThrow(/in: "body"/);
  });

  it("refuses formData, pointing at a form media type", () => {
    expect(() =>
      createValidator(
        doc("3.0.3", get([{ name: "f", in: "formData", required: true, schema: stringSchema }])),
      ),
    ).toThrow(/formData parameter becomes requestBody with a form media type/);
  });

  it("refuses a casing typo without offering the Swagger 2.0 advice", () => {
    let message = "";
    try {
      createValidator(
        doc("3.1.0", get([{ name: "p", in: "QUERY", required: true, schema: stringSchema }])),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(
      'createValidator: GET /t declares parameter "p" with in: "QUERY", which is not a ' +
        "parameter location in OpenAPI 3.x. Use path, query, header or cookie.",
    );
  });

  it("refuses an empty string", () => {
    expect(() =>
      createValidator(
        doc("3.1.0", get([{ name: "p", in: "", required: true, schema: stringSchema }])),
      ),
    ).toThrow(/with in: "", which is not a parameter location/);
  });

  it("refuses a parameter with no in field at all", () => {
    expect(() =>
      createValidator(doc("3.1.0", get([{ name: "p", required: true, schema: stringSchema }]))),
    ).toThrow(
      'createValidator: GET /t declares parameter "p" with no "in" field. A parameter declares ' +
        "one of path, query, header or cookie.",
    );
  });

  it("refuses one behind a $ref to components.parameters", () => {
    expect(() =>
      createValidator(
        doc("3.1.0", get([{ $ref: "#/components/parameters/Bad" }]), {
          parameters: { Bad: { name: "p", in: "body", required: true, schema: stringSchema } },
        }),
      ),
    ).toThrow(/GET \/t declares parameter "p" with in: "body"/);
  });

  it("refuses one declared on the Path Item rather than the Operation", () => {
    expect(() =>
      createValidator(
        doc("3.1.0", {
          parameters: [{ name: "p", in: "body", required: true, schema: stringSchema }],
          ...get([]),
        }),
      ),
    ).toThrow(/^createValidator: path item \/t declares parameter "p" with in: "body"/);
  });

  it("refuses one carrying content rather than schema", () => {
    expect(() =>
      createValidator(
        doc(
          "3.2.0",
          get([
            {
              name: "q",
              in: "querystring",
              required: true,
              content: { "application/json": { schema: { type: "object" } } },
            },
          ]),
        ),
      ),
    ).toThrow(/in: "querystring"/);
  });

  it("names the first offender in document order when there are two", () => {
    const twice = get([
      { name: "a", in: "body", required: true, schema: stringSchema },
      { name: "b", in: "querystring", required: true, schema: stringSchema },
    ]);
    expect(() => createValidator(doc("3.2.0", twice))).toThrow(/parameter "a" with in: "body"/);
  });

  it("refuses one whose name collides with a real cookie parameter", () => {
    // The `operation-cache` bucket bug: an unserved location used to be
    // filed under `cookieParamValidators`, keyed by name, so this pair
    // collided and one schema replaced the other. Nothing reaches that
    // code now, and this pins it.
    expect(() =>
      createValidator(
        doc(
          "3.2.0",
          get([
            { name: "sid", in: "cookie", required: true, schema: stringSchema },
            { name: "sid", in: "querystring", required: true, schema: stringSchema },
          ]),
        ),
      ),
    ).toThrow(/parameter "sid" with in: "querystring"/);
  });

  it("refuses a Path Item parameter that an operation parameter does not shadow", () => {
    // Operation-level parameters replace Path Item ones keyed on
    // `(in, name)`, in the spec and in `buildOperationCache`'s dedup, so
    // a served parameter cannot shadow an unserved one: a different `in`
    // is a different parameter. The pair below both survive the merge,
    // and the unserved one is effective for the operation.
    expect(() =>
      createValidator(
        doc("3.2.0", {
          parameters: [{ name: "q", in: "querystring", required: true, schema: stringSchema }],
          ...get([{ name: "q", in: "query", required: true, schema: stringSchema }]),
        }),
      ),
    ).toThrow(/path item \/t declares parameter "q" with in: "querystring"/);
  });
});

describe("the residual path the gate cannot cover", () => {
  it("names the broken invariant when a document is mutated after construction", () => {
    // The gate reads the document once, at construction. A caller that
    // edits it afterwards holds a validator whose plan no longer
    // matches, and the parameter loop meets a location it cannot read.
    // Before #836 that was `TypeError: path is not iterable`.
    const param = { name: "q", in: "query", required: true, schema: stringSchema };
    const validator = createValidator(doc("3.2.0", get([param])));
    (param as { in: string }).in = "querystring";
    expect(() =>
      validator.validateRequest({ method: "GET", path: "/t", query: { q: "x" } }),
    ).toThrow(
      'validateParameter: parameter "q" declares in: "querystring", which createValidator ' +
        "refuses at construction. The document changed after its validator was built, or " +
        "this cache was not built by createValidator.",
    );
  });
});

describe("what the gate deliberately leaves alone", () => {
  it("builds a document whose parameters are all served, and validates them", () => {
    const validator = createValidator(
      doc("3.2.0", get([{ name: "p", in: "query", required: true, schema: stringSchema }])),
    );
    expect(validator.validateRequest({ method: "GET", path: "/t", query: { p: "x" } })).toEqual({
      valid: true,
    });
    expect(validator.validateRequest({ method: "GET", path: "/t", query: {} }).valid).toBe(false);
  });

  it("ignores a $ref'd Path Item, which the router never matches either", () => {
    // `createRouter` reads `paths` entries as written, so a `$ref`'d
    // Path Item declares no method it can see and is never routed. Its
    // parameters are never read, so there is no verdict to corrupt and
    // nothing to refuse.
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/t": { $ref: "#/components/pathItems/P" } },
      components: {
        pathItems: {
          P: {
            get: {
              parameters: [{ name: "p", in: "body", required: true, schema: stringSchema }],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    expect(() => createValidator(spec)).not.toThrow();
  });

  it("ignores a null parameter entry, which the conformance pass locates", () => {
    expect(() => createValidator(doc("3.1.0", get([null])))).not.toThrow();
  });

  it("ignores a parameters field that is not a list", () => {
    // A different defect, reported by the hygiene lint. Throwing here
    // would put a less useful error ahead of the one that names it, and
    // `@oaverify/check` has a case pinning that the document stays
    // gradeable.
    const spec = doc("3.1.0", {
      get: { parameters: {}, responses: { "200": { description: "ok" } } },
    });
    expect(() => createValidator(spec)).not.toThrow();
  });

  it("has nothing to check in a response header position", () => {
    // A Header Object carries no `in` (it is implied by the position),
    // so an unserved location is unreachable there. A response header
    // literally named "in" is a header name, not a location.
    const validator = createValidator(
      doc("3.1.0", {
        get: {
          responses: {
            "200": { description: "ok", headers: { in: { schema: stringSchema } } },
          },
        },
      }),
    );
    expect(
      validator.validateResponse(
        { method: "GET", path: "/t" },
        { status: 200, headers: { in: "x" } },
      ),
    ).toEqual({ valid: true });
  });
});

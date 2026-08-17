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

describe("what review narrowed the gate to leave alone", () => {
  // Three corrections from the verification pass on 7443697.
  const build = (doc: unknown): string => {
    try {
      createValidator(doc as never);
      return "built";
    } catch (e) {
      return (e as Error).message;
    }
  };

  it("keeps a path item whose parameters no operation can inherit", () => {
    // No method field, so the router never matches it and the
    // parameters are read nowhere. Same rule the `$ref`'d Path Item
    // exemption rests on.
    expect(
      build({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/t": { description: "no operations here", parameters: [{ name: "p", in: "body" }] },
        },
      }),
    ).toBe("built");
  });

  it("still refuses a path item parameter an operation does inherit", () => {
    expect(
      build({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/t": {
            parameters: [{ name: "p", in: "body" }],
            get: { responses: { "200": { description: "ok" } } },
          },
        },
      }),
    ).toContain('path item /t declares parameter "p"');
  });

  it("says the field is present when it is present and not a string", () => {
    for (const [location, rendered] of [
      [null, "null"],
      [42, "42"],
      [{ in: "query" }, '{"in":"query"}'],
    ] as const) {
      const message = build({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/t": {
            get: {
              parameters: [{ name: "p", in: location }],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      });
      expect(message).toContain(`with in: ${rendered}`);
      expect(message).not.toContain('no "in" field');
    }
  });

  it("keeps a spec-supplied location on one line", () => {
    // The value is the document's, not ours. Interpolated between
    // quotes of our own it broke the message across two lines and left
    // the quotes unbalanced.
    const message = build({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/t": {
          get: {
            parameters: [{ name: "p", in: 'q"\nx' }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(message).not.toContain("\n");
    expect(message).toContain('with in: "q\\"\\nx"');
  });

  it('reports an absent "in" as absent', () => {
    expect(
      build({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/t": {
            get: { parameters: [{ name: "p" }], responses: { "200": { description: "ok" } } },
          },
        },
      }),
    ).toContain('with no "in" field');
  });
});

describe("a $ref'd path item", () => {
  it("is exempt when the entry declares no method of its own", () => {
    // The router reads methods off the entry, so a bare `$ref` entry is
    // never matched and its target's parameters cannot reach a request.
    expect(() =>
      createValidator({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: { "/t": { $ref: "#/components/pathItems/P" } },
        components: {
          pathItems: {
            P: {
              get: {
                parameters: [{ name: "b", in: "body", required: true, schema: {} }],
                responses: { "200": { description: "ok" } },
              },
            },
          },
        },
      } as never),
    ).not.toThrow();
  });

  it("is not exempt for a method the entry declares beside the $ref", () => {
    // `methodsDeclaredOn` reads the entry's own keys, so POST is routed
    // and its parameter is read. Skipping the whole entry let that
    // parameter reach `validateParameter`, which threw at request time:
    // the failure this module exists to turn into a refusal.
    expect(() =>
      createValidator({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/t": {
            $ref: "#/components/pathItems/P",
            post: {
              parameters: [{ name: "b", in: "body", required: true, schema: {} }],
              responses: { "200": { description: "ok" } },
            },
          },
        },
        components: { pathItems: { P: { get: { responses: { "200": { description: "ok" } } } } } },
      } as never),
    ).toThrow('with in: "body"');
  });
});

describe("a $ref the gate cannot follow", () => {
  // The gate resolves every parameter ref to read its `in`. Raising on
  // one it cannot follow made a stale pointer on an unrouted operation
  // a startup failure, which is a wider claim than this module makes.
  it("builds, and leaves the pointer to the passes that can locate it", () => {
    const v = createValidator({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/good": {
          get: {
            parameters: [{ name: "p", in: "query", schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
        "/bad": {
          get: {
            parameters: [{ $ref: "#/components/parameters/Nope" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as never);
    const r = v.validateRequest({ method: "GET", path: "/good?p=x" } as never) as {
      valid: boolean;
    };
    expect(r.valid).toBe(true);
  });

  it("still refuses an unserved location reached through a ref that resolves", () => {
    expect(() =>
      createValidator({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/t": {
            get: {
              parameters: [{ $ref: "#/components/parameters/Bad" }],
              responses: { "200": { description: "ok" } },
            },
          },
        },
        components: { parameters: { Bad: { name: "p", in: "body", schema: {} } } },
      } as never),
    ).toThrow('with in: "body"');
  });
});

describe("the message renders a value it did not write", () => {
  // Each of these came out of a review round as a fix with no test.
  const message = (parameter: Record<string, unknown>): string => {
    try {
      createValidator({
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/t": { get: { parameters: [parameter], responses: { "200": { description: "ok" } } } },
        },
      } as never);
      return "built";
    } catch (e) {
      return (e as Error).message;
    }
  };

  it("renders a value JSON cannot serialize as its type, rather than raising", () => {
    // `JSON.stringify` throws on both. A gate whose purpose is to
    // replace an opaque TypeError cannot raise one of its own.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(message({ name: "p", in: circular })).toContain("with in: a value of type object");
    expect(message({ name: "p", in: 10n })).toContain("with in: a value of type bigint");
  });

  it("gives a length for a long value instead of an unbalanced quote", () => {
    const long = "x".repeat(200);
    const m = message({ name: "p", in: long });
    expect(m).toContain("a string of 202 characters");
    // The defect this replaced: `"xxx...` with the quote never closed.
    expect(m).not.toContain(`"${long.slice(0, 40)}`);
  });

  it("names a parameter whose name is present and not a string", () => {
    const m = message({ name: 42, in: "body" });
    expect(m).toContain("declares parameter 42");
    expect(m).not.toContain("unnamed");
  });
});

describe('unservedParameterLocations: "ignore"', () => {
  // The exemption `@oaverify/check` uses. Its TSDoc said requests were
  // skipped; they throw, and review caught the claim rather than the
  // code, so the claim is pinned now.
  const doc = {
    openapi: "3.2.0",
    info: { title: "t", version: "1" },
    paths: {
      "/t": {
        get: {
          parameters: [{ name: "q", in: "querystring", content: { "text/plain": { schema: {} } } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };

  it("builds where the default refuses", () => {
    expect(() => createValidator(doc as never)).toThrow('with in: "querystring"');
    expect(() =>
      createValidator(doc as never, { unservedParameterLocations: "ignore" }),
    ).not.toThrow();
  });

  it("still refuses to answer a request for that operation", () => {
    const v = createValidator(doc as never, { unservedParameterLocations: "ignore" });
    // Not a verdict: answering would report a request valid on a
    // parameter nothing checked, which is what the gate exists to stop.
    expect(() => v.validateRequest({ method: "GET", path: "/t" } as never)).toThrow(
      'declares in: "querystring"',
    );
  });

  it("describes an absent in with prose rather than a rendered undefined", () => {
    const mutable = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/t": {
          get: {
            parameters: [{ name: "p", in: "query", schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const v = createValidator(mutable as never);
    // The residual arm's own case: the document changed after
    // construction, so the gate never saw this.
    delete (mutable.paths["/t"].get.parameters[0] as { in?: string }).in;
    expect(() => v.validateRequest({ method: "GET", path: "/t?p=x" } as never)).toThrow(
      'no "in" field',
    );
  });
});

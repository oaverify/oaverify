import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { emitSpec } from "../src/emit-spec.js";

/**
 * A parameter location the emitted validator cannot read a value for
 * (#829, following the runtime policy in #836).
 *
 * `emitSpec` is its own construction path: it walks the document and
 * compiles schemas without calling `createValidator`, so the runtime's
 * gate never ran here. What the emitted module did instead is the
 * reason this refuses rather than warns. `__readParamRaw` returned
 * `undefined` for an unrecognised `in`, so a required parameter was
 * reported as `missing required querystring parameter "q"` under code
 * `cookie-param` (the chained ternary's last arm) on a request that
 * carried the value, and an optional one was skipped and the request
 * called valid.
 *
 * The refusal is scoped to the operations actually emitted, where
 * `createValidator` refuses document-wide. See the `--only` cases.
 */

const stringSchema = { type: "string" };

const doc = (
  paths: Record<string, unknown>,
  components?: Record<string, unknown>,
): OpenAPIDocument =>
  ({
    openapi: "3.2.0",
    info: { title: "t", version: "1" },
    paths,
    ...(components === undefined ? {} : { components }),
  }) as unknown as OpenAPIDocument;

const op = (parameters: unknown[]): Record<string, unknown> => ({
  parameters,
  responses: { "200": { description: "ok" } },
});

describe("emitSpec refuses an unserved parameter location", () => {
  it("refuses a required querystring parameter, in the runtime's words", () => {
    expect(() =>
      emitSpec(
        doc({
          "/t": {
            get: op([{ name: "q", in: "querystring", required: true, schema: stringSchema }]),
          },
        }),
      ),
    ).toThrow(
      'GET /t declares parameter "q" with in: "querystring", a location this validator ' +
        "does not serve. It is legal in OpenAPI 3.2 and is not implemented here. Remove the " +
        "parameter, or declare it in query, header, path or cookie.",
    );
  });

  it("refuses an optional one, which used to emit a validator that accepted everything", () => {
    expect(() =>
      emitSpec(
        doc({ "/t": { get: op([{ name: "q", in: "querystring", schema: stringSchema }]) } }),
      ),
    ).toThrow(/in: "querystring"/);
  });

  it("refuses a Swagger 2.0 body parameter, pointing at requestBody", () => {
    expect(() =>
      emitSpec(
        doc({
          "/t": { post: op([{ name: "b", in: "body", required: true, schema: stringSchema }]) },
        }),
      ),
    ).toThrow(/POST \/t declares parameter "b" with in: "body".*becomes requestBody\./s);
  });

  it("refuses formData", () => {
    expect(() =>
      emitSpec(doc({ "/t": { post: op([{ name: "f", in: "formData", schema: stringSchema }]) } })),
    ).toThrow(/formData parameter becomes requestBody with a form media type/);
  });

  it("refuses one behind a $ref", () => {
    expect(() =>
      emitSpec(
        doc(
          { "/t": { get: op([{ $ref: "#/components/parameters/Bad" }]) } },
          {
            parameters: { Bad: { name: "p", in: "body", required: true, schema: stringSchema } },
          },
        ),
      ),
    ).toThrow(/GET \/t declares parameter "p" with in: "body"/);
  });

  it("refuses a Path Item parameter, against the operation that inherits it", () => {
    // Reported against the operation rather than the path item: the
    // emitted unit is the operation, and this refusal is scoped to the
    // operations emitted, so the operation is the address that explains
    // why the emit stopped.
    expect(() =>
      emitSpec(
        doc({
          "/t": {
            parameters: [{ name: "p", in: "querystring", required: true, schema: stringSchema }],
            get: op([]),
          },
        }),
      ),
    ).toThrow(/GET \/t declares parameter "p" with in: "querystring"/);
  });

  it("refuses when an unserved name collides with a real cookie parameter", () => {
    expect(() =>
      emitSpec(
        doc({
          "/t": {
            get: op([
              { name: "sid", in: "cookie", required: true, schema: stringSchema },
              { name: "sid", in: "querystring", required: true, schema: stringSchema },
            ]),
          },
        }),
      ),
    ).toThrow(/parameter "sid" with in: "querystring"/);
  });

  it("emits a document whose parameters are all served", () => {
    const source = emitSpec(
      doc({
        "/t": { get: op([{ name: "p", in: "query", required: true, schema: stringSchema }]) },
      }),
    );
    expect(source).toContain("validateRequest");
  });
});

describe("--only scopes the refusal to what is emitted", () => {
  const twoOperations = doc({
    "/good": { get: op([{ name: "p", in: "query", required: true, schema: stringSchema }]) },
    "/bad": { get: op([{ name: "q", in: "querystring", required: true, schema: stringSchema }]) },
  });

  it("refuses when the offending operation is emitted", () => {
    expect(() =>
      emitSpec(twoOperations, {
        only: [
          { method: "GET", path: "/good" },
          { method: "GET", path: "/bad" },
        ],
      }),
    ).toThrow(/GET \/bad declares parameter "q"/);
  });

  it("emits when the offending operation is filtered out", () => {
    // The emitted module answers 404 for a filtered-out operation, so
    // its parameters never reach a verdict and there is no false
    // "valid" to prevent. This is the one place round 2 differs from
    // round 1's document-wide refusal, and the difference follows from
    // `--only` changing what the artifact claims.
    const source = emitSpec(twoOperations, { only: [{ method: "GET", path: "/good" }] });
    expect(source).toContain("validateRequest");
    expect(source).not.toContain("querystring");
  });

  it("emits when every operation inheriting an unserved Path Item parameter is filtered out", () => {
    const inherited = doc({
      "/good": { get: op([{ name: "p", in: "query", required: true, schema: stringSchema }]) },
      "/bad": {
        parameters: [{ name: "q", in: "querystring", required: true, schema: stringSchema }],
        get: op([]),
        post: op([]),
      },
    });
    expect(() => emitSpec(inherited, { only: [{ method: "GET", path: "/good" }] })).not.toThrow();
    expect(() => emitSpec(inherited, { only: [{ method: "POST", path: "/bad" }] })).toThrow(
      /POST \/bad declares parameter "q"/,
    );
  });
});

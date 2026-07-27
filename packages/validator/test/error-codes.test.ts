import {
  BUILT_IN_ERROR_CODES,
  SELF_LOCATING_ERROR_CODES,
  walkErrors,
  type OpenAPIDocument,
  type ValidationError,
} from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator, leafCodes } from "./fixtures.js";

/**
 * Cross-check between actual emitted error codes and the documented
 * registry {@link BUILT_IN_ERROR_CODES}. The validator and the compiler
 * emit codes through generated JS / string literals, so TypeScript
 * cannot enforce the contract. This test walks a representative fixture
 * corpus, collects every emitted code, and asserts:
 *
 *   - every observed code is documented in BUILT_IN_ERROR_CODES
 *   - every HTTP-layer named code is observed at least once
 *
 * Adding a new keyword or HTTP-layer wrapper should force a PR update
 * here; otherwise the `BuiltInErrorParams` contract silently drifts.
 */

function collectCodes(err: ValidationError | null): Set<string> {
  const out = new Set<string>();
  if (err === null) return out;
  walkErrors(err, (e) => {
    out.add(e.code);
  });
  return out;
}

function sampleSpec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "x", version: "1" },
    paths: {
      "/items/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        get: {
          parameters: [
            { name: "fields", in: "query", schema: { type: "string" } },
            { name: "X-Tenant", in: "header", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "integer" } },
                  },
                },
              },
            },
          },
        },
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: { name: { type: "string", minLength: 2 } },
                },
              },
            },
          },
          responses: {
            "200": { description: "ok" },
          },
        },
      },
    },
  };
}

describe("BuiltInErrorParams registry cross-check", () => {
  it("all observed emitted codes are documented in BUILT_IN_ERROR_CODES", () => {
    const v = createValidator(sampleSpec());
    const observed = new Set<string>();

    // Route miss.
    collectCodes(v.validateRequest({ method: "DELETE", path: "/nope" })).forEach((c) =>
      observed.add(c),
    );
    // Missing required body.
    collectCodes(
      v.validateRequest({ method: "POST", path: "/items/1", contentType: "application/json" }),
    ).forEach((c) => observed.add(c));
    // Wrong content type.
    collectCodes(
      v.validateRequest({
        method: "POST",
        path: "/items/1",
        contentType: "text/plain",
        body: "x",
      }),
    ).forEach((c) => observed.add(c));
    // Path param not an integer, missing required header, body field too short.
    collectCodes(
      v.validateRequest({
        method: "POST",
        path: "/items/abc",
        contentType: "application/json",
        body: { name: "x" },
      }),
    ).forEach((c) => observed.add(c));
    // Query validated + missing required header.
    collectCodes(
      v.validateRequest({
        method: "GET",
        path: "/items/1",
        query: { fields: "id" },
      }),
    ).forEach((c) => observed.add(c));
    // Response-side: unknown status.
    collectCodes(v.validateResponse({ method: "GET", path: "/items/1" }, { status: 500 })).forEach(
      (c) => observed.add(c),
    );
    // Response-side: content-type mismatch.
    collectCodes(
      v.validateResponse(
        { method: "GET", path: "/items/1" },
        { status: 200, contentType: "text/plain", body: "x" },
      ),
    ).forEach((c) => observed.add(c));
    // Response-side: body schema violation.
    collectCodes(
      v.validateResponse(
        { method: "GET", path: "/items/1" },
        { status: 200, contentType: "application/json", body: { id: "not-a-number" } },
      ),
    ).forEach((c) => observed.add(c));

    const documented = new Set<string>(BUILT_IN_ERROR_CODES);
    const undocumented = [...observed].filter((c) => !documented.has(c));
    expect(undocumented).toEqual([]);
  });

  it("HTTP-layer wrapper codes that are reachable via validateRequest/Response all appear", () => {
    // Sanity check: codes emitted for missing/malformed HTTP inputs
    // (those that don't require a contrived content:application/json
    // parameter configuration) should all be reachable from simple
    // requests. Bidirectional coverage across rarer codes
    // (path-param / cookie-param, which only fire on content-JSON
    // parameter deserialisation failures) is intentionally not
    // enforced; the forward check above already catches undocumented
    // emissions, which is the drift mode that actually bites consumers.
    const v = createValidator(sampleSpec());
    const observed = new Set<string>();
    const collect = (e: ValidationError | null): void => {
      if (e !== null) walkErrors(e, (leaf) => observed.add(leaf.code));
    };

    collect(v.validateRequest({ method: "DELETE", path: "/nope" })); // route
    collect(v.validateRequest({ method: "DELETE", path: "/items/1" })); // method (405)
    collect(
      v.validateRequest({ method: "POST", path: "/items/1", contentType: "application/json" }),
    ); // body (missing required)
    collect(
      v.validateRequest({
        method: "POST",
        path: "/items/1",
        contentType: "text/plain",
        body: "x",
      }),
    ); // content-type
    collect(
      v.validateRequest({
        method: "POST",
        path: "/items/abc",
        contentType: "application/json",
        body: { name: "x" },
      }),
    ); // request
    collect(
      v.validateRequest({
        method: "GET",
        path: "/items/1",
        // X-Tenant required, omitted → header-param (missing)
      }),
    );
    collect(v.validateResponse({ method: "GET", path: "/items/1" }, { status: 500 })); // response + status

    for (const code of [
      "route",
      "method",
      "body",
      "content-type",
      "request",
      "header-param",
      "response",
      "status",
    ]) {
      expect(observed).toContain(code);
    }
  });

  it("emits the full documented params shape for the wrappers most prone to drift", () => {
    const v = createValidator(sampleSpec());

    const e = v.validateRequest({
      method: "POST",
      path: "/items/abc",
      contentType: "application/json",
      body: { name: "x" },
    });
    expect(e).not.toBeNull();
    // `request` branch must carry method + pathPattern, the documented
    // shape that drifted previously.
    expect(e?.code).toBe("request");
    expect(e?.params).toEqual({ method: "POST", pathPattern: "/items/{id}" });
  });

  it("HTTP-layer emitted params conform to BuiltInErrorParams shapes", () => {
    // Declared required keys per HTTP-layer code. Runtime assertion
    // that the validator's emitted params include every documented key.
    // Errors are emitted imperatively (not through generated JS), so
    // TypeScript can't enforce the contract; this test is the backstop.
    const requiredKeys: Record<string, readonly string[]> = {
      route: ["method", "path"],
      method: ["method", "pathPattern", "allowed"],
      request: ["method", "pathPattern"],
      response: ["status"],
      status: ["status"],
      "content-type": ["contentType"],
      body: [],
      "query-param": ["name", "in"],
      "header-param": ["name", "in"],
    };

    const findLeaf = (err: ValidationError | null, code: string): ValidationError | undefined => {
      if (err === null) return undefined;
      let hit: ValidationError | undefined;
      walkErrors(err, (node) => {
        if (hit === undefined && node.code === code) hit = node;
      });
      return hit;
    };

    const check = (err: ValidationError | null, code: string): void => {
      const node = findLeaf(err, code);
      expect(node, `expected code=${code} in fixture`).toBeDefined();
      for (const key of requiredKeys[code] ?? []) {
        expect(node?.params, `code=${code} missing param '${key}'`).toHaveProperty(key);
      }
    };

    // Fixture corpus that surfaces each HTTP-layer code at least once.
    const specStrict = sampleSpec();
    const v = createValidator(specStrict, { strictQueryParameters: true });
    const vWithResponseHeader = createValidator({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/r": {
          get: {
            responses: {
              "200": {
                description: "ok",
                headers: { "X-Rate": { required: true, schema: { type: "string" } } },
              },
            },
          },
        },
      },
    });

    check(v.validateRequest({ method: "DELETE", path: "/nope" }), "route");
    // Path /items/{id} exists but declares only GET + POST; DELETE is 405.
    check(v.validateRequest({ method: "DELETE", path: "/items/1" }), "method");
    check(
      v.validateRequest({
        method: "POST",
        path: "/items/1",
        contentType: "application/json",
      }),
      "body",
    );
    check(
      v.validateRequest({
        method: "POST",
        path: "/items/1",
        contentType: "text/plain",
        body: "x",
      }),
      "content-type",
    );
    check(
      v.validateRequest({
        method: "POST",
        path: "/items/abc",
        contentType: "application/json",
        body: { name: "x" },
      }),
      "request",
    );
    // path-param / cookie-param only surface as leaves on missing-
    // required parameter values. Path params can't be missing on a
    // matched route (they're in the URL); cookie-param is similarly
    // unreachable from a simple fixture. Present-but-invalid path /
    // cookie values bubble up as schema leaves (`type`, etc.), not the
    // `*-param` wrapper. Declared shape trusted by construction
    // (same `{ name, in }` builder as the reachable siblings).
    check(v.validateRequest({ method: "GET", path: "/items/1" }), "header-param");
    // Strict query parameters: unknown key triggers query-param.
    check(
      v.validateRequest({
        method: "GET",
        path: "/items/1",
        headers: { "x-tenant": "t1" },
        query: { bogus: "x" },
      }),
      "query-param",
    );
    check(v.validateResponse({ method: "GET", path: "/items/1" }, { status: 500 }), "response");
    check(v.validateResponse({ method: "GET", path: "/items/1" }, { status: 500 }), "status");
    // Response-side missing required header; must carry name + in.
    check(
      vWithResponseHeader.validateResponse(
        { method: "GET", path: "/r" },
        { status: 200, headers: {} },
      ),
      "header-param",
    );
  });
});

describe("self-locating message contract (SELF_LOCATING_ERROR_CODES)", () => {
  // The contract documented on SELF_LOCATING_ERROR_CODES: every leaf
  // emitted under one of these codes locates the error in its message
  // alone, so formatSummary's `path: "auto"` drops no information. A
  // message-wording change that stops naming the location must fail
  // here, not regress downstream renderers silently. The corpus drives
  // every code in the set, including the rarer *-param modes (cookie
  // missing, path-param content-parse).

  function contractSpec(): OpenAPIDocument {
    return {
      openapi: "3.1.0",
      info: { title: "contract", version: "1" },
      components: {
        securitySchemes: {
          ApiKey: { type: "apiKey", name: "X-Api-Key", in: "header" },
        },
      },
      paths: {
        "/items/{id}": {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          get: {
            parameters: [
              { name: "fields", in: "query", required: true, schema: { type: "string" } },
              { name: "X-Tenant", in: "header", required: true, schema: { type: "string" } },
              { name: "session", in: "cookie", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "ok",
                headers: { "X-Rate": { required: true, schema: { type: "string" } } },
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
          post: {
            requestBody: {
              required: true,
              content: { "application/json": { schema: { type: "object" } } },
            },
            responses: { "200": { description: "ok" } },
          },
        },
        "/blob/{data}": {
          get: {
            parameters: [
              {
                name: "data",
                in: "path",
                required: true,
                content: { "application/json": { schema: { type: "object" } } },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
        "/secure": {
          get: { security: [{ ApiKey: [] }], responses: { "200": { description: "ok" } } },
        },
      },
    };
  }

  function namesItsLocation(leaf: ValidationError): boolean {
    switch (leaf.code) {
      // Empty-path codes: there is no prefix to drop.
      case "route":
      case "method":
      case "status":
        return leaf.path.length === 0;
      case "body":
        return leaf.message.includes("body");
      case "content-type":
        return leaf.message.includes("Content-Type");
      case "security":
        return leaf.message.includes("security");
      // *-param: the message quotes the parameter name.
      default:
        return leaf.message.includes(`"${String((leaf.params as { name?: unknown }).name)}"`);
    }
  }

  it("every emitted self-locating leaf names its location in its message", () => {
    const selfLocating = new Set<string>(SELF_LOCATING_ERROR_CODES);
    const v = createValidator(contractSpec(), {
      strictQueryParameters: true,
      validateSecurity: "shape",
    });
    const trees: (ValidationError | null)[] = [
      v.validateRequest({ method: "GET", path: "/nope" }), // route
      v.validateRequest({ method: "DELETE", path: "/items/1" }), // method
      // query-param / header-param / cookie-param, all missing-required.
      v.validateRequest({ method: "GET", path: "/items/1" }),
      // query-param, unknown-key mode under strictQueryParameters.
      v.validateRequest({
        method: "GET",
        path: "/items/1",
        query: { fields: "id", bogus: "x" },
        headers: { "x-tenant": "t" },
        cookies: { session: "s" },
      }),
      v.validateRequest({ method: "POST", path: "/items/1", contentType: "application/json" }), // body
      v.validateRequest({
        method: "POST",
        path: "/items/1",
        contentType: "text/plain",
        body: "x",
      }), // content-type (request)
      v.validateRequest({ method: "GET", path: "/blob/not-json" }), // path-param (content-parse)
      v.validateRequest({ method: "GET", path: "/secure" }), // security
      v.validateResponse({ method: "GET", path: "/items/1" }, { status: 500 }), // status
      v.validateResponse(
        { method: "GET", path: "/items/1" },
        { status: 200, contentType: "text/plain", body: "x", headers: { "x-rate": "1" } },
      ), // content-type (response)
      v.validateResponse(
        { method: "GET", path: "/items/1" },
        { status: 200, contentType: "application/json", body: {}, headers: {} },
      ), // header-param (response, missing required header)
    ];

    const observed = new Set<string>();
    for (const tree of trees) {
      if (tree === null) continue;
      walkErrors(tree, (node) => {
        if (!selfLocating.has(node.code)) return;
        observed.add(node.code);
        expect(node.children, `code=${node.code} must only appear as a leaf`).toEqual([]);
        expect(
          namesItsLocation(node),
          `code=${node.code} message '${node.message}' does not name its location`,
        ).toBe(true);
      });
    }

    // Bidirectional: the corpus must actually surface every code in the
    // set, so a new entry added without a reachable emission (or a
    // fixture gone stale) fails loudly.
    for (const code of SELF_LOCATING_ERROR_CODES) {
      expect([...observed], `fixture corpus did not surface code=${code}`).toContain(code);
    }
  });

  it("parameter value failures surface as schema-keyword codes, never *-param", () => {
    // The other half of the contract: a *-param code never carries a
    // generic value-error message. format / pattern / type failures on
    // a parameter, including deserialized deepObject members, keep
    // their keyword codes (where the path prefix is load-bearing).
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "v", version: "1" },
      paths: {
        "/search": {
          get: {
            parameters: [
              { name: "limit", in: "query", required: true, schema: { type: "integer" } },
              {
                name: "tag",
                in: "query",
                required: true,
                schema: { type: "string", pattern: "^[a-z]+$" },
              },
              {
                name: "filter",
                in: "query",
                required: true,
                style: "deepObject",
                explode: true,
                schema: {
                  type: "object",
                  required: ["depth"],
                  properties: { depth: { type: "integer" } },
                },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const v = createValidator(spec);
    const err = v.validateRequest({
      method: "GET",
      path: "/search",
      query: { limit: "abc", tag: "UPPER", "filter[depth]": "xyz" },
    });
    expect(err).not.toBeNull();
    const codes = leafCodes(err);
    expect(codes).toContain("type"); // limit=abc, filter[depth]=xyz
    expect(codes).toContain("pattern"); // tag=UPPER
    for (const code of codes) {
      expect(SELF_LOCATING_ERROR_CODES).not.toContain(code);
    }
  });
});

import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { combineValidators } from "../src/combine.js";
import { createValidator } from "../src/validator.js";

/**
 * `combineValidators` stacks several validators into one that dispatches
 * each request to the member owning its route. Dispatch keys on route
 * ownership (`matchRoute`), then delegates to the owner's
 * `validateRequest` / `validateResponse`, so a member's own
 * `ignoreUndocumented` / `ignorePaths` still fire after dispatch. A wrong
 * method on an owned path stays a 405 (delegated to the path's owner);
 * only a path no member owns is undocumented w.r.t. the composite,
 * governed by `CombineOptions.ignoreUndocumented`.
 */

function specA(): OpenAPIDocument {
  return {
    openapi: "3.0.3",
    info: { title: "A", version: "1" },
    paths: {
      "/a/items/{id}": {
        get: {
          operationId: "getItemA",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "q", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

function specB(): OpenAPIDocument {
  return {
    openapi: "3.0.3",
    info: { title: "B", version: "1" },
    paths: {
      "/b/widgets/{id}": {
        get: {
          operationId: "getWidgetB",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

function flat(r: ReturnType<ReturnType<typeof createValidator>["validateRequest"]>) {
  // Narrow the flat ValidationResult for assertions.
  return r as { valid: boolean; errors?: { code: string; path: string[] }[]; truncated?: boolean };
}

describe("combineValidators dispatch", () => {
  it("routes each request to the member that owns its path", () => {
    const v = combineValidators([createValidator(specA()), createValidator(specB())]);

    // Owned by A: real validation runs (q is required).
    expect(
      flat(v.validateRequest({ method: "GET", path: "/a/items/1", query: { q: "x" } })).valid,
    ).toBe(true);
    const missingQ = flat(v.validateRequest({ method: "GET", path: "/a/items/1", query: {} }));
    expect(missingQ.valid).toBe(false);

    // Owned by B.
    expect(flat(v.validateRequest({ method: "GET", path: "/b/widgets/7" })).valid).toBe(true);
  });

  it("first-match-wins: the earliest member owning a route handles it", () => {
    // Two specs declare the same path with different validation rules.
    const strict: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "strict", version: "1" },
      paths: {
        "/shared": {
          get: {
            operationId: "strict",
            parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const lax: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "lax", version: "1" },
      paths: {
        "/shared": { get: { operationId: "lax", responses: { "200": { description: "ok" } } } },
      },
    };

    const strictFirst = combineValidators([createValidator(strict), createValidator(lax)]);
    // strict owns it first -> q required -> fails without q.
    expect(
      flat(strictFirst.validateRequest({ method: "GET", path: "/shared", query: {} })).valid,
    ).toBe(false);

    const laxFirst = combineValidators([createValidator(lax), createValidator(strict)]);
    expect(
      flat(laxFirst.validateRequest({ method: "GET", path: "/shared", query: {} })).valid,
    ).toBe(true);
  });

  it("delegates to the owner so the owner's ignorePaths still fires after dispatch", () => {
    // A owns /a/items/{id} but skips it via its own ignorePaths. The
    // composite has no composite-level ignorePaths, so the only thing
    // that can make this pass is delegation reaching A's predicate.
    const a = createValidator(specA(), { ignorePaths: (p) => p === "/a/items/skipme" });
    const v = combineValidators([a, createValidator(specB())]);
    // Without the skip this would fail (q is required); the skip wins.
    expect(
      flat(v.validateRequest({ method: "GET", path: "/a/items/skipme", query: {} })).valid,
    ).toBe(true);
  });
});

describe("combineValidators method-not-allowed (405)", () => {
  // A wrong method on a path a member DOES own is a 405, not a 404, and
  // must reproduce single-validator semantics through the composite. The
  // dispatch keys on getOperation, which returns null for both 404 and
  // 405, so the composite has to distinguish "no member owns the path"
  // from "a member owns the path but not this method".
  function deleterSpec(): OpenAPIDocument {
    return {
      openapi: "3.0.3",
      info: { title: "deleter", version: "1" },
      paths: {
        "/a/items/{id}": {
          delete: { operationId: "deleteItem", responses: { "204": { description: "gone" } } },
        },
      },
    };
  }

  it("anchor: a standalone validator reports a method error for a wrong method", () => {
    const r = flat(
      createValidator(specA()).validateRequest({ method: "DELETE", path: "/a/items/1" }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]?.code).toBe("method");
  });

  it("preserves the 405 (method error, not a route/404) for a wrong method on an owned path", () => {
    const v = combineValidators([createValidator(specA()), createValidator(specB())]);
    const r = flat(v.validateRequest({ method: "DELETE", path: "/a/items/1" }));
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]?.code).toBe("method");
  });

  it("ignoreUndocumented does NOT suppress a 405 on a path a member owns", () => {
    // ignoreUndocumented governs paths no member owns. A wrong method on
    // an owned path is not undocumented; it must still fail, exactly as a
    // single validator does (whose method error is ungated).
    const v = combineValidators([createValidator(specA()), createValidator(specB())], {
      ignoreUndocumented: true,
    });
    const r = flat(v.validateRequest({ method: "DELETE", path: "/a/items/1" }));
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]?.code).toBe("method");
  });

  it("a real match in a later member still beats an earlier member's 405", () => {
    // specA owns GET /a/items/{id} (405s on DELETE); the deleter owns
    // DELETE on the same path structure. DELETE must reach the deleter.
    const v = combineValidators([createValidator(specA()), createValidator(deleterSpec())]);
    expect(flat(v.validateRequest({ method: "DELETE", path: "/a/items/1" })).valid).toBe(true);
  });

  it("preserves the 405 on the response side too", () => {
    const v = combineValidators([createValidator(specA()), createValidator(specB())]);
    const r = flat(
      v.validateResponse(
        { method: "DELETE", path: "/a/items/1" },
        { status: 204, contentType: "", body: undefined },
      ),
    );
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]?.code).toBe("method");
  });
});

describe("combineValidators no-owner policy", () => {
  it("defaults to a route error for a path no member owns", () => {
    const v = combineValidators([createValidator(specA()), createValidator(specB())]);
    const r = flat(v.validateRequest({ method: "POST", path: "/uploads" }));
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]?.code).toBe("route");
  });

  it("passes an undocumented path when ignoreUndocumented is true (upload-route bypass)", () => {
    const v = combineValidators([createValidator(specA()), createValidator(specB())], {
      ignoreUndocumented: true,
    });
    expect(flat(v.validateRequest({ method: "POST", path: "/uploads" })).valid).toBe(true);
  });

  it("composite ignorePaths short-circuits before dispatch, even for an owned route", () => {
    const v = combineValidators([createValidator(specA()), createValidator(specB())], {
      ignorePaths: (p) => p.startsWith("/b/"),
    });
    // B owns /b/widgets/{id} and would normally validate; the composite
    // predicate skips it first.
    expect(flat(v.validateRequest({ method: "GET", path: "/b/widgets/oops/extra" })).valid).toBe(
      true,
    );
  });
});

describe("combineValidators overlap detection", () => {
  it("onOverlap: error throws when two members declare the same route", () => {
    expect(() =>
      combineValidators([createValidator(specB()), createValidator(specB())], {
        onOverlap: "error",
      }),
    ).toThrow(/route overlap/);
  });

  it("onOverlap: error catches structural (parameter-name-only) overlap", () => {
    const byId: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "byId", version: "1" },
      paths: { "/x/{id}": { get: { responses: { "200": { description: "ok" } } } } },
    };
    const bySlug: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "bySlug", version: "1" },
      paths: { "/x/{slug}": { get: { responses: { "200": { description: "ok" } } } } },
    };
    expect(() =>
      combineValidators([createValidator(byId), createValidator(bySlug)], { onOverlap: "error" }),
    ).toThrow(/route overlap/);
  });

  it("onOverlap: error accepts disjoint members", () => {
    expect(() =>
      combineValidators([createValidator(specA()), createValidator(specB())], {
        onOverlap: "error",
      }),
    ).not.toThrow();
  });

  it("catches an implicit HEAD (from GET) colliding with another member's explicit HEAD", () => {
    // RFC 9110 §9.3.2: a GET resource also answers HEAD. The matcher
    // honours this at match time, so a member declaring GET /x/{id}
    // reserves the HEAD cell; a sibling declaring explicit HEAD /x/{slug}
    // is a real overlap that first-match would silently shadow.
    const getter: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "getter", version: "1" },
      paths: { "/x/{id}": { get: { responses: { "200": { description: "ok" } } } } },
    };
    const header: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "header", version: "1" },
      paths: { "/x/{slug}": { head: { responses: { "200": { description: "ok" } } } } },
    };
    expect(() =>
      combineValidators([createValidator(getter), createValidator(header)], { onOverlap: "error" }),
    ).toThrow(/route overlap/);
  });

  it("does not false-positive when a member declares both GET and explicit HEAD on a path", () => {
    // The synthetic HEAD must not be added when an explicit HEAD already
    // exists, or a single member would appear to overlap itself.
    const both: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "both", version: "1" },
      paths: {
        "/x/{id}": {
          get: { responses: { "200": { description: "ok" } } },
          head: { responses: { "200": { description: "ok" } } },
        },
      },
    };
    expect(() =>
      combineValidators([createValidator(both), createValidator(specB())], { onOverlap: "error" }),
    ).not.toThrow();
  });

  it("does not treat an implicit HEAD as colliding with a disjoint path's HEAD", () => {
    const getter: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "getter", version: "1" },
      paths: { "/x/{id}": { get: { responses: { "200": { description: "ok" } } } } },
    };
    const otherHead: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "otherHead", version: "1" },
      paths: { "/y/{id}": { head: { responses: { "200": { description: "ok" } } } } },
    };
    expect(() =>
      combineValidators([createValidator(getter), createValidator(otherHead)], {
        onOverlap: "error",
      }),
    ).not.toThrow();
  });

  it("disjoint methods on the same path structure do not overlap", () => {
    const getter: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "g", version: "1" },
      paths: { "/x/{id}": { get: { responses: { "200": { description: "ok" } } } } },
    };
    const poster: OpenAPIDocument = {
      openapi: "3.0.3",
      info: { title: "p", version: "1" },
      paths: { "/x/{other}": { post: { responses: { "201": { description: "ok" } } } } },
    };
    expect(() =>
      combineValidators([createValidator(getter), createValidator(poster)], { onOverlap: "error" }),
    ).not.toThrow();
  });
});

describe("combineValidators construction guards", () => {
  it("throws on an empty array", () => {
    expect(() => combineValidators([])).toThrow(/at least one validator/);
  });

  it("throws when members disagree on output mode", () => {
    const flatV = createValidator(specA());
    const treeV = createValidator(specB(), { output: "tree" });
    expect(() => combineValidators([flatV, treeV as never])).toThrow(/share an output mode/);
  });
});

describe("combineValidators introspection", () => {
  it("concatenates member routes", () => {
    const v = combineValidators([createValidator(specA()), createValidator(specB())]);
    expect(v.routes).toEqual([
      { method: "GET", pathPattern: "/a/items/{id}" },
      { method: "GET", pathPattern: "/b/widgets/{id}" },
    ]);
    expect(Object.isFrozen(v.routes)).toBe(true);
  });

  it("getOperation resolves through the owning member", () => {
    const v = combineValidators([createValidator(specA()), createValidator(specB())]);
    expect(v.getOperation({ method: "GET", path: "/b/widgets/9" })?.operation.operationId).toBe(
      "getWidgetB",
    );
    expect(v.getOperation({ method: "GET", path: "/nope" })).toBeNull();
  });

  it("reports the shared detectedVersion, or undefined when members disagree", () => {
    const same = combineValidators([createValidator(specA()), createValidator(specB())]);
    expect(same.detectedVersion).toBe("3.0");

    const mixed = combineValidators([
      createValidator(specA()),
      createValidator({ ...specB(), openapi: "3.1.0" }),
    ]);
    expect(mixed.detectedVersion).toBeUndefined();
  });

  it("aggregates stats live as members lazily compile response bodies", () => {
    const v = combineValidators([createValidator(specA()), createValidator(specB())]);
    expect(v.stats.responseBodiesCompiled).toBe(0);
    // Drive a response-body compile on member B.
    v.validateResponse(
      { method: "GET", path: "/b/widgets/1" },
      { status: 200, contentType: "application/json", body: { id: "ok" } },
    );
    expect(v.stats.responseBodiesCompiled).toBe(1);
  });
});

describe("combineValidators output modes", () => {
  it("preserves tree output across the composite", () => {
    const v = combineValidators([
      createValidator(specA(), { output: "tree" }),
      createValidator(specB(), { output: "tree" }),
    ]);
    const owned = v.validateRequest({ method: "GET", path: "/a/items/1", query: { q: "x" } });
    expect(owned).toEqual({ valid: true });
    const noOwner = v.validateRequest({ method: "GET", path: "/nope" }) as {
      valid: boolean;
      error?: { code: string };
    };
    expect(noOwner.valid).toBe(false);
    expect(noOwner.error?.code).toBe("route");
  });

  it("preserves predicate output across the composite", () => {
    const v = combineValidators([
      createValidator(specA(), { output: "predicate" }),
      createValidator(specB(), { output: "predicate" }),
    ]);
    expect(v.validateRequest({ method: "GET", path: "/a/items/1", query: { q: "x" } })).toBe(true);
    expect(v.validateRequest({ method: "GET", path: "/a/items/1", query: {} })).toBe(false);
    expect(v.validateRequest({ method: "GET", path: "/nope" })).toBe(false);
  });
});

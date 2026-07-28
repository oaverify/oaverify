import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import {
  applyOverlays,
  isSpecOverlay,
  specOverlayVerbs,
  type SpecOverlay,
} from "../src/overlay.js";
import { notRef } from "./helpers.js";

function base(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "X", version: "1" },
    paths: {
      "/pets": {
        get: {
          parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
          responses: { "200": { description: "ok" } },
        },
        post: {
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: { "201": { description: "created" } },
        },
      },
    },
    components: {
      schemas: {
        Pet: { type: "object", properties: { name: { type: "string" } } },
      },
    },
  };
}

describe("applyOverlays", () => {
  it("addPaths inserts new paths and rejects conflicts", () => {
    const patched = applyOverlays(base(), [
      {
        addPaths: {
          "/vets": { get: { responses: { "200": { description: "ok" } } } },
        },
      },
    ]);
    expect(patched.paths?.["/vets"]).toBeDefined();
    expect(() =>
      applyOverlays(base(), [
        { addPaths: { "/pets": { get: { responses: { "200": { description: "dup" } } } } } },
      ]),
    ).toThrow(/already exists/);
  });

  it("overrides.upsertParameters appends new and replaces by (name, in)", () => {
    const patched = applyOverlays(base(), [
      {
        overrides: {
          "/pets": {
            operations: {
              get: {
                upsertParameters: [
                  { name: "limit", in: "query", schema: { type: "string" } },
                  { name: "X-Tenant", in: "header", schema: { type: "string" } },
                ],
              },
            },
          },
        },
      },
    ]);
    const params = patched.paths?.["/pets"]?.get?.parameters ?? [];
    expect(params).toHaveLength(2);
    const byKey = Object.fromEntries(params.map((p) => [`${notRef(p).in}:${notRef(p).name}`, p]));
    expect(notRef(byKey["query:limit"]!).schema).toEqual({ type: "string" });
    expect(byKey["header:X-Tenant"]).toBeDefined();
  });

  it("overrides with wildcard `*` path applies to every path", () => {
    const patched = applyOverlays(base(), [
      {
        overrides: {
          "*": {
            operations: {
              get: {
                upsertParameters: [{ name: "trace", in: "header", schema: { type: "string" } }],
              },
            },
          },
        },
      },
    ]);
    const params = patched.paths?.["/pets"]?.get?.parameters ?? [];
    expect(params.some((p) => notRef(p).name === "trace")).toBe(true);
  });

  it("extendSchemas wraps the existing schema in allOf", () => {
    const patched = applyOverlays(base(), [{ extendSchemas: { Pet: { required: ["name"] } } }]);
    const pet = patched.components?.schemas?.["Pet"];
    expect(pet).toMatchObject({ allOf: expect.any(Array) });
  });

  it("extendSchemas inserts the extension verbatim when the target schema doesn't exist", () => {
    // Pin the silent-create behavior explicitly so a future "throw on
    // missing target" change is a deliberate decision, not an accident.
    const patched = applyOverlays(base(), [
      { extendSchemas: { NewType: { type: "string", minLength: 1 } } },
    ]);
    expect(patched.components?.schemas?.["NewType"]).toEqual({
      type: "string",
      minLength: 1,
    });
  });

  it("overrides targeting an unknown (non-wildcard) path throws", () => {
    expect(() =>
      applyOverlays(base(), [
        {
          overrides: {
            "/missing": { operations: { get: { upsertParameters: [] } } },
          },
        },
      ]),
    ).toThrow(/overlay override targets unknown path/);
  });

  it("replaceSchemas fully replaces the entry", () => {
    const patched = applyOverlays(base(), [{ replaceSchemas: { Pet: { type: "string" } } }]);
    expect(patched.components?.schemas?.["Pet"]).toEqual({ type: "string" });
  });

  it("overlays apply in order: later wins", () => {
    const patched = applyOverlays(base(), [
      { replaceSchemas: { Pet: { type: "number" } } },
      { replaceSchemas: { Pet: { type: "string" } } },
    ]);
    expect(patched.components?.schemas?.["Pet"]).toEqual({ type: "string" });
  });

  it("removePaths drops the target path; missing target throws", () => {
    const patched = applyOverlays(base(), [{ removePaths: ["/pets"] }]);
    expect(patched.paths?.["/pets"]).toBeUndefined();

    expect(() => applyOverlays(base(), [{ removePaths: ["/missing"] }])).toThrow(
      /removePaths targets unknown path/,
    );
  });

  it("removeSchemas drops the target schema; missing target throws", () => {
    const patched = applyOverlays(base(), [{ removeSchemas: ["Pet"] }]);
    expect(patched.components?.schemas?.["Pet"]).toBeUndefined();

    expect(() => applyOverlays(base(), [{ removeSchemas: ["Missing"] }])).toThrow(
      /removeSchemas targets unknown schema/,
    );
  });

  it("addPaths + removePaths naming the same path in one overlay throws", () => {
    expect(() =>
      applyOverlays(base(), [
        {
          addPaths: { "/foo": { get: { responses: { "200": { description: "ok" } } } } },
          removePaths: ["/foo"],
        },
      ]),
    ).toThrow(/self-conflict/);
  });

  it("replaceSchemas + removeSchemas naming the same schema in one overlay throws", () => {
    expect(() =>
      applyOverlays(base(), [
        { replaceSchemas: { Pet: { type: "string" } }, removeSchemas: ["Pet"] },
      ]),
    ).toThrow(/self-conflict/);
  });

  it("removeParameters drops by (name, in); missing entries silently no-op", () => {
    const patched = applyOverlays(base(), [
      {
        overrides: {
          "/pets": {
            operations: {
              get: {
                removeParameters: [
                  { name: "limit", in: "query" },
                  { name: "nope", in: "header" }, // not present → no-op
                ],
              },
            },
          },
        },
      },
    ]);
    expect(patched.paths?.["/pets"]?.get?.parameters ?? []).toHaveLength(0);
  });

  it("removeResponses drops status codes; missing entries silently no-op", () => {
    const patched = applyOverlays(base(), [
      {
        overrides: {
          "/pets": {
            operations: {
              post: { removeResponses: ["201", "404"] },
            },
          },
        },
      },
    ]);
    const responses = patched.paths?.["/pets"]?.post?.responses ?? {};
    expect(responses["201"]).toBeUndefined();
    expect(Object.keys(responses)).not.toContain("404");
  });

  it("operation-level replace: wholesale swap; conflict with additive fields throws", () => {
    const replacement = {
      operationId: "listPets",
      responses: { "200": { description: "fresh" } },
    };
    const patched = applyOverlays(base(), [
      { overrides: { "/pets": { operations: { get: { replace: replacement } } } } },
    ]);
    expect(patched.paths?.["/pets"]?.get).toEqual(replacement);
    // post unchanged
    expect(patched.paths?.["/pets"]?.post?.responses?.["201"]).toBeDefined();

    expect(() =>
      applyOverlays(base(), [
        {
          overrides: {
            "/pets": {
              operations: {
                get: {
                  replace: replacement,
                  upsertParameters: [{ name: "x", in: "header", schema: { type: "string" } }],
                },
              },
            },
          },
        },
      ]),
    ).toThrow(/replace cannot be combined with upsertParameters/);
  });
});

describe("applyOverlays: top-level verbs", () => {
  it("info shallow-merges into the document's info object", () => {
    const patched = applyOverlays(base(), [{ info: { description: "added", title: "renamed" } }]);
    expect(patched.info).toEqual({ title: "renamed", version: "1", description: "added" });
  });

  it("servers replaces wholesale; addServers appends", () => {
    const withServers = { ...base(), servers: [{ url: "https://a.example" }] };
    const replaced = applyOverlays(withServers, [{ servers: [{ url: "https://b.example" }] }]);
    expect(replaced.servers).toEqual([{ url: "https://b.example" }]);

    const appended = applyOverlays(withServers, [{ addServers: [{ url: "https://c.example" }] }]);
    expect(appended.servers).toEqual([{ url: "https://a.example" }, { url: "https://c.example" }]);
  });

  it("servers + addServers in one overlay throws", () => {
    expect(() =>
      applyOverlays(base(), [{ servers: [{ url: "a" }], addServers: [{ url: "b" }] }]),
    ).toThrow(/servers \(wholesale\) cannot combine with addServers/);
  });

  it("tags wholesale replaces; extendTags merges by name; replaceTags replaces by name; removeTags drops", () => {
    const withTags = {
      ...base(),
      tags: [{ name: "pets", description: "old" }],
    };
    const wholesale = applyOverlays(withTags, [{ tags: [{ name: "fresh" }] }]);
    expect(wholesale.tags).toEqual([{ name: "fresh" }]);

    const extended = applyOverlays(withTags, [
      { extendTags: [{ name: "pets", description: "new" }, { name: "new" }] },
    ]);
    expect(extended.tags).toEqual([{ name: "pets", description: "new" }, { name: "new" }]);

    const replaced = applyOverlays(withTags, [{ replaceTags: [{ name: "pets" }] }]);
    expect(replaced.tags).toEqual([{ name: "pets" }]);

    const removed = applyOverlays(withTags, [{ removeTags: ["pets"] }]);
    expect(removed.tags).toEqual([]);
  });

  it("removeTags throws on a missing tag name", () => {
    expect(() => applyOverlays(base(), [{ removeTags: ["nope"] }])).toThrow(
      /removeTags targets unknown tag nope/,
    );
  });

  it("tags wholesale + extendTags throws as a self-conflict", () => {
    expect(() =>
      applyOverlays(base(), [{ tags: [{ name: "a" }], extendTags: [{ name: "b" }] }]),
    ).toThrow(/tags \(wholesale\) cannot combine/);
  });

  it("replaceTags + removeTags naming the same tag throws", () => {
    expect(() =>
      applyOverlays(base(), [{ replaceTags: [{ name: "x" }], removeTags: ["x"] }]),
    ).toThrow(/self-conflict: replaceTags and removeTags both name x/);
  });

  it("security replaces; addSecurity appends; both in one overlay throws", () => {
    const replaced = applyOverlays(base(), [{ security: [{ apiKey: [] }] }]);
    expect(replaced.security).toEqual([{ apiKey: [] }]);

    const appended = applyOverlays(replaced, [{ addSecurity: [{ oauth: ["read"] }] }]);
    expect(appended.security).toEqual([{ apiKey: [] }, { oauth: ["read"] }]);

    expect(() =>
      applyOverlays(base(), [{ security: [{ a: [] }], addSecurity: [{ b: [] }] }]),
    ).toThrow(/security \(wholesale\) cannot combine with addSecurity/);
  });

  it("addWebhooks inserts; removeWebhooks drops; conflicts throw", () => {
    const added = applyOverlays(base(), [
      { addWebhooks: { "pet.created": { post: { responses: { "204": { description: "ok" } } } } } },
    ]);
    expect(added.webhooks?.["pet.created"]).toBeDefined();

    const removed = applyOverlays(added, [{ removeWebhooks: ["pet.created"] }]);
    expect(removed.webhooks?.["pet.created"]).toBeUndefined();

    expect(() => applyOverlays(added, [{ addWebhooks: { "pet.created": { post: {} } } }])).toThrow(
      /webhook pet\.created already exists/,
    );

    expect(() => applyOverlays(base(), [{ removeWebhooks: ["nope"] }])).toThrow(
      /removeWebhooks targets unknown webhook nope/,
    );

    expect(() =>
      applyOverlays(base(), [
        {
          addWebhooks: { x: { post: {} } },
          removeWebhooks: ["x"],
        },
      ]),
    ).toThrow(/addWebhooks and removeWebhooks both name x/);
  });

  it("setExtensions sets x-* fields and deletes on undefined", () => {
    const withExt = applyOverlays(base(), [{ setExtensions: { "x-owner": "ml" } }]);
    expect(withExt["x-owner"]).toBe("ml");

    const deleted = applyOverlays(withExt, [{ setExtensions: { "x-owner": undefined } }]);
    expect(deleted["x-owner"]).toBeUndefined();
  });
});

describe("applyOverlays: component bucket fan-out", () => {
  function baseWithComponents(): OpenAPIDocument {
    return {
      ...base(),
      components: {
        schemas: { Pet: { type: "object" } },
        parameters: {
          TraceId: { name: "X-Trace", in: "header", schema: { type: "string" } },
        },
        responses: {
          NotFound: { description: "missing" },
        },
        requestBodies: {
          PetBody: { content: { "application/json": { schema: { type: "object" } } } },
        },
        headers: {
          RateLimit: { schema: { type: "integer" } },
        },
        securitySchemes: {
          apiKey: { type: "apiKey", name: "X-Key", in: "header" },
        },
        links: {
          GetPet: { operationId: "getPet" },
        },
        callbacks: {
          onCreate: { "{$request.body#/callback}": { post: {} } },
        },
        examples: {
          one: { value: { name: "rex" } },
        },
      },
    };
  }

  it("extendParameters shallow-merges existing entries; new keys append", () => {
    // `TraceId` supplies only `description`, with no `name` or `in`.
    // That is the whole point of extend, and it is also the type test:
    // these files are type-checked (#496), so narrowing the extend
    // verbs back to the full component object fails the build here
    // rather than pushing a cast into user code (#499).
    const patched = applyOverlays(baseWithComponents(), [
      {
        extendParameters: {
          TraceId: { description: "traces" },
          NewParam: { name: "X-New", in: "header" },
        },
      },
    ]);
    expect(patched.components?.parameters?.TraceId).toMatchObject({
      name: "X-Trace",
      in: "header",
      description: "traces",
    });
    expect(patched.components?.parameters?.NewParam).toBeDefined();
  });

  it("replaceParameters fully replaces an entry", () => {
    const patched = applyOverlays(baseWithComponents(), [
      {
        replaceParameters: {
          TraceId: { name: "Y", in: "query" },
        },
      },
    ]);
    expect(patched.components?.parameters?.TraceId).toEqual({ name: "Y", in: "query" });
  });

  it("removeComponentParameters drops by name; missing throws", () => {
    const patched = applyOverlays(baseWithComponents(), [
      { removeComponentParameters: ["TraceId"] },
    ]);
    expect(patched.components?.parameters?.TraceId).toBeUndefined();

    expect(() =>
      applyOverlays(baseWithComponents(), [{ removeComponentParameters: ["Missing"] }]),
    ).toThrow(/removeComponentParameters targets unknown parameters entry Missing/);
  });

  it("each non-schema bucket fans out extend / replace / remove", () => {
    const patched = applyOverlays(baseWithComponents(), [
      {
        extendComponentResponses: { NotFound: { description: "not found 2" } },
        replaceComponentResponses: { New: { description: "fresh" } },
        extendRequestBodies: { PetBody: { description: "pet" } },
        replaceRequestBodies: { NewBody: { content: {} } },
        extendHeaders: { RateLimit: { description: "limit" } },
        replaceHeaders: { Other: { schema: { type: "string" } } },
        extendSecuritySchemes: { apiKey: { description: "key" } },
        replaceSecuritySchemes: { bearer: { type: "http", scheme: "bearer" } },
        extendLinks: { GetPet: { description: "fetch" } },
        replaceLinks: { Other: { operationId: "x" } },
        extendCallbacks: { onCreate: {} },
        replaceCallbacks: { onDelete: { "{$url}": { post: {} } } },
        extendExamples: { one: { summary: "one" } },
        replaceExamples: { two: { value: 2 } },
      },
    ]);
    expect(patched.components?.responses?.NotFound).toMatchObject({ description: "not found 2" });
    expect(patched.components?.responses?.New).toBeDefined();
    expect(patched.components?.requestBodies?.PetBody).toMatchObject({ description: "pet" });
    expect(patched.components?.requestBodies?.NewBody).toBeDefined();
    expect(patched.components?.headers?.RateLimit).toMatchObject({ description: "limit" });
    expect(patched.components?.headers?.Other).toBeDefined();
    expect(patched.components?.securitySchemes?.apiKey).toMatchObject({ description: "key" });
    expect(patched.components?.securitySchemes?.bearer).toBeDefined();
    expect(patched.components?.links?.GetPet).toMatchObject({ description: "fetch" });
    expect(patched.components?.links?.Other).toBeDefined();
    expect(patched.components?.callbacks?.onDelete).toBeDefined();
    expect(patched.components?.examples?.one).toMatchObject({ summary: "one" });
    expect(patched.components?.examples?.two).toBeDefined();
  });

  it("removeLinks throws on a missing entry", () => {
    expect(() => applyOverlays(baseWithComponents(), [{ removeLinks: ["Nope"] }])).toThrow(
      /removeLinks targets unknown links entry Nope/,
    );
  });

  it("bucket self-conflicts: replaceParameters + removeComponentParameters naming the same key throws", () => {
    expect(() =>
      applyOverlays(baseWithComponents(), [
        {
          replaceParameters: { TraceId: { name: "Y", in: "query" } },
          removeComponentParameters: ["TraceId"],
        },
      ]),
    ).toThrow(/replaceParameters and removeParameters both name TraceId/);
  });

  // Per-bucket missing-target coverage: the bucket fan-out is shared,
  // but each verb name is part of the public surface. Exercise every
  // remove<Bucket> so a rename or arg-binding regression on any one of
  // them surfaces.
  it.each([
    [
      "removeComponentResponses",
      () => ({ removeComponentResponses: ["nope"] }),
      /removeComponentResponses targets unknown responses entry nope/,
    ],
    [
      "removeRequestBodies",
      () => ({ removeRequestBodies: ["nope"] }),
      /removeRequestBodies targets unknown requestBodies entry nope/,
    ],
    [
      "removeHeaders",
      () => ({ removeHeaders: ["nope"] }),
      /removeHeaders targets unknown headers entry nope/,
    ],
    [
      "removeSecuritySchemes",
      () => ({ removeSecuritySchemes: ["nope"] }),
      /removeSecuritySchemes targets unknown securitySchemes entry nope/,
    ],
    [
      "removeCallbacks",
      () => ({ removeCallbacks: ["nope"] }),
      /removeCallbacks targets unknown callbacks entry nope/,
    ],
    [
      "removeExamples",
      () => ({ removeExamples: ["nope"] }),
      /removeExamples targets unknown examples entry nope/,
    ],
  ] as const)("%s throws on a missing entry", (_verb, overlayFn, expectedError) => {
    expect(() => applyOverlays(baseWithComponents(), [overlayFn()])).toThrow(expectedError);
  });

  // Per-bucket self-conflict coverage: replace<Bucket> + remove<Bucket>
  // naming the same key. One case per non-schema bucket exercises each
  // verb's branch in assertNoSelfConflict.
  it.each([
    [
      "responses",
      () => ({
        replaceComponentResponses: { Conflict: { description: "x" } },
        removeComponentResponses: ["Conflict"],
      }),
      /replaceResponses and removeResponses both name Conflict/,
    ],
    [
      "requestBodies",
      () => ({
        replaceRequestBodies: { Conflict: { content: {} } },
        removeRequestBodies: ["Conflict"],
      }),
      /replaceRequestBodies and removeRequestBodies both name Conflict/,
    ],
    [
      "headers",
      () => ({
        replaceHeaders: { Conflict: { schema: { type: "string" } } },
        removeHeaders: ["Conflict"],
      }),
      /replaceHeaders and removeHeaders both name Conflict/,
    ],
    [
      "securitySchemes",
      (): SpecOverlay => ({
        replaceSecuritySchemes: { Conflict: { type: "apiKey", name: "K", in: "header" } },
        removeSecuritySchemes: ["Conflict"],
      }),
      /replaceSecuritySchemes and removeSecuritySchemes both name Conflict/,
    ],
    [
      "callbacks",
      () => ({
        replaceCallbacks: { Conflict: {} },
        removeCallbacks: ["Conflict"],
      }),
      /replaceCallbacks and removeCallbacks both name Conflict/,
    ],
    [
      "examples",
      () => ({
        replaceExamples: { Conflict: { value: 1 } },
        removeExamples: ["Conflict"],
      }),
      /replaceExamples and removeExamples both name Conflict/,
    ],
  ] as const)(
    "%s bucket: replace + remove for same key throws",
    (_bucket, overlayFn, expectedError) => {
      expect(() => applyOverlays(baseWithComponents(), [overlayFn()])).toThrow(expectedError);
    },
  );

  it("extend on non-schema bucket creates the entry when missing", () => {
    const patched = applyOverlays(baseWithComponents(), [
      { extendHeaders: { NewHeader: { schema: { type: "string" } } } },
    ]);
    expect(patched.components?.headers?.NewHeader).toEqual({ schema: { type: "string" } });
  });
});

describe("applyOverlays: operation-level expansion", () => {
  function basePlus(): OpenAPIDocument {
    return {
      openapi: "3.1.0",
      info: { title: "X", version: "1" },
      paths: {
        "/pets": {
          get: {
            tags: ["pets"],
            security: [{ apiKey: [] }],
            responses: {
              "200": {
                description: "ok",
                headers: { Existing: { schema: { type: "string" } } },
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
        },
      },
    };
  }

  it("addTags / removeTags update the tag set", () => {
    const patched = applyOverlays(basePlus(), [
      {
        overrides: {
          "/pets": {
            operations: {
              get: { addTags: ["v2"], removeTags: ["pets"] },
            },
          },
        },
      },
    ]);
    expect(patched.paths?.["/pets"]?.get?.tags).toEqual(["v2"]);
  });

  it("tags wholesale replaces and conflicts with addTags", () => {
    const patched = applyOverlays(basePlus(), [
      {
        overrides: {
          "/pets": { operations: { get: { tags: ["fresh"] } } },
        },
      },
    ]);
    expect(patched.paths?.["/pets"]?.get?.tags).toEqual(["fresh"]);

    expect(() =>
      applyOverlays(basePlus(), [
        {
          overrides: {
            "/pets": {
              operations: { get: { tags: ["x"], addTags: ["y"] } },
            },
          },
        },
      ]),
    ).toThrow(/tags \(wholesale\) cannot combine with addTags/);
  });

  it("addSecurity appends; removeSecurity drops a deep-equal requirement", () => {
    const patched = applyOverlays(basePlus(), [
      {
        overrides: {
          "/pets": {
            operations: {
              get: {
                addSecurity: [{ oauth: ["read"] }],
                removeSecurity: [{ apiKey: [] }],
              },
            },
          },
        },
      },
    ]);
    expect(patched.paths?.["/pets"]?.get?.security).toEqual([{ oauth: ["read"] }]);
  });

  it("servers / callbacks / externalDocs are set on the operation", () => {
    const patched = applyOverlays(basePlus(), [
      {
        overrides: {
          "/pets": {
            operations: {
              get: {
                servers: [{ url: "https://x" }],
                callbacks: { onX: { "{$url}": { post: {} } } },
                externalDocs: { url: "https://docs" },
              },
            },
          },
        },
      },
    ]);
    const op = patched.paths?.["/pets"]?.get;
    expect(op?.servers).toEqual([{ url: "https://x" }]);
    expect(op?.callbacks?.onX).toBeDefined();
    expect(op?.externalDocs).toEqual({ url: "https://docs" });
  });

  it("setExtensions on an operation sets and deletes x-* fields", () => {
    const patched = applyOverlays(basePlus(), [
      {
        overrides: {
          "/pets": {
            operations: {
              get: { setExtensions: { "x-owner": "ml" } },
            },
          },
        },
      },
    ]);
    const getOp = patched.paths?.["/pets"]?.get;
    expect((getOp as Record<string, unknown>)["x-owner"]).toBe("ml");

    const removed = applyOverlays(patched, [
      {
        overrides: {
          "/pets": {
            operations: {
              get: { setExtensions: { "x-owner": undefined } },
            },
          },
        },
      },
    ]);
    const removedOp = removed.paths?.["/pets"]?.get;
    expect((removedOp as Record<string, unknown>)["x-owner"]).toBeUndefined();
  });

  it("patchResponses merges headers and allOf-extends content schemas", () => {
    const patched = applyOverlays(basePlus(), [
      {
        overrides: {
          "/pets": {
            operations: {
              get: {
                patchResponses: {
                  "200": {
                    headers: { New: { schema: { type: "integer" } } },
                    content: {
                      "application/json": { schema: { required: ["id"] } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ]);
    const r200 = patched.paths?.["/pets"]?.get?.responses?.["200"];
    expect(r200).toBeDefined();
    if (r200 && "$ref" in r200) throw new Error("unexpected ref");
    expect(r200?.headers?.Existing).toBeDefined();
    expect(r200?.headers?.New).toBeDefined();
    expect(r200?.content?.["application/json"]?.schema).toMatchObject({
      allOf: [{ type: "object" }, { required: ["id"] }],
    });
  });

  it("patchResponses on a missing status code creates the response from the patch", () => {
    // Matches OpenAPI Overlay 1.0 merge semantics for new keys:
    // missing target is created, not an error. A typed author who
    // really wants to fail on missing status can do their own
    // existence check before constructing the overlay.
    const patched = applyOverlays(basePlus(), [
      {
        overrides: {
          "/pets": {
            operations: {
              get: {
                patchResponses: {
                  "404": { description: "not found", headers: { Trace: {} } },
                },
              },
            },
          },
        },
      },
    ]);
    const r404 = patched.paths?.["/pets"]?.get?.responses?.["404"];
    if (r404 && "$ref" in r404) throw new Error("unexpected ref");
    expect(r404?.description).toBe("not found");
    expect(r404?.headers?.["Trace"]).toBeDefined();
    // Existing responses on the operation are preserved.
    expect(patched.paths?.["/pets"]?.get?.responses?.["200"]).toBeDefined();
  });
});

describe("applyOverlays: predicate iterators", () => {
  function multi(): OpenAPIDocument {
    return {
      openapi: "3.1.0",
      info: { title: "X", version: "1" },
      paths: {
        "/pets": {
          parameters: [{ name: "x-trace", in: "header", schema: { type: "string" } }],
          get: {
            tags: ["pets"],
            parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
            responses: { "200": { description: "ok" } },
          },
          post: {
            tags: ["pets", "writes"],
            responses: { "201": { description: "created" } },
          },
        },
        "/vets": {
          get: {
            tags: ["vets"],
            responses: { "200": { description: "ok" } },
          },
        },
      },
      webhooks: {
        "pet.created": {
          post: {
            tags: ["pets"],
            responses: { "204": { description: "ack" } },
          },
        },
      },
    };
  }

  it("modifyOperations with no where applies to every operation under paths and webhooks", () => {
    const patched = applyOverlays(multi(), [
      { modifyOperations: [{ apply: { addTags: ["traced"] } }] },
    ]);
    expect(patched.paths?.["/pets"]?.get?.tags).toContain("traced");
    expect(patched.paths?.["/pets"]?.post?.tags).toContain("traced");
    expect(patched.paths?.["/vets"]?.get?.tags).toContain("traced");
    const webhook = patched.webhooks?.["pet.created"];
    if (webhook && !("$ref" in webhook)) {
      expect(webhook.post?.tags).toContain("traced");
    }
  });

  it("modifyOperations filters by tag, method, pathPattern (AND)", () => {
    const patched = applyOverlays(multi(), [
      {
        modifyOperations: [
          {
            where: { tags: ["pets"], methods: ["get"], pathPattern: /^\/pets/ },
            apply: { addTags: ["matched"] },
          },
        ],
      },
    ]);
    expect(patched.paths?.["/pets"]?.get?.tags).toContain("matched");
    expect(patched.paths?.["/pets"]?.post?.tags ?? []).not.toContain("matched");
    expect(patched.paths?.["/vets"]?.get?.tags ?? []).not.toContain("matched");
  });

  it("modifyParameters filters by in and nameMatches; merges fields into matching params", () => {
    const patched = applyOverlays(multi(), [
      {
        modifyParameters: [
          {
            where: { in: "header", nameMatches: /^x-/ },
            apply: { description: "traced", required: true },
          },
        ],
      },
    ]);
    const pathItemParam = patched.paths?.["/pets"]?.parameters?.[0];
    expect(pathItemParam).toMatchObject({
      name: "x-trace",
      in: "header",
      description: "traced",
      required: true,
    });
    const opParam = patched.paths?.["/pets"]?.get?.parameters?.[0];
    expect(opParam).toMatchObject({ name: "limit", in: "query" });
    expect(opParam).not.toHaveProperty("description");
  });

  it("modifyOperations with a /g regex still matches every path (no lastIndex skip)", () => {
    const pattern = /^\/pets/g;
    const patched = applyOverlays(multi(), [
      {
        modifyOperations: [
          { where: { pathPattern: pattern }, apply: { addTags: ["g-flag"] } },
          { where: { pathPattern: pattern }, apply: { addTags: ["g-flag-2"] } },
        ],
      },
    ]);
    // Without the lastIndex strip, the second entry's .test() on /^\/pets/g
    // would start past the input and miss the match.
    expect(patched.paths?.["/pets"]?.get?.tags).toEqual(
      expect.arrayContaining(["g-flag", "g-flag-2"]),
    );
    expect(patched.paths?.["/pets"]?.post?.tags).toEqual(
      expect.arrayContaining(["g-flag", "g-flag-2"]),
    );
    // Caller's regex isn't mutated.
    expect(pattern.lastIndex).toBe(0);
  });

  it("modifyParameters with a /g regex matches every parameter (no lastIndex skip)", () => {
    const pattern = /^x-/g;
    const patched = applyOverlays(multi(), [
      {
        modifyParameters: [{ where: { nameMatches: pattern }, apply: { description: "first" } }],
      },
      {
        modifyParameters: [{ where: { nameMatches: pattern }, apply: { required: true } }],
      },
    ]);
    const pathItemParam = patched.paths?.["/pets"]?.parameters?.[0];
    expect(pathItemParam).toMatchObject({
      name: "x-trace",
      description: "first",
      required: true,
    });
    expect(pattern.lastIndex).toBe(0);
  });

  it("modifyOperations preserves sticky (y) semantics: /pets/y matches only at the start", () => {
    // Sticky requires the match to begin at lastIndex. A path of /pets
    // matches the literal "pets" at offset 1, not 0; /pets/y starting
    // at lastIndex 0 should NOT match. A stripped-y clone would, which
    // is the regression this test pins against.
    const stickyMid = /pets/y;
    const patchedMid = applyOverlays(multi(), [
      {
        modifyOperations: [{ where: { pathPattern: stickyMid }, apply: { addTags: ["sticky"] } }],
      },
    ]);
    expect(patchedMid.paths?.["/pets"]?.get?.tags ?? []).not.toContain("sticky");

    // A sticky pattern that DOES start at offset 0 still matches.
    const stickyStart = /\/pets/y;
    const patchedStart = applyOverlays(multi(), [
      {
        modifyOperations: [{ where: { pathPattern: stickyStart }, apply: { addTags: ["sticky"] } }],
      },
    ]);
    expect(patchedStart.paths?.["/pets"]?.get?.tags).toContain("sticky");
    // Caller-supplied lastIndex is preserved.
    expect(stickyStart.lastIndex).toBe(0);
  });

  it("modifyParameters skips reference-object parameters silently", () => {
    const doc: OpenAPIDocument = {
      ...multi(),
      paths: {
        ...multi().paths!,
        "/refs": {
          get: {
            parameters: [{ $ref: "#/components/parameters/X" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const patched = applyOverlays(doc, [
      {
        modifyParameters: [{ apply: { description: "irrelevant" } }],
      },
    ]);
    const params = patched.paths?.["/refs"]?.get?.parameters;
    expect(params?.[0]).toEqual({ $ref: "#/components/parameters/X" });
  });
});

describe("isSpecOverlay", () => {
  it("accepts an object whose keys are all recognised verbs", () => {
    expect(isSpecOverlay({ info: { title: "T" }, addServers: [], removePaths: [] })).toBe(true);
  });

  it("accepts the empty (no-op) overlay", () => {
    expect(isSpecOverlay({})).toBe(true);
  });

  it("rejects non-objects, arrays, and null", () => {
    expect(isSpecOverlay(null)).toBe(false);
    expect(isSpecOverlay("overlay")).toBe(false);
    expect(isSpecOverlay([{ info: {} }])).toBe(false);
  });

  it("rejects any unrecognised key, including the Overlay 1.0 envelope", () => {
    expect(isSpecOverlay({ info: {}, unknownVerb: 1 })).toBe(false);
    expect(isSpecOverlay({ overlay: "1.0.0", info: {}, actions: [] })).toBe(false);
  });

  it("exposes the verb set, in sync with the guard", () => {
    for (const verb of specOverlayVerbs) {
      expect(isSpecOverlay({ [verb]: undefined })).toBe(true);
    }
    expect(specOverlayVerbs.has("overlay")).toBe(false);
    expect(specOverlayVerbs.has("actions")).toBe(false);
  });
});

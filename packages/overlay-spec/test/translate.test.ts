import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import {
  UnrecognisedTargetError,
  applySpecOverlay,
  isOverlayDocument,
  translateOverlay,
} from "../src/index.js";
import type { OverlayDocument } from "../src/index.js";

function doc(actions: OverlayDocument["actions"]): OverlayDocument {
  return {
    overlay: "1.0.0",
    info: { title: "test overlay", version: "1.0.0" },
    actions,
  };
}

function base(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "X", version: "1" },
    servers: [{ url: "https://a.example" }],
    tags: [{ name: "pets", description: "old" }],
    paths: {
      "/pets": {
        get: {
          tags: ["pets"],
          parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
          responses: { "200": { description: "ok" } },
        },
        post: {
          tags: ["pets"],
          responses: { "201": { description: "created" } },
        },
      },
    },
    components: {
      schemas: { Pet: { type: "object" } },
      parameters: {
        TraceId: { name: "X-Trace", in: "header", schema: { type: "string" } },
      },
    },
  };
}

describe("translateOverlay: envelope", () => {
  it("rejects a document missing `overlay`", () => {
    expect(() =>
      translateOverlay({ info: { title: "x", version: "1" }, actions: [] } as never),
    ).toThrow(/required string field `overlay`/);
  });

  it("rejects a document missing `actions`", () => {
    expect(() =>
      translateOverlay({ overlay: "1.0.0", info: { title: "x", version: "1" } } as never),
    ).toThrow(/required array field `actions`/);
  });

  it("rejects an action with both `update` and `remove: true`", () => {
    expect(() =>
      translateOverlay(doc([{ target: "$.info", update: { description: "x" }, remove: true }])),
    ).toThrow(/cannot set both `update` and `remove: true`/);
  });

  it("rejects an action with neither `update` nor `remove`", () => {
    expect(() => translateOverlay(doc([{ target: "$.info" }]))).toThrow(
      /must set either `update` or `remove: true`/,
    );
  });
});

describe("translateOverlay: top-level shapes", () => {
  it("$.info → info merge", () => {
    const o = translateOverlay(doc([{ target: "$.info", update: { description: "d" } }]));
    expect(o.info).toEqual({ description: "d" });
  });

  it("$.servers update → addServers", () => {
    const o = translateOverlay(
      doc([{ target: "$.servers", update: [{ url: "https://b.example" }] }]),
    );
    expect(o.addServers).toEqual([{ url: "https://b.example" }]);
  });

  it("$.servers remove → servers: []", () => {
    const o = translateOverlay(doc([{ target: "$.servers", remove: true }]));
    expect(o.servers).toEqual([]);
  });

  it("$.tags update → extendTags (append)", () => {
    const o = translateOverlay(doc([{ target: "$.tags", update: [{ name: "internal" }] }]));
    expect(o.extendTags).toEqual([{ name: "internal" }]);
  });

  it("$.tags[?(@.name=='X')] update → extendTags (merge by name)", () => {
    const o = translateOverlay(
      doc([{ target: "$.tags[?(@.name=='pets')]", update: { description: "new" } }]),
    );
    expect(o.extendTags).toEqual([{ name: "pets", description: "new" }]);
  });

  it("$.tags[?(@.name=='X')] remove → removeTags", () => {
    const o = translateOverlay(doc([{ target: "$.tags[?(@.name=='pets')]", remove: true }]));
    expect(o.removeTags).toEqual(["pets"]);
  });

  it("$.security update → addSecurity", () => {
    const o = translateOverlay(doc([{ target: "$.security", update: [{ apiKey: [] }] }]));
    expect(o.addSecurity).toEqual([{ apiKey: [] }]);
  });

  it("$.webhooks['name'] update → addWebhooks", () => {
    const o = translateOverlay(
      doc([
        {
          target: "$.webhooks['pet.created']",
          update: { post: { responses: { "204": { description: "ack" } } } },
        },
      ]),
    );
    expect(o.addWebhooks?.["pet.created"]).toBeDefined();
  });

  it("$.webhooks['name'] remove → removeWebhooks", () => {
    const o = translateOverlay(doc([{ target: "$.webhooks['pet.x']", remove: true }]));
    expect(o.removeWebhooks).toEqual(["pet.x"]);
  });
});

describe("translateOverlay: components fan-out", () => {
  it("$.components.schemas.Pet update → extendSchemas", () => {
    const o = translateOverlay(
      doc([{ target: "$.components.schemas.Pet", update: { required: ["id"] } }]),
    );
    expect(o.extendSchemas).toEqual({ Pet: { required: ["id"] } });
  });

  it("$.components.schemas.Pet remove → removeSchemas", () => {
    const o = translateOverlay(doc([{ target: "$.components.schemas.Pet", remove: true }]));
    expect(o.removeSchemas).toEqual(["Pet"]);
  });

  it("$.components.parameters.TraceId update → extendParameters", () => {
    const o = translateOverlay(
      doc([{ target: "$.components.parameters.TraceId", update: { required: true } }]),
    );
    expect(o.extendParameters).toEqual({ TraceId: { required: true } });
  });

  it("$.components.headers.RateLimit remove → removeHeaders", () => {
    const o = translateOverlay(doc([{ target: "$.components.headers.RateLimit", remove: true }]));
    expect(o.removeHeaders).toEqual(["RateLimit"]);
  });

  it("$.components.callbacks.onX update → extendCallbacks", () => {
    const o = translateOverlay(
      doc([{ target: "$.components.callbacks.onX", update: { "{$url}": { post: {} } } }]),
    );
    expect(o.extendCallbacks).toEqual({ onX: { "{$url}": { post: {} } } });
  });

  it("$.components.examples.one update → extendExamples", () => {
    const o = translateOverlay(
      doc([{ target: "$.components.examples.one", update: { value: 1 } }]),
    );
    expect(o.extendExamples).toEqual({ one: { value: 1 } });
  });

  it("rejects unknown component bucket", () => {
    expect(() => translateOverlay(doc([{ target: "$.components.nope.X", update: {} }]))).toThrow(
      /expected one of/,
    );
  });
});

describe("translateOverlay: paths and operations", () => {
  it("$.paths['/x'] update → overrides[/x].pathItem merge", () => {
    const o = translateOverlay(
      doc([{ target: "$.paths['/pets']", update: { summary: "pet ops" } }]),
    );
    expect(o.overrides?.["/pets"]?.pathItem).toEqual({ summary: "pet ops" });
  });

  it("$.paths.x dot form is equivalent to bracket form", () => {
    const o = translateOverlay(doc([{ target: "$.paths.pets", update: { summary: "s" } }]));
    expect(o.overrides?.["pets"]?.pathItem).toEqual({ summary: "s" });
  });

  it("$.paths['/x'] remove → removePaths", () => {
    const o = translateOverlay(doc([{ target: "$.paths['/pets']", remove: true }]));
    expect(o.removePaths).toEqual(["/pets"]);
  });

  it("$.paths['/x'].get update → operation override (operationId pass-through)", () => {
    const o = translateOverlay(
      doc([{ target: "$.paths['/pets'].get", update: { operationId: "listPets" } }]),
    );
    const op = o.overrides?.["/pets"]?.operations?.["get"];
    expect(op).toMatchObject({ operationId: "listPets" });
  });

  it("$.paths.* and $.paths['/x'].* are recognised as wildcard slots", () => {
    const o = translateOverlay(
      doc([
        { target: "$.paths.*", update: { summary: "any path" } },
        { target: "$.paths['/pets'].*", update: { description: "any method on /pets" } },
      ]),
    );
    expect(o.overrides?.["*"]?.pathItem).toEqual({ summary: "any path" });
    expect((o.overrides?.["/pets"]?.operations as Record<string, unknown>)?.["*"]).toMatchObject({
      description: "any method on /pets",
    });
  });

  it("$.paths['/x'].get.parameters[?(@.name=='X' && @.in=='Y')] update → upsertParameters", () => {
    const o = translateOverlay(
      doc([
        {
          target: "$.paths['/pets'].get.parameters[?(@.name=='limit' && @.in=='query')]",
          update: { schema: { type: "string" } },
        },
      ]),
    );
    expect(o.overrides?.["/pets"]?.operations?.["get"]?.upsertParameters).toEqual([
      { name: "limit", in: "query", schema: { type: "string" } },
    ]);
  });

  it("...parameters[?(...)] remove → removeParameters", () => {
    const o = translateOverlay(
      doc([
        {
          target: "$.paths['/pets'].get.parameters[?(@.name=='limit' && @.in=='query')]",
          remove: true,
        },
      ]),
    );
    expect(o.overrides?.["/pets"]?.operations?.["get"]?.removeParameters).toEqual([
      { name: "limit", in: "query" },
    ]);
  });

  it("...responses['200'] update → patchResponses (in-place merge, preserves existing fields)", () => {
    const o = translateOverlay(
      doc([
        {
          target: "$.paths['/pets'].get.responses['200']",
          update: { description: "okay" },
        },
      ]),
    );
    // patchResponses (not responses) so the applier merges into the
    // existing response instead of replacing it wholesale.
    expect(o.overrides?.["/pets"]?.operations?.["get"]?.patchResponses?.["200"]).toEqual({
      description: "okay",
    });
    expect(o.overrides?.["/pets"]?.operations?.["get"]?.responses).toBeUndefined();
  });

  it("...responses['200'] remove → removeResponses", () => {
    const o = translateOverlay(
      doc([{ target: "$.paths['/pets'].get.responses['200']", remove: true }]),
    );
    expect(o.overrides?.["/pets"]?.operations?.["get"]?.removeResponses).toEqual(["200"]);
  });

  it("rejects unsupported operation child", () => {
    expect(() =>
      translateOverlay(doc([{ target: "$.paths['/pets'].get.unknown", update: {} }])),
    ).toThrow(/unknown operation child/);
  });
});

describe("translateOverlay: predicate iterators", () => {
  it("$.paths.*.*[?(@.tags contains 'X')] update → modifyOperations with where.tags", () => {
    // Spec-format payload is a partial OperationObject; `tags` on the
    // OAS shape (an array) maps to our `addTags` additive verb.
    const o = translateOverlay(
      doc([
        {
          target: "$.paths.*.*[?(@.tags contains 'internal')]",
          update: { tags: ["traced"] },
        },
      ]),
    );
    expect(o.modifyOperations).toBeDefined();
    expect(o.modifyOperations?.[0]?.where).toEqual({ tags: ["internal"] });
    expect(o.modifyOperations?.[0]?.apply.addTags).toEqual(["traced"]);
  });

  it("modifyOperations narrows by path when the path selector is concrete", () => {
    const o = translateOverlay(
      doc([
        {
          target: "$.paths['/pets'].*[?(@.tags contains 'internal')]",
          update: { description: "internal-only" },
        },
      ]),
    );
    const entry = o.modifyOperations?.[0];
    expect(entry?.where?.tags).toEqual(["internal"]);
    expect(entry?.where?.pathPattern?.source).toContain("/pets");
  });
});

describe("translateOverlay: error policy", () => {
  it("UnrecognisedTargetError carries the offending target", () => {
    try {
      translateOverlay(doc([{ target: "$..parameters", update: {} }]));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnrecognisedTargetError);
      expect((err as UnrecognisedTargetError).target).toBe("$..parameters");
    }
  });

  it("non-target errors include the action index and target in the message", () => {
    expect(() =>
      translateOverlay(
        doc([
          { target: "$.info", update: { description: "ok" } },
          // Wrong payload shape: $.info expects an object, not an array.
          { target: "$.info", update: ["wrong"] },
        ]),
      ),
    ).toThrow(/overlay action #1.*\$\.info/);
  });

  it("no partial application: a bad action aborts the whole translation", () => {
    expect(() =>
      translateOverlay(
        doc([
          { target: "$.info", update: { description: "fine" } },
          { target: "$..parameters", update: {} },
        ]),
      ),
    ).toThrow(UnrecognisedTargetError);
    // The thrown error is from the second action; no overlay is returned.
  });
});

describe("applySpecOverlay", () => {
  it("translates + applies in one call", () => {
    const patched = applySpecOverlay(
      base(),
      doc([
        { target: "$.info", update: { description: "patched" } },
        { target: "$.tags[?(@.name=='pets')]", update: { description: "fresh" } },
      ]),
    );
    expect(patched.info.description).toBe("patched");
    expect(patched.tags?.find((t) => t.name === "pets")?.description).toBe("fresh");
  });

  it("delegates to @oaverify/internal-spec's applyOverlays semantics (later overlays win, base untouched)", () => {
    const start = base();
    const patched = applySpecOverlay(start, doc([{ target: "$.paths['/pets']", remove: true }]));
    expect(patched.paths?.["/pets"]).toBeUndefined();
    // Input untouched.
    expect(start.paths?.["/pets"]).toBeDefined();
  });

  // The bugs in these tests would only surface after applying, not in
  // the translated SpecOverlay alone. Translator-only assertions can
  // miss silent drops on the apply side.

  it("operation scalar fields (operationId, summary, description, deprecated) survive apply", () => {
    const patched = applySpecOverlay(
      base(),
      doc([
        {
          target: "$.paths['/pets'].get",
          update: {
            operationId: "listPets",
            summary: "list pets",
            description: "pet listing",
            deprecated: true,
          },
        },
      ]),
    );
    const op = patched.paths?.["/pets"]?.get;
    expect(op?.operationId).toBe("listPets");
    expect(op?.summary).toBe("list pets");
    expect(op?.description).toBe("pet listing");
    expect(op?.deprecated).toBe(true);
    // Existing fields preserved.
    expect(op?.responses?.["200"]).toBeDefined();
  });

  it("array targets accept a single-object `update` payload (OpenAPI Overlay 1.0 canonical form)", () => {
    const patched = applySpecOverlay(
      base(),
      doc([{ target: "$.servers", update: { url: "https://b.example" } }]),
    );
    expect(patched.servers).toEqual([{ url: "https://a.example" }, { url: "https://b.example" }]);
  });

  it("array targets also accept an array `update` payload (permissive)", () => {
    const patched = applySpecOverlay(
      base(),
      doc([
        {
          target: "$.servers",
          update: [{ url: "https://b.example" }, { url: "https://c.example" }],
        },
      ]),
    );
    expect(patched.servers).toHaveLength(3);
  });

  it("operation update with nested method payload preserves the existing operation", () => {
    // $.paths['/pets'] update: { get: { description: "..." } }
    // must NOT clobber the existing get.parameters / get.responses.
    const patched = applySpecOverlay(
      base(),
      doc([
        {
          target: "$.paths['/pets']",
          update: { get: { description: "patched" } },
        },
      ]),
    );
    const op = patched.paths?.["/pets"]?.get;
    expect(op?.description).toBe("patched");
    expect(op?.parameters).toEqual([{ name: "limit", in: "query", schema: { type: "integer" } }]);
    expect(op?.responses?.["200"]).toBeDefined();
  });

  it("response update preserves existing description/headers/content on the same status", () => {
    const start: typeof base extends () => infer T ? T : never = {
      ...base(),
      paths: {
        "/pets": {
          get: {
            tags: ["pets"],
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
    const patched = applySpecOverlay(
      start,
      doc([
        {
          target: "$.paths['/pets'].get.responses['200']",
          update: { description: "merged" },
        },
      ]),
    );
    const r = patched.paths?.["/pets"]?.get?.responses?.["200"];
    if (r && "$ref" in r) throw new Error("unexpected ref");
    expect(r?.description).toBe("merged");
    expect(r?.headers?.["Existing"]).toBeDefined();
    expect(r?.content?.["application/json"]).toBeDefined();
  });

  it("operation update with `responses` field can add a NEW status code (Overlay 1.0 merge-on-missing)", () => {
    // Per OpenAPI Overlay 1.0 deep-merge, missing keys in the target
    // are created from the update. patchResponses must apply the
    // patch to an empty response on missing, not throw.
    const patched = applySpecOverlay(
      base(),
      doc([
        {
          target: "$.paths['/pets'].get",
          update: { responses: { "404": { description: "missing" } } },
        },
      ]),
    );
    const r404 = patched.paths?.["/pets"]?.get?.responses?.["404"];
    if (r404 && "$ref" in r404) throw new Error("unexpected ref");
    expect(r404?.description).toBe("missing");
    // Existing 200 untouched.
    expect(patched.paths?.["/pets"]?.get?.responses?.["200"]).toBeDefined();
  });

  it("response leaf update can create a new status code", () => {
    const patched = applySpecOverlay(
      base(),
      doc([
        {
          target: "$.paths['/pets'].get.responses['404']",
          update: { description: "missing" },
        },
      ]),
    );
    const r404 = patched.paths?.["/pets"]?.get?.responses?.["404"];
    if (r404 && "$ref" in r404) throw new Error("unexpected ref");
    expect(r404?.description).toBe("missing");
  });

  it("operation update with `responses` field merges per-status (preserves existing fields)", () => {
    const start: typeof base extends () => infer T ? T : never = {
      ...base(),
      paths: {
        "/pets": {
          get: {
            tags: ["pets"],
            responses: {
              "200": {
                description: "ok",
                headers: { Existing: { schema: { type: "string" } } },
              },
            },
          },
        },
      },
    };
    const patched = applySpecOverlay(
      start,
      doc([
        {
          target: "$.paths['/pets'].get",
          update: { responses: { "200": { description: "merged" } } },
        },
      ]),
    );
    const r = patched.paths?.["/pets"]?.get?.responses?.["200"];
    if (r && "$ref" in r) throw new Error("unexpected ref");
    expect(r?.description).toBe("merged");
    expect(r?.headers?.["Existing"]).toBeDefined();
  });
});

describe("isOverlayDocument", () => {
  it("accepts the standard envelope", () => {
    expect(isOverlayDocument(doc([]))).toBe(true);
  });

  it("requires the overlay version string, info object, and actions array", () => {
    expect(isOverlayDocument({ info: { title: "T", version: "1" }, actions: [] })).toBe(false);
    expect(isOverlayDocument({ overlay: "1.0.0", actions: [] })).toBe(false);
    expect(isOverlayDocument({ overlay: "1.0.0", info: { title: "T", version: "1" } })).toBe(false);
    expect(isOverlayDocument({ overlay: 1, info: { title: "T", version: "1" }, actions: [] })).toBe(
      false,
    );
  });

  it("rejects non-objects and typed SpecOverlay shapes", () => {
    expect(isOverlayDocument(null)).toBe(false);
    expect(isOverlayDocument("overlay")).toBe(false);
    expect(isOverlayDocument({ addServers: [{ url: "https://a.example" }] })).toBe(false);
  });
});

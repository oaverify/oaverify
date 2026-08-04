/**
 * End-to-end tests for `oav compile-spec`. Each test compiles a small
 * OpenAPI document through the real emit + esbuild bundle path, loads
 * the resulting module via a data URL, and compares its behavior
 * against `createValidator(document).validateRequest` on a fixture
 * matrix. A pass means the AOT output matches the runtime validator's
 * tree shape on the covered cases.
 */

import { describe, expect, it } from "vitest";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenAPIDocument, ValidationError } from "@oaverify/internal-core";
import { createValidator } from "@oaverify/internal-validator";
import { compileSpecCommand } from "../src/commands.js";
import { memoryIo } from "./fixtures.js";
import { workspaceAliases } from "../../../workspace-aliases.js";

// The emitted module imports `@oaverify/core` subpaths by their real
// published names, which resolve through that package's exports map to
// dist/. The suite runs against source with no prior build, so alias
// them to packages/*/src via the same table vitest uses.
const CORE_ALIASES = Object.fromEntries(
  Object.entries(
    workspaceAliases(resolvePath(fileURLToPath(new URL("../../..", import.meta.url)))),
  ).filter(([k]) => k.startsWith("@oaverify/core")),
);

// esbuild needs a directory where `@oaverify/core` resolves, since that is
// what the emitted module imports via the default importPrefix.
// packages/oav declares it as a runtime dependency, so the symlink is in
// its node_modules. In production the consumer's cwd has @oaverify/core
// installed and the default resolveDir is correct.
const RESOLVE_DIR = resolvePath(fileURLToPath(new URL("../../oav", import.meta.url)));

const petstore: OpenAPIDocument = {
  openapi: "3.1.0",
  info: { title: "Pets", version: "1" },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
              },
            },
          },
        },
      },
      post: {
        operationId: "createPet",
        parameters: [
          { name: "X-Tenant", in: "header", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
        },
        responses: {
          "201": {
            description: "created",
            headers: {
              "X-Request-Id": { required: true, schema: { type: "string", minLength: 1 } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1 },
          tag: { type: "string" },
        },
      },
    },
  },
};

/**
 * The emitted validate* return the same v3 result shapes as
 * `createValidator`: `{ valid: true }` or `{ valid: false, ... }` (flat
 * carries `errors`, tree carries `error`), or a bare boolean in predicate
 * mode.
 */
type AotResult =
  | boolean
  | { valid: true }
  | { valid: false; errors?: ValidationError[]; error?: ValidationError; truncated: boolean };

interface AotValidator {
  validateRequest: (req: unknown) => AotResult;
  validateResponse: (req: unknown, res: unknown) => AotResult;
  getOperation: (req: {
    method: string;
    path: string;
  }) => { pathPattern: string; pathItem: unknown; operation: unknown } | null;
  detectedVersion: string | undefined;
  warnings: readonly string[];
}

/** The nested error tree of a tree-mode result, or null when valid. */
function treeOf(r: AotResult): ValidationError | null {
  if (typeof r === "boolean" || r.valid) return null;
  return r.error ?? null;
}

/** The flat leaf list of a flat-mode result, or [] when valid. */
function flatErrors(r: AotResult): ValidationError[] {
  if (typeof r === "boolean" || r.valid) return [];
  return r.errors ?? [];
}

async function buildAot(
  document: OpenAPIDocument,
  extra: {
    requestsOnly?: boolean;
    only?: Array<{ method: string; path: string }>;
    outputMode?: "flat" | "tree" | "predicate";
    maxErrors?: number;
  } = {},
): Promise<AotValidator> {
  const mem = memoryIo([["spec.json", document]]);
  const res = await compileSpecCommand(
    {
      spec: "spec.json",
      overlays: [],
      output: "out.mjs",
      resolveDir: RESOLVE_DIR,
      bundleAlias: CORE_ALIASES,
      requestsOnly: extra.requestsOnly,
      only: extra.only,
      outputMode: extra.outputMode,
      maxErrors: extra.maxErrors,
    },
    mem.io,
  );
  if (res.exitCode !== 0) {
    throw new Error(`compile-spec failed (${res.exitCode}): ${mem.stderr.value}`);
  }
  const bundled = mem.writes[0]?.[1];
  if (bundled === undefined) throw new Error("no output written");
  return (await import(
    `data:text/javascript;base64,${Buffer.from(bundled).toString("base64")}`
  )) as AotValidator;
}

/** Compare two ValidationError trees for structural equivalence (code paths + leaf codes). */
function equivalent(a: ValidationError | null, b: ValidationError | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.code !== b.code) return false;
  const aLeaves = collectLeafCodes(a);
  const bLeaves = collectLeafCodes(b);
  if (aLeaves.length !== bLeaves.length) return false;
  for (let i = 0; i < aLeaves.length; i++) if (aLeaves[i] !== bLeaves[i]) return false;
  return true;
}

function collectLeafCodes(err: ValidationError): string[] {
  if (err.children.length === 0) return [err.code];
  return err.children.flatMap(collectLeafCodes);
}

describe("compile-spec: format assertion parity", () => {
  // The emitted module builds its own `deps` and loads `builtInFormats`
  // into it, so it has to normalize the way the runtime does. It did
  // not, once, and every string format silently stopped asserting in
  // AOT output while the runtime kept rejecting: a whole class of
  // assertion missing from compiled validators with a green suite.
  const formatSpec: OpenAPIDocument = {
    openapi: "3.1.0",
    info: { title: "Formats", version: "1" },
    paths: {
      "/p": {
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    when: { type: "string", format: "date-time" },
                    n: { type: "integer", format: "int32" },
                    big: { type: "integer", format: "int64" },
                  },
                },
              },
            },
          },
          responses: { "204": { description: "ok" } },
        },
      },
    },
  };

  const post = (body: unknown): Record<string, unknown> => ({
    method: "POST",
    path: "/p",
    contentType: "application/json",
    body,
  });

  it("asserts a string format, matching createValidator", async () => {
    const aot = await buildAot(formatSpec);
    const runtime = createValidator(formatSpec);
    const bad = post({ when: "not-a-date" });
    expect(runtime.validateRequest(bad as never).valid).toBe(false);
    expect(flatErrors(aot.validateRequest(bad as never)).map((e) => e.code)).toEqual(["format"]);
    const good = post({ when: "2026-01-01T00:00:00Z" });
    expect(flatErrors(aot.validateRequest(good as never))).toEqual([]);
  });

  it("asserts int32 and int64, matching createValidator", async () => {
    const aot = await buildAot(formatSpec);
    const runtime = createValidator(formatSpec);
    for (const body of [{ n: 3000000000 }, { big: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(runtime.validateRequest(post(body) as never).valid).toBe(false);
      expect(flatErrors(aot.validateRequest(post(body) as never)).map((e) => e.code)).toEqual([
        "format",
      ]);
    }
    expect(flatErrors(aot.validateRequest(post({ n: 1, big: 3000000000 }) as never))).toEqual([]);
  });
});

describe("compile-spec: equivalence vs createValidator", () => {
  it("does not satisfy required parameters from inherited record members", async () => {
    const spec: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "Prototype names", version: "1" },
      paths: {
        "/header": {
          get: {
            parameters: [
              { name: "constructor", in: "header", required: true, schema: { type: "string" } },
            ],
            responses: { "204": { description: "ok" } },
          },
        },
        "/query": {
          get: {
            parameters: [
              { name: "constructor", in: "query", required: true, schema: { type: "string" } },
            ],
            responses: { "204": { description: "ok" } },
          },
        },
        "/cookie": {
          get: {
            parameters: [
              { name: "constructor", in: "cookie", required: true, schema: { type: "string" } },
            ],
            responses: { "204": { description: "ok" } },
          },
        },
        "/path": {
          get: {
            parameters: [
              { name: "constructor", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: { "204": { description: "ok" } },
          },
        },
      },
    };
    const aot = await buildAot(spec);

    const cases = [
      { req: { method: "GET", path: "/header", headers: {} }, code: "header-param" },
      { req: { method: "GET", path: "/query", query: {} }, code: "query-param" },
      { req: { method: "GET", path: "/cookie", cookies: {} }, code: "cookie-param" },
      { req: { method: "GET", path: "/path" }, code: "path-param" },
    ] as const;

    for (const { req, code } of cases) {
      expect(() => aot.validateRequest(req)).not.toThrow();
      const errors = flatErrors(aot.validateRequest(req));
      expect(errors.map((e) => e.code)).toEqual([code]);
    }
  });

  it("matches runtime output on the petstore matrix", async () => {
    // The emitted (AOT) module mirrors the validator's tree output, so
    // compare against a tree-mode, uncapped runtime validator.
    const runtime = createValidator(petstore, {
      output: "tree",
      maxErrors: Number.POSITIVE_INFINITY,
    });
    const aot = await buildAot(petstore, {
      outputMode: "tree",
      maxErrors: Number.POSITIVE_INFINITY,
    });

    const cases: Array<{ name: string; req: unknown }> = [
      {
        name: "valid POST /pets",
        req: {
          method: "POST",
          path: "/pets",
          contentType: "application/json",
          headers: { "x-tenant": "acme" },
          body: { name: "Fido" },
        },
      },
      {
        name: "valid POST /pets with mixed-case required header",
        req: {
          method: "POST",
          path: "/pets",
          contentType: "application/json",
          headers: { "X-TENANT": "acme" },
          body: { name: "Fido" },
        },
      },
      {
        name: "invalid POST /pets (missing required `name`)",
        req: {
          method: "POST",
          path: "/pets",
          contentType: "application/json",
          headers: { "x-tenant": "acme" },
          body: { tag: "dog" },
        },
      },
      {
        name: "POST /pets missing required X-Tenant header",
        req: {
          method: "POST",
          path: "/pets",
          contentType: "application/json",
          body: { name: "Fido" },
        },
      },
      {
        name: "POST /pets wrong content-type → 415",
        req: {
          method: "POST",
          path: "/pets",
          contentType: "text/plain",
          headers: { "x-tenant": "acme" },
          body: "raw",
        },
      },
      {
        name: "valid GET /pets",
        req: { method: "GET", path: "/pets", query: { limit: "25" } },
      },
      {
        name: "GET /pets invalid limit (maximum:100)",
        req: { method: "GET", path: "/pets", query: { limit: "999" } },
      },
      {
        name: "POST /unknown → route (404)",
        req: { method: "POST", path: "/unknown", contentType: "application/json", body: {} },
      },
      {
        name: "DELETE /pets → method (405)",
        req: { method: "DELETE", path: "/pets" },
      },
    ];

    for (const c of cases) {
      const ra = runtime.validateRequest(c.req as never);
      const a = ra.valid ? null : ra.error;
      const b = treeOf(aot.validateRequest(c.req));
      if (!equivalent(a, b)) {
        console.error(
          `${c.name}\n  runtime: ${a === null ? "ok" : `${a.code} / ${collectLeafCodes(a).join(",")}`}\n  aot:     ${b === null ? "ok" : `${b.code} / ${collectLeafCodes(b).join(",")}`}`,
        );
      }
      expect(equivalent(a, b), c.name).toBe(true);
    }
  });

  it("matches emitted response headers case-insensitively", async () => {
    const aot = await buildAot(petstore);
    expect(
      aot.validateResponse(
        {
          method: "POST",
          path: "/pets",
          contentType: "application/json",
          headers: { "x-tenant": "acme" },
          body: { name: "Fido" },
        },
        { status: 201, headers: { "X-REQUEST-ID": "req-1" } },
      ),
    ).toEqual({ valid: true });
  });

  it("detectedVersion matches the spec's openapi bucket", async () => {
    const aot = await buildAot(petstore);
    expect(aot.detectedVersion).toBe("3.1");
  });

  it("warnings is an empty readonly array for a clean spec", async () => {
    const aot = await buildAot(petstore);
    expect(aot.warnings).toEqual([]);
  });

  it("warnings carries an unknown-minor fallback into the emitted module", async () => {
    const weird = { ...petstore, openapi: "3.7.0" };
    const aot = await buildAot(weird);
    expect(aot.detectedVersion).toBe(undefined);
    expect(aot.warnings.length).toBe(1);
    expect(aot.warnings[0]).toMatch(/3\.7\.0.*unknown 3\.x minor.*3\.1/);
    expect(Object.isFrozen(aot.warnings)).toBe(true);
  });

  it("warnings carries a missing-openapi fallback into the emitted module", async () => {
    const noVersion = { ...petstore } as Partial<OpenAPIDocument> as OpenAPIDocument;
    delete (noVersion as { openapi?: unknown }).openapi;
    const aot = await buildAot(noVersion);
    expect(aot.warnings.length).toBe(1);
    expect(aot.warnings[0]).toMatch(/openapi.*field.*must be a string/);
  });

  it("getOperation resolves a known (method, path)", async () => {
    const aot = await buildAot(petstore);
    expect(aot.getOperation({ method: "POST", path: "/pets" })?.pathPattern).toBe("/pets");
    expect(aot.getOperation({ method: "GET", path: "/unknown" })).toBe(null);
  });

  it("getOperation returns the full pathItem and operation objects", async () => {
    const aot = await buildAot(petstore);
    const info = aot.getOperation({ method: "POST", path: "/pets" });
    expect(info).not.toBe(null);
    const op = info?.operation as { operationId?: string; requestBody?: { required?: boolean } };
    expect(op.operationId).toBe("createPet");
    expect(op.requestBody?.required).toBe(true);
    const pathItem = info?.pathItem as { post?: { operationId?: string }; get?: unknown };
    expect(pathItem.post?.operationId).toBe("createPet");
    expect(pathItem.get).toBeDefined();
  });

  it("getOperation shape matches createValidator().getOperation", async () => {
    const runtime = createValidator(petstore);
    const aot = await buildAot(petstore);
    const target = { method: "POST", path: "/pets" };
    const rt = runtime.getOperation(target);
    const at = aot.getOperation(target);
    expect(at?.pathPattern).toBe(rt?.pathPattern);
    const rtOp = rt?.operation as { operationId?: string } | undefined;
    const atOp = at?.operation as { operationId?: string } | undefined;
    expect(atOp?.operationId).toBe(rtOp?.operationId);
  });
});

describe("compile-spec --requests-only", () => {
  it("emits a validateResponse that passes through (valid)", async () => {
    const aot = await buildAot(petstore, { requestsOnly: true });
    const r = aot.validateResponse(
      { method: "GET", path: "/pets" },
      { status: 999, contentType: "application/json", body: [{ shape: "wrong" }] },
    );
    expect(r).toEqual({ valid: true });
  });

  it("still validates requests correctly", async () => {
    const aot = await buildAot(petstore, { requestsOnly: true });
    const valid = aot.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      headers: { "x-tenant": "acme" },
      body: { name: "Fido" },
    });
    expect(valid).toEqual({ valid: true });
  });
});

describe("compile-spec --only", () => {
  it("returns exit code 2 when the spec file can't be loaded", async () => {
    // No `spec.json` in the memory reader → loadSpec throws → exit 2.
    // (Exit 3 is reserved for compile/bundle failures after a successful
    // load.) Pin the distinction so a future refactor can't collapse them.
    const mem = memoryIo([]);
    const res = await compileSpecCommand(
      {
        spec: "spec.json",
        overlays: [],
        output: "out.mjs",
        resolveDir: RESOLVE_DIR,
        bundleAlias: CORE_ALIASES,
      },
      mem.io,
    );
    expect(res.exitCode).toBe(2);
    expect(mem.stderr.value).toContain("compile-spec:");
  });

  it("drops unincluded ops from the router (→ route error on call)", async () => {
    // Include only POST /pets; GET /pets is dropped.
    const aot = await buildAot(petstore, {
      only: [{ method: "POST", path: "/pets" }],
    });
    // POST /pets still works
    const included = aot.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      headers: { "x-tenant": "acme" },
      body: { name: "Fido" },
    });
    expect(included).toEqual({ valid: true });

    // GET /pets dropped → route miss (404)
    const dropped = aot.validateRequest({ method: "GET", path: "/pets" });
    expect(flatErrors(dropped)[0]?.code).toBe("route");
  });
});

describe("compile-spec --output-mode / --max-errors (result-shape parity)", () => {
  // Two independent problems: missing required X-Tenant header AND a body
  // whose `name` violates minLength:1. Params validate before body, so the
  // uncapped leaf order is [header-param, minLength].
  const twoProblems = {
    method: "POST",
    path: "/pets",
    contentType: "application/json",
    body: { name: "" },
  };
  const validReq = {
    method: "POST",
    path: "/pets",
    contentType: "application/json",
    headers: { "x-tenant": "acme" },
    body: { name: "Fido" },
  };

  it("defaults to flat + maxErrors:1 (matches createValidator's zero-config)", async () => {
    const aot = await buildAot(petstore);
    const r = aot.validateRequest(twoProblems);
    expect(r).toMatchObject({ valid: false, truncated: true });
    expect(flatErrors(r)).toHaveLength(1);
    expect(aot.validateRequest(validReq)).toEqual({ valid: true });
  });

  it("--max-errors all collects every leaf (truncated: false)", async () => {
    const aot = await buildAot(petstore, { maxErrors: Number.POSITIVE_INFINITY });
    const r = aot.validateRequest(twoProblems);
    expect(r).toMatchObject({ valid: false, truncated: false });
    expect(flatErrors(r).length).toBeGreaterThanOrEqual(2);
  });

  it("--output-mode tree returns the nested error tree", async () => {
    const aot = await buildAot(petstore, {
      outputMode: "tree",
      maxErrors: Number.POSITIVE_INFINITY,
    });
    const r = aot.validateRequest(twoProblems);
    expect(r).toMatchObject({ valid: false });
    expect(treeOf(r)?.code).toBe("request");
  });

  it("--output-mode predicate returns a bare boolean", async () => {
    const aot = await buildAot(petstore, { outputMode: "predicate" });
    expect(aot.validateRequest(twoProblems)).toBe(false);
    expect(aot.validateRequest(validReq)).toBe(true);
  });
});

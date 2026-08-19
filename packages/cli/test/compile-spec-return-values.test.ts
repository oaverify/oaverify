/**
 * Parity tests for the emitted module's value channel, built through
 * `compileSpecCommand`'s `returnValues` option, against
 * `createValidator(document, { returnValues: true })` on the same
 * document and the same request. There is no commander flag for it.
 *
 * Every assertion that can be written as a comparison is written as one.
 * A hard-coded expectation would pin what this file's author believed
 * the runtime does; the contract is that the two agree, so the runtime
 * result is the expectation wherever it can be.
 *
 * The presence rule under test is `RequestValues`': a parameter appears
 * when the call reached it, deserialized it, and its schema accepted the
 * result. Absence therefore covers four different things (undeclared,
 * unsupplied, schema-rejected, never reached), and each has a case here.
 */

import { describe, expect, it } from "vitest";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { createValidator } from "@oaverify/internal-validator";
import { compileSpecCommand } from "../src/commands.js";
import { emitSpec } from "../src/emit-spec.js";
import { memoryIo } from "./fixtures.js";
import { workspaceAliases } from "../../../workspace-aliases.js";

const CORE_ALIASES = Object.fromEntries(
  Object.entries(
    workspaceAliases(resolvePath(fileURLToPath(new URL("../../..", import.meta.url)))),
  ).filter(([k]) => k.startsWith("@oaverify/core")),
);
const RESOLVE_DIR = resolvePath(fileURLToPath(new URL("../../oav", import.meta.url)));

interface ValuesModule {
  validateRequest: (req: unknown) => { valid: boolean; value?: RequestValueBag };
  validateResponse: (req: unknown, res: unknown) => { valid: boolean; value?: RequestValueBag };
  validateFetchRequest: (req: Request) => Promise<{ ok: boolean; value?: RequestValueBag }>;
}

interface RequestValueBag {
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  cookies: Record<string, unknown>;
}

async function buildAot(
  document: OpenAPIDocument,
  extra: { returnValues?: boolean; outputMode?: "flat" | "tree" | "predicate" } = {},
): Promise<ValuesModule> {
  const mem = memoryIo([["spec.json", document]]);
  const res = await compileSpecCommand(
    {
      spec: "spec.json",
      overlays: [],
      output: "out.mjs",
      resolveDir: RESOLVE_DIR,
      bundleAlias: CORE_ALIASES,
      ...extra,
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
  )) as ValuesModule;
}

/** The value channel of a result, or undefined when the result carries none. */
const valueOf = (r: { value?: RequestValueBag }): RequestValueBag | undefined => r.value;

const EMPTY = { path: {}, query: {}, headers: {}, cookies: {} };

/** Every location declared, plus a parameter with no schema at all. */
const spec: OpenAPIDocument = {
  openapi: "3.1.0",
  info: { title: "Values", version: "1" },
  components: {
    securitySchemes: { k: { type: "apiKey", in: "header", name: "X-Key" } },
    schemas: {
      Obj: { type: "object", properties: { a: { type: "string" }, n: { type: "integer" } } },
    },
  },
  paths: {
    "/t/{id}": {
      get: {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "n", in: "query", schema: { type: "integer" } },
          {
            name: "p",
            in: "query",
            style: "form",
            explode: true,
            schema: { $ref: "#/components/schemas/Obj" },
          },
          { name: "opt", in: "query", schema: { type: "string", default: "fallback" } },
          { name: "noschema", in: "query" },
          { name: "X-Spelled-Odd", in: "header", schema: { type: "string" } },
          { name: "c", in: "cookie", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/sec": {
      get: {
        security: [{ k: [] }],
        parameters: [{ name: "n", in: "query", schema: { type: "integer" } }],
        responses: { "200": { description: "ok" } },
      },
    },
    "/body": {
      post: {
        parameters: [{ name: "n", in: "query", schema: { type: "integer" } }],
        requestBody: {
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

const runtime = () => createValidator(spec, { returnValues: true, validateSecurity: "shape" });

describe("compile-spec: returnValues off", () => {
  it("emits byte-identically to the option's absence", () => {
    expect(emitSpec(spec, { returnValues: false })).toBe(emitSpec(spec));
  });

  it("emits no value-channel machinery at all", () => {
    const off = emitSpec(spec);
    for (const marker of ["emptyRequestValues", "__recordValue", "sink"]) {
      expect(off).not.toContain(marker);
    }
    const on = emitSpec(spec, { returnValues: true });
    for (const marker of ["emptyRequestValues", "__recordValue", "sink"]) {
      expect(on).toContain(marker);
    }
  });

  it("puts no value key on any result", async () => {
    const aot = await buildAot(spec);
    const valid = aot.validateRequest({ method: "GET", path: "/t/7", query: { n: "7" } });
    const invalid = aot.validateRequest({ method: "GET", path: "/t/7", query: { n: "x" } });
    expect("value" in valid).toBe(false);
    expect("value" in invalid).toBe(false);
  });
});

describe("compile-spec: returnValues presence rule vs createValidator", () => {
  it("carries every location on a request that populates all four", async () => {
    const aot = await buildAot(spec, { returnValues: true });
    const req = {
      method: "GET",
      path: "/t/7",
      query: { n: "7", a: "x" },
      headers: { "x-spelled-odd": "hv" },
      cookies: { c: "cv" },
    };
    const rt = runtime().validateRequest(req as never) as { value: RequestValueBag };
    const got = aot.validateRequest(req);
    expect(got.valid).toBe(true);
    expect(valueOf(got)).toEqual(rt.value);
    // Spelled out as well as compared, so a runtime regression cannot
    // make both sides agree on something wrong without this failing.
    expect(valueOf(got)).toEqual({
      path: { id: "7" },
      query: { n: 7, p: { a: "x", n: 7 } },
      headers: { "X-Spelled-Odd": "hv" },
      cookies: { c: "cv" },
    });
  });

  it("keys a header parameter by the document's spelling, not the wire's", async () => {
    const aot = await buildAot(spec, { returnValues: true });
    const req = { method: "GET", path: "/t/7", headers: { "X-SPELLED-ODD": "shouty" } };
    const rt = runtime().validateRequest(req as never) as { value: RequestValueBag };
    expect(valueOf(aot.validateRequest(req))).toEqual(rt.value);
    expect(valueOf(aot.validateRequest(req))?.headers).toEqual({ "X-Spelled-Odd": "shouty" });
  });

  it("carries the parameters that passed on an invalid request", async () => {
    const aot = await buildAot(spec, { returnValues: true });
    const req = {
      method: "GET",
      path: "/t/7",
      query: { n: "not-an-integer" },
      cookies: { c: "cv" },
    };
    const rt = runtime().validateRequest(req as never) as { value: RequestValueBag };
    const got = aot.validateRequest(req);
    expect(got.valid).toBe(false);
    expect(valueOf(got)).toEqual(rt.value);
    expect(valueOf(got)).toEqual({
      path: { id: "7" },
      query: {},
      headers: {},
      cookies: { c: "cv" },
    });
  });

  it("omits an undeclared parameter, an unsupplied one, and a schema-less one", async () => {
    const aot = await buildAot(spec, { returnValues: true });
    const req = { method: "GET", path: "/t/7", query: { undeclared: "1", noschema: "hello" } };
    const rt = runtime().validateRequest(req as never) as { value: RequestValueBag };
    const got = aot.validateRequest(req);
    expect(got.valid).toBe(true);
    expect(valueOf(got)).toEqual(rt.value);
    // `noschema` passed and is still absent: the presence rule is
    // "a schema accepted it", and a parameter with no schema never
    // reaches one. `undeclared` and the unsupplied `n` are absent for
    // the other two reasons.
    expect(valueOf(got)).toEqual({ path: { id: "7" }, query: {}, headers: {}, cookies: {} });
  });

  it("omits an allowEmptyValue parameter that arrived empty", async () => {
    // The runtime skips the schema for `?p=` here, and the channel only
    // holds values a schema accepted, so the parameter is absent even
    // though the client sent it and the request is valid. The schema
    // deliberately accepts the empty string: with one that rejects it
    // the verdict would carry the difference, and the point of this
    // case is that the verdict cannot.
    const doc: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "Empty", version: "1" },
      paths: {
        "/t": {
          get: {
            parameters: [
              { name: "p", in: "query", allowEmptyValue: true, schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const aot = await buildAot(doc, { returnValues: true });
    const req = { method: "GET", path: "/t", query: { p: "" } };
    const rt = createValidator(doc, { returnValues: true }).validateRequest(req as never) as {
      valid: boolean;
      value: RequestValueBag;
    };
    const got = aot.validateRequest(req);
    expect(got.valid).toBe(true);
    expect(rt.valid).toBe(true);
    expect(valueOf(got)).toEqual(rt.value);
    expect(valueOf(got)).toEqual(EMPTY);
  });

  it("fills in no schema default for an unsupplied parameter", async () => {
    const aot = await buildAot(spec, { returnValues: true });
    const req = { method: "GET", path: "/t/7" };
    const rt = runtime().validateRequest(req as never) as { value: RequestValueBag };
    expect(valueOf(aot.validateRequest(req))).toEqual(rt.value);
    expect(valueOf(aot.validateRequest(req))?.query).not.toHaveProperty("opt");
  });

  it("keeps a parameter named __proto__ or constructor as an own key", async () => {
    const hostile: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: "Hostile", version: "1" },
      paths: {
        "/h": {
          get: {
            parameters: [
              { name: "__proto__", in: "query", schema: { type: "string" } },
              { name: "constructor", in: "query", schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const aot = await buildAot(hostile, { returnValues: true });
    // Built by assignment: `{ __proto__: "x" }` in a literal sets the
    // prototype and produces no key at all, so the literal spelling
    // would test nothing.
    const query: Record<string, string> = Object.create(null) as Record<string, string>;
    query["__proto__"] = "x";
    query["constructor"] = "y";
    const req = { method: "GET", path: "/h", query };
    const rt = createValidator(hostile, { returnValues: true }).validateRequest(req as never) as {
      value: RequestValueBag;
    };
    const got = valueOf(aot.validateRequest(req));
    expect(Object.keys(got?.query ?? {})).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(got?.query)).toBeNull();
    expect(Object.keys(got?.query ?? {})).toEqual(Object.keys(rt.value.query));
  });
});

describe("compile-spec: returnValues on a request no parameter was reached by", () => {
  // Four cases, one rule: `validateRequest` allocates the accumulator
  // before the walk and attaches it whatever the walk returned, so the
  // channel is present and empty rather than absent. The runtime TSDoc
  // names the two gates; the route cases behave the same way and are
  // pinned here because nothing else states them.
  const cases: Array<[string, Record<string, unknown>]> = [
    ["route miss", { method: "GET", path: "/no-such-path" }],
    ["method not allowed", { method: "DELETE", path: "/t/7" }],
    ["security gate", { method: "GET", path: "/sec", query: { n: "7" } }],
    [
      "request-body content-type gate",
      { method: "POST", path: "/body", query: { n: "7" }, contentType: "text/plain", body: "x" },
    ],
  ];

  for (const [name, req] of cases) {
    it(`returns an empty channel on ${name}`, async () => {
      const aot = await buildAot(spec, { returnValues: true });
      const rt = runtime().validateRequest(req as never) as {
        valid: boolean;
        value: RequestValueBag;
      };
      const got = aot.validateRequest(req);
      expect(got.valid).toBe(false);
      expect(rt.valid).toBe(false);
      expect(valueOf(got)).toEqual(rt.value);
      expect(valueOf(got)).toEqual(EMPTY);
    });
  }
});

describe("compile-spec: returnValues across output modes and entry points", () => {
  it("carries the channel on a tree-mode result", async () => {
    const aot = await buildAot(spec, { returnValues: true, outputMode: "tree" });
    const rtTree = createValidator(spec, { returnValues: true, output: "tree" });
    const req = { method: "GET", path: "/t/7", query: { n: "bad", a: "x" } };
    const rt = rtTree.validateRequest(req as never) as { value: RequestValueBag };
    const got = aot.validateRequest(req);
    expect(got.valid).toBe(false);
    expect(valueOf(got)).toEqual(rt.value);
    expect(valueOf(got)?.path).toEqual({ id: "7" });
  });

  it("refuses predicate output at emit time, the way createValidator refuses at construction", () => {
    expect(() => emitSpec(spec, { returnValues: true, outputMode: "predicate" })).toThrow(
      /returnValues.*predicate/s,
    );
    expect(() => createValidator(spec, { returnValues: true, output: "predicate" })).toThrow(
      /returnValues.*predicate/s,
    );
  });

  it("reports the predicate refusal as a compile-spec failure", async () => {
    const mem = memoryIo([["spec.json", spec]]);
    const res = await compileSpecCommand(
      {
        spec: "spec.json",
        overlays: [],
        output: "out.mjs",
        resolveDir: RESOLVE_DIR,
        bundleAlias: CORE_ALIASES,
        returnValues: true,
        outputMode: "predicate",
      },
      mem.io,
    );
    expect(res.exitCode).toBe(3);
    expect(mem.stderr.value).toContain("returnValues");
  });

  it("carries the channel through validateFetchRequest", async () => {
    const aot = await buildAot(spec, { returnValues: true });
    const rt = createValidator(spec, { returnValues: true });
    const url = "https://example.test/t/7?n=7";
    const got = await aot.validateFetchRequest(new Request(url));
    const want = (await rt.validateFetchRequest(new Request(url))) as { value: RequestValueBag };
    expect(got.ok).toBe(true);
    expect(got.value).toEqual(want.value);
    expect(got.value?.path).toEqual({ id: "7" });
  });

  it("returns an empty channel when the fetch body cannot be parsed", async () => {
    const aot = await buildAot(spec, { returnValues: true });
    const rt = createValidator(spec, { returnValues: true });
    const make = () =>
      new Request("https://example.test/body?n=7", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      });
    const got = await aot.validateFetchRequest(make());
    const want = (await rt.validateFetchRequest(make())) as { value: RequestValueBag };
    expect(got.ok).toBe(false);
    expect(got.value).toEqual(want.value);
    expect(got.value).toEqual(EMPTY);
  });

  it("puts no channel on validateResponse", async () => {
    const aot = await buildAot(spec, { returnValues: true });
    const res = aot.validateResponse({ method: "GET", path: "/t/7" }, { status: 200, headers: {} });
    expect("value" in res).toBe(false);
  });

  it("puts no request body in the channel", async () => {
    const aot = await buildAot(spec, { returnValues: true });
    const req = {
      method: "POST",
      path: "/body",
      query: { n: "7" },
      contentType: "application/json",
      body: { anything: true },
    };
    const rt = createValidator(spec, { returnValues: true }).validateRequest(req as never) as {
      value: RequestValueBag;
    };
    const got = valueOf(aot.validateRequest(req));
    expect(got).toEqual(rt.value);
    expect(JSON.stringify(got)).not.toContain("anything");
  });
});

/**
 * Parity tests for the emitted module's value channel, built through
 * `compileSpecCommand`'s `returnValues` option, against
 * `createValidator(document, { returnValues: true })` on the same
 * document and the same request. `--return-values` is the flag; the
 * argv cover for it is at the foot of this file.
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

import { pathEncodingCases, pathEncodingDocument } from "../../../test/fixtures/path-encoding.js";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
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

describe("effective parameter preparation", () => {
  const document = (parameters: unknown, inherited: unknown = []): OpenAPIDocument =>
    ({
      openapi: "3.1.0",
      info: { title: "Parameters", version: "1" },
      paths: {
        "/t": {
          parameters: inherited,
          get: { parameters, responses: { "200": { description: "ok" } } },
        },
      },
      components: {
        parameters: {
          Alias: { $ref: "#/components/parameters/Limit" },
          Limit: {
            name: "n",
            in: "query",
            required: true,
            schema: { type: "integer", minimum: 2 },
          },
        },
      },
    }) as unknown as OpenAPIDocument;

  it("resolves an override chain and preserves distinct locations and exact names", async () => {
    const doc = document(
      [
        { $ref: "#/components/parameters/Alias" },
        { name: "N", in: "query", schema: { type: "string" } },
      ],
      [
        { name: "n", in: "query", schema: { type: "string", const: "old" } },
        { name: "n", in: "cookie", schema: { type: "string" } },
      ],
    );
    const validators = [
      createValidator(doc, { returnValues: true }),
      await buildAot(doc, { returnValues: true }),
    ];
    for (const validator of validators) {
      expect(
        validator.validateRequest({
          method: "GET",
          path: "/t",
          query: { n: "3", N: "upper" },
          cookies: { n: "cookie" },
        }),
      ).toMatchObject({
        valid: true,
        value: { ...EMPTY, query: { n: 3, N: "upper" }, cookies: { n: "cookie" } },
      });
      expect(
        validator.validateRequest({ method: "GET", path: "/t", query: { n: "1" } }),
      ).toMatchObject({ valid: false });
      expect(validator.validateRequest({ method: "GET", path: "/t" })).toMatchObject({
        valid: false,
      });
    }
  });

  it.each([
    { parameters: [null, 5, "oops", true] },
    { parameters: { name: "n", in: "query", required: true } },
  ])("leaves malformed parameter shapes to document conformance: %j", async ({ parameters }) => {
    const doc = document(parameters, parameters);
    for (const validator of [
      createValidator(doc, { returnValues: true }),
      await buildAot(doc, { returnValues: true }),
    ]) {
      expect(validator.validateRequest({ method: "GET", path: "/t" })).toMatchObject({
        valid: true,
        value: EMPTY,
      });
    }
  });

  it("ignores reserved headers and uses the first schema-bearing content entry", async () => {
    const doc = document([
      { name: "Accept", in: "header", required: true, schema: false },
      { name: "CONTENT-TYPE", in: "header", required: true, schema: false },
      { name: "Authorization", in: "header", required: true, schema: false },
      {
        name: "p",
        in: "query",
        schema: { type: "string" },
        content: { "text/plain": null, "application/json": { schema: { type: "integer" } } },
      },
      { name: "q", in: "query", content: { "application/json": { schema: false } } },
    ]);
    for (const validator of [
      createValidator(doc, { returnValues: true }),
      await buildAot(doc, { returnValues: true }),
    ]) {
      expect(
        validator.validateRequest({ method: "GET", path: "/t", query: { p: "3" } }),
      ).toMatchObject({ valid: true, value: { ...EMPTY, query: { p: 3 } } });
      expect(
        validator.validateRequest({ method: "GET", path: "/t", query: { q: "3" } }),
      ).toMatchObject({ valid: false });
    }
  });
});

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

/**
 * Both sides, opted into the same two options.
 *
 * `validateSecurity` is on because one case below drives the security
 * gate, and neither side checks by default: the emitted module gained
 * the option in #895, and before that it checked operation-level
 * requirements unconditionally, which is what let this file compare an
 * opted-in runtime against a default AOT.
 */
const AOT_OPTIONS = { returnValues: true, validateSecurity: "shape" } as const;
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
    const aot = await buildAot(spec, AOT_OPTIONS);
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
    const aot = await buildAot(spec, AOT_OPTIONS);
    const req = { method: "GET", path: "/t/7", headers: { "X-SPELLED-ODD": "shouty" } };
    const rt = runtime().validateRequest(req as never) as { value: RequestValueBag };
    expect(valueOf(aot.validateRequest(req))).toEqual(rt.value);
    expect(valueOf(aot.validateRequest(req))?.headers).toEqual({ "X-Spelled-Odd": "shouty" });
  });

  it("carries the parameters that passed on an invalid request", async () => {
    const aot = await buildAot(spec, AOT_OPTIONS);
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
    const aot = await buildAot(spec, AOT_OPTIONS);
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
    const aot = await buildAot(spec, AOT_OPTIONS);
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
      const aot = await buildAot(spec, AOT_OPTIONS);
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
    const aot = await buildAot(spec, AOT_OPTIONS);
    const rt = createValidator(spec, { returnValues: true });
    const url = "https://example.test/t/7?n=7";
    const got = await aot.validateFetchRequest(new Request(url));
    const want = (await rt.validateFetchRequest(new Request(url))) as { value: RequestValueBag };
    expect(got.ok).toBe(true);
    expect(got.value).toEqual(want.value);
    expect(got.value?.path).toEqual({ id: "7" });
  });

  it("returns an empty channel when the fetch body cannot be parsed", async () => {
    const aot = await buildAot(spec, AOT_OPTIONS);
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
    const aot = await buildAot(spec, AOT_OPTIONS);
    const res = aot.validateResponse({ method: "GET", path: "/t/7" }, { status: 200, headers: {} });
    expect("value" in res).toBe(false);
  });

  it("puts no request body in the channel", async () => {
    const aot = await buildAot(spec, AOT_OPTIONS);
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

describe("compile-spec --return-values (argv)", () => {
  const SPEC = {
    openapi: "3.1.1",
    info: { title: "t", version: "1" },
    paths: {
      "/t": {
        get: {
          parameters: [{ name: "p", in: "query", schema: { type: "integer" } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };

  /**
   * Parse argv and run the action, capturing the exit code and stderr.
   *
   * Nothing here may assert on emitted output. The CLI action calls
   * `compileSpecCommand` without `resolveDir` or `bundleAlias`, so
   * esbuild has to resolve a real `@oaverify/core`, which exists only
   * after `pnpm build`. `pnpm test` runs against each package's `src`
   * with no build, so a test that waits for a bundle passes on a
   * machine that happens to have built and fails in CI. It did.
   *
   * What the emitted module contains is covered above, through
   * `compileSpecCommand` with both of those supplied.
   */
  async function run(argv: string[]): Promise<{ exitCode: number; err: string }> {
    const mem = memoryIo([["spec.json", SPEC]]);
    let exitCode = 0;
    const program = buildProgram({
      io: mem.io,
      exit: (code: number) => {
        exitCode = code;
      },
    });
    await program.parseAsync(["node", "oaverify", ...argv]);
    return { exitCode, err: mem.stderr.value };
  }

  /** The parsed options of the compile-spec subcommand. */
  async function opts(argv: string[]): Promise<Record<string, unknown>> {
    const mem = memoryIo([["spec.json", SPEC]]);
    const program = buildProgram({ io: mem.io, exit: () => {} });
    await program.parseAsync(["node", "oaverify", ...argv]);
    return program.commands.find((c) => c.name() === "compile-spec")?.opts() ?? {};
  }

  it("parses, and is off when absent", async () => {
    expect(
      (await opts(["compile-spec", "spec.json", "--return-values", "-o", "out.mjs"])).returnValues,
    ).toBe(true);
    expect((await opts(["compile-spec", "spec.json", "-o", "out.mjs"])).returnValues).toBe(false);
  });

  it("reaches the emitter, which is what refusing predicate mode proves", async () => {
    // This doubles as the pass-through cover. `emitSpec` rejects the
    // pair before anything is bundled, so the run gets that far without
    // a build; and it can only reject when the flag actually arrived,
    // since `returnValues: false` compiles predicate mode fine. The
    // sentence is the emitter's, and the one `createValidator` throws
    // at construction, so a caller reads the same words either way.
    const { exitCode, err } = await run([
      "compile-spec",
      "spec.json",
      "--return-values",
      "--output-mode",
      "predicate",
      "-o",
      "out.mjs",
    ]);
    expect(exitCode).toBe(3);
    expect(err).toContain('`returnValues` cannot be combined with `outputMode: "predicate"`');
  });

  it("leaves emission byte-identical when off", async () => {
    // Not an argv assertion, and here because it is the other half of
    // the flag's contract: absent, it has to change nothing at all.
    expect(emitSpec(SPEC as OpenAPIDocument)).toBe(
      emitSpec(SPEC as OpenAPIDocument, { returnValues: false }),
    );
  });
});

describe.each(["3.0.4", "3.1.0", "3.2.0"])("encoded path parity (%s)", (openapi) => {
  it.each(["tree", "flat", "predicate"] as const)(
    "preserves wire data in %s output",
    async (outputMode) => {
      const doc = pathEncodingDocument({}, openapi);
      doc.paths = {};
      for (const [i, [name, parameter]] of pathEncodingCases.entries()) {
        const single = pathEncodingDocument(parameter, openapi, name === "compound capture");
        const [path, item] = Object.entries(single.paths!)[0]!;
        doc.paths[path.replace("/t/", `/t${i}/`)] = item;
      }
      doc.paths["/invalid/{p}"] = pathEncodingDocument(
        { schema: { type: "array", items: { type: "integer" } } },
        openapi,
      ).paths!["/t/{p}"]!;
      for (const style of ["label", "matrix"] as const) {
        doc.paths[`/${style}/{p}`] = pathEncodingDocument(
          { style, schema: { type: "string" } },
          openapi,
        ).paths!["/t/{p}"]!;
      }
      for (const returnValues of outputMode === "predicate" ? [false] : [true, false]) {
        const options = { outputMode, returnValues };
        const aot = await buildAot(doc, options);
        const runtime = createValidator(doc, { output: outputMode, returnValues });
        for (const [i, [name, , wire, expected]] of pathEncodingCases.entries()) {
          const token = name === "compound capture" ? `pre-${wire}.json` : wire;
          const req = { method: "get", path: `/t${i}/${token}` };
          const result = runtime.validateRequest(req);
          expect(typeof result === "boolean" ? result : result.valid).toBe(true);
          if (returnValues) expect(result).toMatchObject({ value: { path: { p: expected } } });
          expect(aot.validateRequest(req)).toEqual(result);
        }
        for (const path of ["/invalid/%31%2C%32", "/label/%2Ea", "/matrix/%3Bp=a"]) {
          const invalid = { method: "GET", path };
          const rejected = runtime.validateRequest(invalid);
          expect(typeof rejected === "boolean" ? rejected : rejected.valid).toBe(false);
          expect(aot.validateRequest(invalid)).toEqual(rejected);
        }
      }
    },
  );
});

describe("compile-spec: HTTP whitespace in simple-style header lists (#1198)", () => {
  const strings = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } };
  const ints = { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } } };
  const header = (name: string, schema: object, extra: object = {}) => ({
    name,
    in: "header",
    schema,
    ...extra,
  });
  const doc = {
    openapi: "3.1.0",
    info: { title: "Header lists", version: "1" },
    paths: {
      "/h": {
        get: {
          parameters: [
            header("X-Ints", { type: "array", items: { type: "integer" } }),
            header("X-Strings", { type: "array", items: { type: "string" } }, { style: "simple" }),
            header("X-Flat", ints),
            header("X-Flat-Strings", strings, { explode: false }),
            header("X-Exploded", strings, { explode: true }),
            header("X-Scalar", { type: "string" }),
          ],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  } as unknown as OpenAPIDocument;

  async function values(headers: Record<string, string>): Promise<RequestValueBag | undefined> {
    const aot = await buildAot(doc, { returnValues: true });
    const runtime = createValidator(doc, { returnValues: true });
    const req = { method: "GET", path: "/h", headers };
    const want = runtime.validateRequest(req);
    expect(aot.validateRequest(req)).toEqual(want);
    expect(want.valid).toBe(true);
    return valueOf(want as { value?: RequestValueBag });
  }

  it("drops space and tab at list member boundaries", async () => {
    expect(
      await values({
        "x-ints": "1, 2,\t3 ",
        "x-strings": "a b , c",
        "x-flat": "a, 1, b ,2",
        "x-flat-strings": "a, x y ,b,\tz",
        "x-exploded": "a=x y , b=z",
      }),
    ).toMatchObject({
      headers: {
        "X-Ints": [1, 2, 3],
        "X-Strings": ["a b", "c"],
        "X-Flat": { a: 1, b: 2 },
        "X-Flat-Strings": { a: "x y", b: "z" },
        "X-Exploded": { a: "x y", b: "z" },
      },
    });
  });

  it("keeps whitespace around '=' and other whitespace characters", async () => {
    expect(
      await values({
        "x-strings": "a,\u00a0b,\nc",
        "x-exploded": "a = x, b= y",
        "x-scalar": "a, b",
      }),
    ).toMatchObject({
      headers: {
        "X-Strings": ["a", "\u00a0b", "\nc"],
        "X-Exploded": { "a ": " x", b: " y" },
        "X-Scalar": "a, b",
      },
    });
  });

  it("reads Fetch's comma-space join of repeated header lines", async () => {
    const aot = await buildAot(doc, { returnValues: true });
    const runtime = createValidator(doc, { returnValues: true });
    const make = () => {
      const headers = new Headers();
      headers.append("X-Ints", "1");
      headers.append("X-Ints", "2");
      return new Request("https://example.test/h", { headers });
    };
    const want = (await runtime.validateFetchRequest(make())) as {
      ok: boolean;
      value: RequestValueBag;
    };
    expect(want.ok).toBe(true);
    expect(want.value.headers).toEqual({ "X-Ints": [1, 2] });
    expect((await aot.validateFetchRequest(make())).value).toEqual(want.value);
  });

  it("leaves other parameter locations alone", async () => {
    // Each of these also splits a list on ",".
    const list = { type: "array", items: { type: "string" } };
    const others = {
      ...doc,
      paths: {
        "/o/{p}": {
          get: {
            parameters: [
              { name: "p", in: "path", required: true, schema: list },
              { name: "q", in: "query", explode: false, schema: list },
              { name: "c", in: "cookie", explode: false, schema: list },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    const runtime = createValidator(others, { returnValues: true });
    const aot = await buildAot(others, { returnValues: true });
    const req = {
      method: "GET",
      path: "/o/a,%20b",
      query: { q: "a, b" },
      cookies: { c: "a, b" },
    };
    const want = runtime.validateRequest(req);
    expect(want).toMatchObject({
      value: { path: { p: ["a", " b"] }, query: { q: ["a", " b"] }, cookies: { c: ["a", " b"] } },
    });
    expect(aot.validateRequest(req)).toEqual(want);
  });
});

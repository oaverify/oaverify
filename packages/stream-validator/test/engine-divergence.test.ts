/**
 * Divergences the differential suites cannot see: they compare verdicts
 * only for schemas both engines load, and they feed values through
 * `JSON.stringify`.
 *
 * Two contracts live here. The loadability blocks pin today's behaviour
 * against the issue that owns the repair, and go red when it lands; fix
 * them in that change. The duplicate-key block pins an intended
 * departure (`@specBoundary resolves` on `createStreamValidator`), where
 * red is a regression.
 */
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema, jsonSchemaDialect, oas30Dialect } from "@oaverify/internal-schema";
import {
  ClassifierError,
  createStreamValidator,
  type StreamValidatorOptions,
  type StreamVerdict,
} from "../src/index.js";
import { first } from "./helpers.js";

const enc = new TextEncoder();

/** Stream-validate raw bytes under detach with an unbounded budget. */
async function streamRun(
  schema: SchemaOrBoolean,
  raw: string,
  opts: StreamValidatorOptions = {},
): Promise<StreamVerdict> {
  const validator = createStreamValidator(schema, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
    ...opts,
  });
  validator.on("error", () => {});
  validator.resume();
  const result = validator.result;
  validator.end(Buffer.from(enc.encode(raw)));
  return await result;
}

function inMemory(schema: SchemaOrBoolean, value: unknown) {
  return compileSchema(schema, {
    dialect: jsonSchemaDialect,
    maxErrors: Number.POSITIVE_INFINITY,
  }).validate(value);
}

describe("loadability: the in-memory compiler refuses what the stream accepts (#919)", () => {
  it('required: "id" (a string) loads in the stream and is ignored', async () => {
    const schema = { type: "object", required: "id" } as never;
    expect(() => compileSchema(schema, { dialect: jsonSchemaDialect })).toThrow(
      /keyword "required" requires an array of strings/,
    );
    // The spine gates on `Array.isArray(s.required)`, so a malformed
    // list is absent rather than rejected.
    expect((await streamRun(schema, '{"a":1}')).valid).toBe(true);
  });

  it("dependencies: {x: [1]} loads in the stream and misfires", async () => {
    const schema = { type: "object", dependencies: { x: [1] } } as never;
    expect(() => compileSchema(schema, { dialect: jsonSchemaDialect })).toThrow(
      /keyword "dependencies" entry "x" requires an array of strings/,
    );
    // A non-string entry is looked up against the frame's string keys
    // and never hits, so "x" fails even with a key "1" present.
    const verdict = await streamRun(schema, '{"x":1,"1":2}');
    expect(verdict.valid).toBe(false);
    expect(first(verdict.violations).code).toBe("dependencies");
  });
});

describe("loadability: the stream refuses what the in-memory compiler accepts (#998)", () => {
  // OAS 3.0 discards a `$ref`'s siblings, so the in-memory compiler
  // compiles this and the sibling is dead. The classifier reads every
  // keyword on the node when handed a bare dialect.
  const schema: SchemaOrBoolean = {
    type: "object",
    properties: { a: { $ref: "#/$defs/S", unevaluatedProperties: false } },
    $defs: { S: { type: "object" } },
  };

  it("bare oas30Dialect: core compiles, the stream throws ClassifierError", () => {
    const core = compileSchema(schema, { dialect: oas30Dialect });
    expect(core.validate({ a: { anything: 1 } }).valid).toBe(true);
    try {
      createStreamValidator(schema, { dialect: oas30Dialect });
      expect.unreachable("expected ClassifierError");
    } catch (err) {
      expect(err).toBeInstanceOf(ClassifierError);
      expect((err as ClassifierError).keyword).toBe("unevaluatedProperties");
      expect((err as ClassifierError).path).toBe("properties.a");
    }
  });

  it('openApiVersion: "3.0" normalizes the sibling away and streams', async () => {
    const verdict = await streamRun(schema, '{"a":{"anything":1}}', {
      openApiVersion: "3.0",
    });
    expect(verdict.valid).toBe(true);
  });
});

describe("duplicate input keys: the documented spec boundary", () => {
  // The spine counts every occurrence toward `minProperties` and
  // `maxProperties`; in-memory keeps the last, as `JSON.parse` does. A
  // buffered island keeps the last too, so the engine's two paths
  // disagree with in-memory in opposite directions. These inputs exist
  // only as raw bytes.
  it("maxProperties: the stream counts both occurrences, in-memory sees one", async () => {
    const schema: SchemaOrBoolean = { type: "object", maxProperties: 1 };
    expect(inMemory(schema, JSON.parse('{"a":1,"a":2}')).valid).toBe(true);
    const verdict = await streamRun(schema, '{"a":1,"a":2}');
    expect(verdict.valid).toBe(false);
    expect(first(verdict.violations).code).toBe("maxProperties");
  });

  it("minProperties: the stream counts both occurrences, in-memory sees one", async () => {
    const schema: SchemaOrBoolean = { type: "object", minProperties: 2 };
    expect(inMemory(schema, JSON.parse('{"a":1,"a":2}')).valid).toBe(false);
    expect((await streamRun(schema, '{"a":1,"a":2}')).valid).toBe(true);
  });

  it("a buffered island keeps the last occurrence, like in-memory", async () => {
    const schema: SchemaOrBoolean = { const: { a: 2 } };
    expect(inMemory(schema, JSON.parse('{"a":1,"a":2}')).valid).toBe(true);
    expect((await streamRun(schema, '{"a":1,"a":2}')).valid).toBe(true);
  });
});

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema, jsonSchemaDialect } from "@oaverify/internal-schema";
import { classify, ClassifierError } from "../src/classifier/index.js";
import { createStreamValidator, type StreamVerdict } from "../src/index.js";

/** Narrow a settled stream result to its error branch. */
function asError(value: unknown): Error {
  if (!(value instanceof Error)) throw new Error(`expected an Error, got ${typeof value}`);
  return value;
}

const enc = new TextEncoder();

async function verdictOf(
  schema: SchemaOrBoolean,
  value: unknown,
  opts: Record<string, unknown> = {},
): Promise<StreamVerdict> {
  const validator = createStreamValidator(schema, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
    ...opts,
  });
  validator.on("error", () => {});
  validator.resume();
  const result = validator.result;
  validator.end(Buffer.from(enc.encode(JSON.stringify(value))));
  return result;
}

function inMem(schema: SchemaOrBoolean, value: unknown): boolean {
  return compileSchema(schema as never, {
    dialect: jsonSchemaDialect,
    maxErrors: Number.POSITIVE_INFINITY,
  }).validate(value).valid;
}

async function expectParity(schema: SchemaOrBoolean, values: unknown[]): Promise<void> {
  for (const value of values) {
    const streamed = (await verdictOf(schema, value)).valid;
    expect(streamed, `${JSON.stringify(schema)} vs ${JSON.stringify(value)}`).toBe(
      inMem(schema, value),
    );
  }
}

describe("draft-07 dependencies (array form)", () => {
  it("enforces a property-presence dependency", async () => {
    await expectParity(
      {
        type: "object",
        dependencies: { creditCard: ["billingAddress"] },
      } as unknown as SchemaOrBoolean,
      [{}, { creditCard: "x" }, { creditCard: "x", billingAddress: "y" }, { billingAddress: "y" }],
    );
  });
});

describe("$dynamicRef is followed (static anchor)", () => {
  it("applies the dynamic-anchor target's constraints", async () => {
    const schema: SchemaObject = {
      $defs: { Thing: { $dynamicAnchor: "T", type: "string" } },
      $dynamicRef: "#T",
    };
    await expectParity(schema, ["ok", 1, null]);
  });
});

describe("percent-encoded JSON pointer refs resolve", () => {
  it("resolves #/$defs/Record%3Cx%3E like @oaverify/internal-schema", async () => {
    const schema: SchemaObject = {
      type: "object",
      properties: { id: { $ref: "#/$defs/Record%3Cx%3E" } },
      $defs: { "Record<x>": { type: "string" } },
    };
    // Must not fail-fast at construction, and must validate the target.
    await expectParity(schema, [{ id: "a" }, { id: 1 }, {}]);
  });
});

describe("maxBufferedBytes is enforced on a single-chunk scalar", () => {
  it("rejects a large string delivered in one chunk", async () => {
    const validator = createStreamValidator(
      { type: "string", pattern: "^a*$" },
      { maxBufferedBytes: 8 },
    );
    validator.on("error", () => {});
    validator.resume();
    const guard = validator.result.catch((e) => e as Error);
    const big = `"${"a".repeat(500)}"`;
    // One giant chunk: the per-chunk-start check never fires; the
    // end-offset check must catch it.
    await expect(
      pipeline(
        Readable.from([Buffer.from(enc.encode(big))]),
        validator,
        new Writable({ write: (_c, _e, cb) => cb() }),
      ),
    ).rejects.toThrow(/maxBufferedBytes/);
    expect(asError(await guard).message).toMatch(/maxBufferedBytes/);
  });
});

describe("maxErrors short-circuits exactly", () => {
  it("collects no more than maxErrors violations", async () => {
    const schema: SchemaObject = {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" }, c: { type: "integer" } },
    };
    const verdict = await verdictOf({ ...schema }, { a: "x", b: "y", c: "z" }, { maxErrors: 1 });
    expect(verdict.valid).toBe(false);
    expect(verdict.violations).toHaveLength(1);
  });
});

describe("runtime backstop for a registered-but-unclassified keyword", () => {
  it("REJECTs a dispatched keyword missing from the classification table", () => {
    const fakeDialect = {
      id: "fake",
      vocabularies: [
        ...jsonSchemaDialect.vocabularies,
        {
          uri: "urn:fake",
          keywords: [{ keyword: "madeUpKw", vocabulary: "urn:fake", compile() {} }],
        },
      ],
      rules: { refSuppressesSiblings: false },
    };
    expect(() =>
      classify({ madeUpKw: true } as SchemaObject, { dialect: fakeDialect as never }),
    ).toThrow(ClassifierError);
  });
});

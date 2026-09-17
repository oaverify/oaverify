import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { OpenAPIDocument, SchemaOrBoolean } from "@oaverify/internal-core";
import { createValidator } from "@oaverify/internal-validator";
import {
  analyzeSpec,
  streamValidatorForOperation,
} from "../packages/stream-validator/src/index.js";
import type { StreamValidatorOptions } from "../packages/stream-validator/src/options.js";

function document(
  openapi: string,
  schema: SchemaOrBoolean,
  schemas: Record<string, SchemaOrBoolean>,
): OpenAPIDocument {
  const content = { "application/json": { schema } };
  return {
    openapi,
    info: { title: "refs", version: "1" },
    paths: {
      "/x": {
        post: { requestBody: { content }, responses: { "200": { description: "ok", content } } },
      },
    },
    components: { schemas },
  };
}

async function valid(doc: OpenAPIDocument, value: unknown, options: StreamValidatorOptions = {}) {
  const stream = streamValidatorForOperation(
    doc,
    { method: "post", path: "/x" },
    { ...options, policy: "detach" },
  );
  await pipeline(
    Readable.from([JSON.stringify(value)]),
    stream,
    new Writable({
      write(_c, _e, cb) {
        cb();
      },
    }),
  );
  return (await stream.result).valid;
}

const ref = (name: string) => `#/components/schemas/${name}`;

describe.each(["3.0.3", "3.1.0", "3.2.0"])("body ref siblings in %s", (openapi) => {
  const modern = !openapi.startsWith("3.0");
  it("preserves use-site and chained constraints with HTTP verdict parity", async () => {
    const doc = document(
      openapi,
      { $ref: ref("Alias"), maxLength: 3 },
      {
        Alias: { $ref: ref("Text"), minLength: 2 },
        Text: { type: "string" },
      },
    );
    const core = createValidator(doc);
    for (const [value, expected] of [
      ["ab", true],
      ["a", !modern],
      ["abcd", !modern],
      [1, false],
    ] as const) {
      expect(await valid(doc, value)).toBe(expected);
      expect(
        core.validateRequest({
          method: "POST",
          path: "/x",
          contentType: "application/json",
          body: value,
        }).valid,
      ).toBe(expected);
    }
  });

  it.each([true, false])("retains siblings beside a boolean target %s", async (target) => {
    const doc = document(openapi, { $ref: ref("Bool"), maxLength: 3 }, { Bool: target });
    expect(await valid(doc, "abcd")).toBe(target && !modern);
    expect(await valid(doc, "ab")).toBe(target);
  });

  it("accounts for request and response pattern siblings throughout the chain", () => {
    const doc = document(
      openapi,
      { $ref: ref("Alias"), pattern: "^a", maxLength: 3 },
      {
        Alias: {
          $ref: ref("Text"),
          properties: { x: { type: "string", pattern: "x", maxLength: 5 } },
        },
        Text: { type: ["string", "object"] },
      },
    );
    const bodies = analyzeSpec(doc).operations[0]!.bodies;
    expect(bodies.map((b) => b.role)).toEqual(["request", "response"]);
    for (const body of bodies) {
      expect(body.error).toBeUndefined();
      expect(body.report!.peakBytes).toBe(modern ? 36 : 0);
      if (modern) expect(body.report!.positions.map((p) => p.path)).toEqual(["", "x"]);
    }
  });
});

it.each(["3.1", "3.0"] as const)(
  "uses the effective version override %s during extraction",
  async (openApiVersion) => {
    const doc = document(
      openApiVersion === "3.0" ? "3.1.0" : "3.0.3",
      { $ref: ref("Text"), pattern: "^a", maxLength: 3 },
      { Text: { type: "string" } },
    );
    expect(await valid(doc, "bbbb", { openApiVersion })).toBe(openApiVersion === "3.0");
    expect(analyzeSpec(doc, { openApiVersion }).operations[0]!.bodies[0]!.report!.peakBytes).toBe(
      openApiVersion === "3.0" ? 0 : 14,
    );
  },
);

it("retains a bound at a use site when the target buffers", () => {
  const doc = document(
    "3.1.0",
    { $ref: ref("Text"), maxLength: 3 },
    { Text: { type: "string", pattern: "^a" } },
  );
  expect(analyzeSpec(doc).operations[0]!.bodies[0]!.report!.peakBytes).toBe(14);
});

it("sizes a buffered sibling using the referenced type", () => {
  const doc = document(
    "3.1.0",
    { $ref: ref("Text"), format: "email", maxLength: 30 },
    { Text: { type: "string" } },
  );
  expect(analyzeSpec(doc).operations[0]!.bodies[0]!.report).toMatchObject({
    classification: "buffer",
    peakBytes: 122,
  });
});

it("counts concurrent ref and sibling composition obligations", async () => {
  const doc = document(
    "3.1.0",
    {
      $ref: ref("Text"),
      allOf: [{ type: "string", pattern: "a", maxLength: 3 }],
    },
    { Text: { type: "string", pattern: "b", maxLength: 5 } },
  );
  expect(await valid(doc, "ab")).toBe(true);
  expect(await valid(doc, "aa")).toBe(false);
  const report = analyzeSpec(doc, { maxBufferedBytes: 10 }).operations[0]!.bodies[0]!.report!;
  expect(report).toMatchObject({ classification: "buffer", peakBytes: 28, effectivePeakBytes: 20 });
});

it("keeps recursive ref analysis finite and records sibling member islands", async () => {
  const doc = document(
    "3.1.0",
    { $ref: ref("Node") },
    {
      Node: {
        $ref: ref("Alias"),
        properties: {
          value: { type: "string", pattern: "a", maxLength: 3 },
          child: { $ref: ref("Node") },
        },
      },
      Alias: { $ref: ref("Node"), type: "object" },
    },
  );
  expect(await valid(doc, { value: "a", child: { value: "a" } })).toBe(true);
  expect(await valid(doc, { child: { value: "b" } })).toBe(false);
  expect(analyzeSpec(doc).operations[0]!.bodies[0]!.report!.peakBytes).toBe(14);
});

it.each([true, false])("retains analyzer siblings of boolean target %s", (target) => {
  const doc = document(
    "3.1.0",
    { $ref: ref("Bool"), pattern: "a", maxLength: 3 },
    { Bool: target },
  );
  expect(analyzeSpec(doc).operations[0]!.bodies[0]!.report).toMatchObject({
    classification: "buffer",
    peakBytes: 14,
  });
});

it("records a target's whole-container buffering beside use-site constraints", async () => {
  const doc = document(
    "3.1.0",
    { $ref: ref("Array"), maxItems: 2 },
    {
      Array: { type: "array", uniqueItems: true, items: { type: "string", maxLength: 3 } },
    },
  );
  expect(await valid(doc, ["a", "b"])).toBe(true);
  expect(await valid(doc, ["a", "a"])).toBe(false);
  expect(await valid(doc, ["a", "b", "c"])).toBe(false);
  expect(analyzeSpec(doc).operations[0]!.bodies[0]!.report).toMatchObject({
    classification: "buffer",
    peakBytes: "unbounded",
  });
});

it("budgets overlapping member obligations that tee concurrently", async () => {
  const string = { type: "string", pattern: ".", maxLength: 3 } as const;
  const doc = document(
    "3.1.0",
    { $ref: ref("Object"), properties: { x: string } },
    {
      Object: { type: "object", properties: { x: { allOf: [string] } } },
    },
  );
  const stream = streamValidatorForOperation(doc, { method: "post", path: "/x" });
  await pipeline(
    Readable.from([JSON.stringify({ x: "😀😀😀" })]),
    stream,
    new Writable({
      write(_c, _e, cb) {
        cb();
      },
    }),
  );
  const result = await stream.result;
  expect(result.valid).toBe(true);
  const report = analyzeSpec(doc).operations[0]!.bodies[0]!.report!;
  expect(report.peakBytes).toBe(28);
  expect(report.peakBytes).toBeGreaterThanOrEqual(result.peakBufferedBytes);
});

it.each(["3.0.3", "3.1.0", "3.2.0"])(
  "preserves document-local pointer targets in %s",
  async (openapi) => {
    const doc = document(
      openapi,
      { $ref: ref("Alias"), maxLength: 3 },
      {
        Alias: {
          $ref: "#/paths/~1source/get/responses/200/content/application~1json/schema",
          minLength: 2,
        },
      },
    );
    doc.paths!["/source"] = {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": { schema: { type: "string", pattern: ".", maxLength: 10 } },
            },
          },
        },
      },
    };
    expect(await valid(doc, "ab")).toBe(true);
    expect(await valid(doc, "a")).toBe(openapi === "3.0.3");
    expect(await valid(doc, "abcd")).toBe(openapi === "3.0.3");
    const report = analyzeSpec(doc).operations[0]!.bodies[0]!.report!;
    expect(report.peakBytes).toBe(openapi === "3.0.3" ? 42 : 14);
  },
);

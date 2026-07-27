import { describe, expect, it } from "vitest";
import type { OpenAPIDocument, SchemaOrBoolean } from "@oaverify/internal-core";
import { emitSpec } from "../src/emit-spec.js";

/**
 * Regression guard for the schema dedup in `emitSpec`. The collector
 * keys emitted IIFEs by the source `SchemaOrBoolean` identity. When the
 * same schema object is referenced from multiple positions, it must be
 * compiled and emitted once, not once per reference.
 *
 * The bug it guards against: keying the dedup Map on the
 * `CompiledSchema` returned by `compileSchema` (a fresh object every
 * call) so the lookup never hit and each reference re-emitted the
 * schema.
 */
describe("emitSpec schema dedup", () => {
  it("emits one IIFE for a schema object shared across operations", () => {
    // Same object instance reused by reference in two response bodies.
    const shared: SchemaOrBoolean = {
      type: "object",
      properties: { id: { type: "string" } },
    };
    const document = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": {
          get: {
            responses: {
              "200": { description: "ok", content: { "application/json": { schema: shared } } },
            },
          },
        },
        "/b": {
          get: {
            responses: {
              "200": { description: "ok", content: { "application/json": { schema: shared } } },
            },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const source = emitSpec(document);
    const iifeCount = (source.match(/= \(function \(deps\) \{/g) ?? []).length;
    expect(iifeCount).toBe(1);
  });
});

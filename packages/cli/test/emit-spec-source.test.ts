import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { emitSpec } from "../src/emit-spec.js";

/**
 * `emitSpec` writes each compiled schema's generated source into the
 * module it emits, and `compileSchema` only returns that source when
 * asked (`retainSource`). Nothing else in the emitted module changes
 * when the ask goes missing: the IIFE wrappers, the router table and
 * the exports are all built here, so the module still parses and still
 * looks right while every validator inside it is empty.
 *
 * This pins the ask.
 */
describe("emitSpec generated source", () => {
  it("emits the compiled validator bodies, not just their wrappers", () => {
    const document = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/things": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { id: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenAPIDocument;

    const source = emitSpec(document);
    const iife = /= \(function \(deps\) \{\n([\s\S]*?)\n\}\)\(deps\);/.exec(source);
    expect(iife).not.toBeNull();
    expect(iife?.[1]?.trim().length ?? 0).toBeGreaterThan(0);
    expect(source).toContain("function validate_");
  });
});

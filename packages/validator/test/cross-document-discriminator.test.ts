import { resolveSpec, createMemoryReader } from "@oaverify/internal-spec";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator, leafCodes } from "./fixtures.js";

/**
 * A discriminated union declared in the entry document and reached from
 * a path item in another file.
 *
 * Whatever the resolver does with the branch schemas, the discriminator
 * must keep routing a body to its own branch and reporting that
 * branch's error rather than every branch's. These assertions name
 * codes and messages only, never a `components.schemas` key, so they
 * hold across a change to how the target is addressed. That is the
 * point: this file is the baseline that a hoisting change must not
 * move (#612).
 */
function specFiles(): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      "openapi.yaml",
      {
        openapi: "3.1.0",
        info: { title: "Disc", version: "1" },
        paths: { "/pets": { $ref: "./paths/pets.yaml" } },
        components: {
          schemas: {
            Pet: {
              oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
              discriminator: {
                propertyName: "kind",
                mapping: {
                  cat: "#/components/schemas/Cat",
                  dog: "#/components/schemas/Dog",
                },
              },
            },
            Cat: {
              type: "object",
              required: ["kind", "meow"],
              properties: { kind: { type: "string" }, meow: { type: "boolean" } },
            },
            Dog: {
              type: "object",
              required: ["kind", "bark"],
              properties: { kind: { type: "string" }, bark: { type: "boolean" } },
            },
          },
        },
      },
    ],
    [
      "paths/pets.yaml",
      {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "../openapi.yaml#/components/schemas/Pet" },
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    ],
  ]);
}

async function resolved(): Promise<OpenAPIDocument> {
  const reader = createMemoryReader(specFiles());
  const { document } = await resolveSpec({ reader, entry: "openapi.yaml" });
  return document;
}

describe("discriminator across documents", () => {
  it("accepts a body matching the branch its discriminator names", async () => {
    const v = createValidator(await resolved());
    expect(
      v.validateRequest({
        method: "POST",
        path: "/pets",
        contentType: "application/json",
        body: { kind: "cat", meow: true },
      }),
    ).toBeNull();
  });

  it("reports the named branch's error, not every branch's", async () => {
    const v = createValidator(await resolved());
    const err = v.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      body: { kind: "cat" },
    });
    expect(leafCodes(err)).toEqual(["required"]);
    expect(JSON.stringify(err)).toContain("meow");
    expect(JSON.stringify(err)).not.toContain("bark");
  });

  it("routes to the other branch by the same mapping", async () => {
    const v = createValidator(await resolved());
    expect(
      v.validateRequest({
        method: "POST",
        path: "/pets",
        contentType: "application/json",
        body: { kind: "dog", bark: false },
      }),
    ).toBeNull();
    const err = v.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      body: { kind: "dog" },
    });
    expect(leafCodes(err)).toEqual(["required"]);
    expect(JSON.stringify(err)).toContain("bark");
  });
});

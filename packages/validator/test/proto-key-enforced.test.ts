import type { OpenAPIDocument } from "@oaverify/internal-core";
import { resolveSpec } from "@oaverify/internal-spec";
import { describe, expect, it } from "vitest";
import { createValidator } from "./fixtures.js";

/**
 * End-to-end companion to `packages/spec/test/proto-key.test.ts`. That
 * suite asserts a `__proto__` subschema survives resolution as an own
 * property; this one asserts the surviving subschema is then compiled
 * and enforced, so the two halves cannot drift apart.
 *
 * Both the spec and the payload are raw JSON strings: a JS object
 * literal `{ __proto__: ... }` sets the prototype instead of creating
 * the key, and the test would pass without exercising anything.
 */

const SPEC = `{
  "openapi": "3.1.0",
  "info": { "title": "t", "version": "1" },
  "paths": {
    "/p": {
      "post": {
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": { "__proto__": { "type": "string" } }
              }
            }
          }
        },
        "responses": { "200": { "description": "ok" } }
      }
    }
  }
}`;

describe("a resolved __proto__ subschema is enforced", () => {
  it("rejects a wrongly-typed __proto__ property and accepts a valid one", async () => {
    const source = JSON.parse(SPEC) as unknown;
    const resolved = await resolveSpec({
      entry: "main.json",
      reader: {
        canRead: (uri) => uri === "main.json",
        read: () => Promise.resolve(JSON.parse(SPEC) as unknown),
      },
    });
    expect(resolved.document).toEqual(source);

    const v = createValidator(resolved.document as OpenAPIDocument);

    const bad = v.validateRequest({
      method: "POST",
      path: "/p",
      contentType: "application/json",
      headers: {},
      body: JSON.parse(`{"__proto__": 42}`) as unknown,
    });
    expect(bad).not.toBeNull();
    expect(JSON.stringify(bad)).toContain("__proto__");

    const good = v.validateRequest({
      method: "POST",
      path: "/p",
      contentType: "application/json",
      headers: {},
      body: JSON.parse(`{"__proto__": "s"}`) as unknown,
    });
    expect(good).toBeNull();
  });
});

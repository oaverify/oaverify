import { collectLeaves, type OpenAPIDocument, type ValidationError } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import type { CustomKeywordValidator } from "../src/index.js";
import { createValidator } from "./fixtures.js";

describe("custom keywords via createValidator", () => {
  function sku(): OpenAPIDocument {
    return {
      openapi: "3.1.0",
      info: { title: "sku", version: "1" },
      paths: {
        "/items": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["sku"],
                    properties: {
                      sku: { type: "string", skuPrefix: "OAV-" } as Record<string, unknown>,
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
  }

  const skuPrefix: CustomKeywordValidator = (data, schemaValue) => {
    if (typeof data !== "string") return true;
    const prefix = schemaValue as string;
    if (data.startsWith(prefix)) return true;
    return { message: `must start with ${prefix}`, params: { prefix } };
  };

  it("applies the custom keyword to request bodies", () => {
    const v = createValidator(sku(), { keywords: { skuPrefix } });
    expect(
      v.validateRequest({
        method: "POST",
        path: "/items",
        contentType: "application/json",
        body: { sku: "OAV-42" },
      }),
    ).toBeNull();
    const err = v.validateRequest({
      method: "POST",
      path: "/items",
      contentType: "application/json",
      body: { sku: "nope" },
    });
    expect(err).not.toBeNull();
    const leaf = collectLeaves(err as ValidationError).find((l) => l.code === "skuPrefix");
    expect(leaf).toBeDefined();
    expect(leaf?.message).toBe("must start with OAV-");
    expect(leaf?.params).toEqual({ prefix: "OAV-" });
    expect(leaf?.path).toEqual(["body", "sku"]);
  });
});

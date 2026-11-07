import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { emitSpec } from "../src/emit-spec.js";

const ok = { "200": { description: "ok" } };

function doc(paths: Record<string, unknown>): OpenAPIDocument {
  return { openapi: "3.1.0", info: { title: "t", version: "1" }, paths } as OpenAPIDocument;
}

describe("emitSpec does not emit an x- key under paths (#1342)", () => {
  it("leaves the key out of the operations table and the router table", () => {
    const source = emitSpec(
      doc({
        "/real": { get: { responses: ok } },
        "x-vendor": { get: { responses: ok } },
      }),
    );
    expect(source).toContain('"/real::GET"');
    expect(source).not.toContain("x-vendor");
  });

  it("does not stop on a reference that does not resolve under the key", () => {
    const document = doc({
      "/real": { get: { responses: ok } },
      "x-broken": { $ref: "#/nope" },
    });
    expect(emitSpec(document)).toContain('"/real::GET"');
  });

  it("still refuses an unknown format written under the key", () => {
    // A served operation can reference a schema kept under an extension
    // key, so the format guard covers the key's content as before.
    const mystery = { type: "string", format: "x-mystery" };
    const unreferenced = doc({
      "/real": { get: { responses: ok } },
      "x-vendor": {
        get: { parameters: [{ name: "q", in: "query", schema: mystery }], responses: ok },
      },
    });
    const referenced = doc({
      "/real": {
        get: {
          parameters: [
            {
              name: "q",
              in: "query",
              schema: { $ref: "#/paths/x-vendor/get/parameters/0/schema" },
            },
          ],
          responses: ok,
        },
      },
      "x-vendor": {
        get: { parameters: [{ name: "q", in: "query", schema: mystery }], responses: ok },
      },
    });
    for (const document of [unreferenced, referenced]) {
      expect(() => emitSpec(document)).toThrow(/x-mystery/);
      const unknown: string[][] = [];
      const source = emitSpec(document, {
        unknownFormats: "ignore",
        onUnknownFormats: (names) => unknown.push([...names]),
      });
      expect(unknown).toEqual([["x-mystery"]]);
      expect(source).not.toContain("x-vendor::GET");
    }
  });
});

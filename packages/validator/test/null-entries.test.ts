import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "../src/validator.js";

/**
 * A Request Body, Media Type or Header Object entry with nothing under it.
 *
 * In YAML, `application/json:` or `X-Rate:` with no body parses to
 * `null`. The operation cache read `.schema` off it, so the first
 * request to that operation threw `TypeError: Cannot read properties of
 * null (reading 'schema')`; a null `requestBody` threw on `.required`. A null Parameter or Response was already
 * skipped; these entries now follow the same rule, and the conformance
 * pass locates the defect.
 *
 * A null media type still counts as declared, the way `{}` does: the
 * key names the media type, and only its schema is missing.
 */

const doc = (operation: Record<string, unknown>): OpenAPIDocument =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: { "/t": { post: operation } },
  }) as unknown as OpenAPIDocument;

const ok = { "200": { description: "ok" } };

describe("a null media type or header entry", () => {
  it("does not throw on a request body media type", () => {
    const v = createValidator(
      doc({ requestBody: { content: { "application/json": null } }, responses: ok }),
    );
    const result = v.validateRequest({
      method: "POST",
      path: "/t",
      contentType: "application/json",
      body: { a: 1 },
    });
    expect(result.valid).toBe(true);
  });

  it("does not throw on a null request body", () => {
    const v = createValidator(doc({ requestBody: null, responses: ok }));
    expect(v.validateRequest({ method: "POST", path: "/t" }).valid).toBe(true);
  });

  it("still counts a null request media type as declared", () => {
    const v = createValidator(
      doc({ requestBody: { content: { "application/json": null } }, responses: ok }),
    );
    const result = v.validateRequest({
      method: "POST",
      path: "/t",
      contentType: "text/plain",
      body: "x",
    });
    expect(result.valid).toBe(false);
  });

  it("does not throw on a parameter content media type", () => {
    const v = createValidator(
      doc({
        parameters: [{ name: "q", in: "query", content: { "application/json": null } }],
        responses: ok,
      }),
    );
    expect(v.validateRequest({ method: "POST", path: "/t", query: { q: "1" } }).valid).toBe(true);
  });

  it("does not throw on a response media type", () => {
    const v = createValidator(
      doc({
        responses: { "200": { description: "ok", content: { "application/json": null } } },
      }),
    );
    expect(v.validateRequest({ method: "POST", path: "/t" }).valid).toBe(true);
    const result = v.validateResponse(
      { method: "POST", path: "/t" },
      { status: 200, contentType: "application/json", body: { a: 1 } },
    );
    expect(result.valid).toBe(true);
  });

  it("does not throw on a response header", () => {
    const v = createValidator(
      doc({ responses: { "200": { description: "ok", headers: { "X-Rate": null } } } }),
    );
    expect(v.validateRequest({ method: "POST", path: "/t" }).valid).toBe(true);
    const result = v.validateResponse(
      { method: "POST", path: "/t" },
      { status: 200, headers: { "x-rate": "1" } },
    );
    expect(result.valid).toBe(true);
  });
});

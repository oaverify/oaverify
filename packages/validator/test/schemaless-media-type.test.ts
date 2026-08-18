import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { createValidator } from "../src/validator.js";

/**
 * Content negotiation asks what the document *declares*; validation asks
 * what compiled. Those are different sets, and reading the second for
 * the first answered 415 for a legal request (#849).
 *
 * A Media Type Object with no `schema` is legal and means "anything
 * goes", so it belongs in the accepted set.
 *
 * #849 also describes a second way to fall out of negotiation, a schema
 * that failed to compile under `precompile({ onMalformed: "collect" })`.
 * That one is not reachable: the collector is installed for the
 * precompile pass only, so a request served afterwards rebuilds the
 * cache without it and the malformed schema throws out of
 * `createValidator` rather than yielding a wrong 415. Negotiating on
 * declared media types would cover it if it ever became reachable;
 * there is no test here because there is no way to provoke it.
 */
const doc = (content: Record<string, unknown>): OpenAPIDocument =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/things": {
        post: {
          requestBody: { content },
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { type: "object" } },
                "text/plain": {},
              },
            },
          },
        },
      },
    },
  }) as unknown as OpenAPIDocument;

const mixed = () =>
  doc({
    "application/json": { schema: { type: "object", required: ["id"] } },
    "text/plain": {},
  });

describe("a declared media type carrying no schema (#849)", () => {
  it("is accepted, and its body is passed through unvalidated", () => {
    const result = createValidator(mixed()).validateRequest({
      method: "POST",
      path: "/things",
      contentType: "text/plain",
      body: "anything goes",
    });

    expect(result?.valid).toBe(true);
  });

  it("does not weaken the sibling media type that does carry a schema", () => {
    const result = createValidator(mixed()).validateRequest({
      method: "POST",
      path: "/things",
      contentType: "application/json",
      body: {},
    });

    expect(result?.valid).toBe(false);
    expect(result?.valid === false ? result.errors[0]?.code : undefined).toBe("required");
  });

  it("still refuses a media type the document does not declare", () => {
    const result = createValidator(mixed()).validateRequest({
      method: "POST",
      path: "/things",
      contentType: "application/xml",
      body: "<x/>",
    });

    expect(result?.valid).toBe(false);
    expect(result?.valid === false ? result.errors[0]?.code : undefined).toBe("content-type");
  });

  it("lists every declared media type as accepted, not only the compiled ones", () => {
    const result = createValidator(mixed()).validateRequest({
      method: "POST",
      path: "/things",
      contentType: "application/xml",
      body: "<x/>",
    });

    // The list is what a client is told to send instead, so omitting a
    // media type the server does accept sends them somewhere wrong.
    expect(result?.valid === false ? result.errors[0]?.params?.accepted : undefined).toEqual([
      "application/json",
      "text/plain",
    ]);
  });

  it("names every declared media type on the response leg too", () => {
    const result = createValidator(mixed()).validateResponse(
      { method: "POST", path: "/things" },
      { status: 200, contentType: "application/xml", body: "<x/>" },
    );

    expect(result?.valid === false ? result.errors[0]?.params?.declared : undefined).toEqual([
      "application/json",
      "text/plain",
    ]);
  });

  it("lets a schema-less exact key take precedence over a wildcard that has one", () => {
    // Negotiation is most-specific-wins, so declaring an exact type
    // with no schema deliberately opts that type out of the wildcard's
    // validation. Worth pinning because it reads like a loosening: on
    // the old behaviour the exact key was invisible and the wildcard
    // validated the body.
    const validator = createValidator(
      doc({
        "application/json": {},
        "application/*": { schema: { type: "object", required: ["id"] } },
      }),
    );

    expect(
      validator.validateRequest({
        method: "POST",
        path: "/things",
        contentType: "application/json",
        body: {},
      })?.valid,
    ).toBe(true);

    // The wildcard still validates everything it is the best match for.
    expect(
      validator.validateRequest({
        method: "POST",
        path: "/things",
        contentType: "application/other",
        body: {},
      })?.valid,
    ).toBe(false);
  });

  it("is accepted on the response leg too", () => {
    const result = createValidator(mixed()).validateResponse(
      { method: "POST", path: "/things" },
      { status: 200, contentType: "text/plain", body: "anything goes" },
    );

    expect(result?.valid).toBe(true);
  });

  describe("when no declared media type carries a schema (#870)", () => {
    // The gate used to key on compiled schemas, so an operation like
    // this negotiated nothing at all and accepted any Content-Type. It
    // is the ordinary binary-upload declaration, not an edge case.
    const upload = () => doc({ "application/octet-stream": {} });

    it("still accepts the declared type", () => {
      const result = createValidator(upload()).validateRequest({
        method: "POST",
        path: "/things",
        contentType: "application/octet-stream",
        body: "bytes",
      });

      expect(result?.valid).toBe(true);
    });

    it("now refuses an undeclared type", () => {
      const result = createValidator(upload()).validateRequest({
        method: "POST",
        path: "/things",
        contentType: "application/json",
        body: { a: 1 },
      });

      expect(result?.valid).toBe(false);
      expect(result?.valid === false ? result.errors[0]?.code : undefined).toBe("content-type");
    });

    it("still says nothing about an operation declaring no request body", () => {
      const noBody = {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/things": { post: { responses: { "204": { description: "ok" } } } },
        },
      } as unknown as OpenAPIDocument;

      const result = createValidator(noBody).validateRequest({
        method: "POST",
        path: "/things",
        contentType: "application/json",
        body: { a: 1 },
      });

      expect(result?.valid).toBe(true);
    });

    it("refuses a body sent with no Content-Type at all", () => {
      // Same rule a schema-carrying operation already applied: a body
      // arrived, and nothing says which of the declared types it is.
      const result = createValidator(upload()).validateRequest({
        method: "POST",
        path: "/things",
        body: "bytes",
      });

      expect(result?.valid).toBe(false);
    });

    it("says nothing when neither a body nor a Content-Type was sent", () => {
      const result = createValidator(upload()).validateRequest({
        method: "POST",
        path: "/things",
      });

      expect(result?.valid).toBe(true);
    });

    it("reports an absent response body under requireResponseBody", () => {
      // The absent-body check read the same compiled-schema count, so a
      // response declaring only schema-less content never triggered the
      // message that names exactly that condition.
      const responseOnly = {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/things": {
            get: {
              responses: {
                // Both declared, so the 204 probe below tests the
                // bodyless-status exclusion rather than an undeclared
                // status.
                "200": { description: "ok", content: { "text/plain": {} } },
                "204": { description: "no content", content: { "text/plain": {} } },
              },
            },
          },
        },
      } as unknown as OpenAPIDocument;

      const validator = createValidator(responseOnly, { requireResponseBody: true });
      const where = { method: "GET" as const, path: "/things" };

      const missing = validator.validateResponse(where, { status: 200 });
      expect(missing?.valid).toBe(false);
      expect(missing?.valid === false ? missing.errors[0]?.message : "").toContain(
        "declares content but no body was sent",
      );

      // The exclusions still hold: a bodyless status says nothing.
      expect(validator.validateResponse(where, { status: 204 })?.valid).toBe(true);
      expect(
        validator.validateResponse({ method: "HEAD", path: "/things" }, { status: 200 })?.valid,
      ).toBe(true);
    });

    it("refuses an undeclared response type, and accepts the declared one", () => {
      // `doc()` always declares `application/json` on the response, so
      // the response leg needs its own document to have a response
      // whose media types all lack a schema.
      const responseOnly = {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/things": {
            post: {
              responses: {
                "200": { description: "ok", content: { "text/plain": {} } },
              },
            },
          },
        },
      } as unknown as OpenAPIDocument;

      const validator = createValidator(responseOnly);
      const where = { method: "POST" as const, path: "/things" };

      expect(
        validator.validateResponse(where, {
          status: 200,
          contentType: "text/plain",
          body: "ok",
        })?.valid,
      ).toBe(true);

      expect(
        validator.validateResponse(where, {
          status: 200,
          contentType: "application/json",
          body: { a: 1 },
        })?.valid,
      ).toBe(false);
    });
  });
});

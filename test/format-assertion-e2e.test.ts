/**
 * The string-format fixes, exercised through `createValidator` on a real
 * OpenAPI 3.1 document rather than by calling the predicates directly.
 *
 * The unit tests in `packages/formats/test` cover the grammars. This
 * covers the thing that made the bugs matter: under the OpenAPI dialects
 * `format` is an assertion, so a wrong validator refuses or admits live
 * request traffic. #668 was reported this way, and a fix that held only
 * in isolation would not have answered it.
 */

import { describe, expect, it } from "vitest";
import { createValidator } from "@oaverify/internal-validator";

const spec = {
  openapi: "3.1.0",
  info: { title: "format assertion", version: "1" },
  paths: {
    "/t": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: { type: "string", format: "email" },
                  site: { type: "string", format: "uri" },
                  span: { type: "string", format: "duration" },
                  re: { type: "string", format: "regex" },
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

/** Written as a code point so the source stays ASCII. */
const BACKSLASH = String.fromCharCode(92);

const validator = createValidator(spec as never);

function accepts(body: Record<string, unknown>): boolean {
  return validator.validateRequest({
    method: "POST",
    path: "/t",
    contentType: "application/json",
    body,
  } as never).valid;
}

describe("format assertion through createValidator", () => {
  it("accepts valid traffic that was refused before (#668)", () => {
    for (const body of [
      { email: '"joe bloggs"@example.com' },
      { email: '"joe..bloggs"@example.com' },
      { email: '"joe@bloggs"@example.com' },
      { email: "joe.bloggs@[127.0.0.1]" },
      { email: "joe.bloggs@[IPv6:::1]" },
      { site: "http://087.10.0.1/" },
      { site: "http://999.999.999.999/" },
    ]) {
      expect(accepts(body), JSON.stringify(body)).toBe(true);
    }
  });

  it("refuses invalid traffic that was accepted before (#670)", () => {
    for (const body of [
      { site: "https://example.org/a<>.txt" },
      { site: `https://example.org/a${BACKSLASH}.txt` },
      { site: "http://example.com/%" },
      { site: "http://example.com/%6G" },
      { span: "P1Y2D" },
      { span: "PT1H2S" },
      { span: "PT0.5S" },
      { span: "P1Y2W" },
      { re: `${BACKSLASH}a` },
    ]) {
      expect(accepts(body), JSON.stringify(body)).toBe(false);
    }
  });

  it("still accepts the ordinary shapes", () => {
    for (const body of [
      { email: "joe@example.com" },
      { site: "https://example.com/a?b=1#c" },
      { span: "P1Y2M3DT4H5M6S" },
      { re: "^a+$" },
    ]) {
      expect(accepts(body), JSON.stringify(body)).toBe(true);
    }
  });

  it("reports the failure as a format error on the offending field", () => {
    const result = validator.validateRequest({
      method: "POST",
      path: "/t",
      contentType: "application/json",
      body: { span: "PT0.5S" },
    } as never);
    // `ValidationResult` is a discriminated union; narrow before
    // reaching for `errors`.
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.code).toBe("format");
    expect(result.errors[0]?.path).toEqual(["body", "span"]);
  });
});

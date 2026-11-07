/**
 * `then` or `else` with no `if` is never compiled and declares no name for the
 * instance, so the required lint on the live node beside it reports whatever
 * the branch holds: a pointer into the body schema's own members (which each
 * operation's resolver refuses, compiling the body alone), a dangling pointer,
 * or the required name declared inline. Validation is unaffected.
 */
import { describe, expect, it } from "vitest";
import { compileSchema, openapi31Dialect } from "@oaverify/internal-schema";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { createValidator } from "../src/index.js";

const REQUIRED = "silent-rewrite/required-not-in-properties";

// JSON so the dead branch is a plain key: the repo lints object literals that
// spell `then`.
const schemaWith = (branch: string, body: string) =>
  JSON.parse(`{
    "type": "object",
    "properties": { "a": { "type": "string" } },
    "required": ["aa"],
    "${branch}": ${body}
  }`) as Record<string, unknown>;

const BODIES = [
  `{ "$ref": "#/properties/a" }`,
  `{ "$ref": "#/$defs/none" }`,
  `{ "properties": { "aa": {} } }`,
];

describe.each(["then", "else"].flatMap((branch) => BODIES.map((body) => [branch, body] as const)))(
  "a dead %s %s beside a required list",
  (branch, body) => {
    const schema = schemaWith(branch, body);
    const validator = createValidator(
      {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/a": {
            post: {
              requestBody: { content: { "application/json": { schema } } },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      } as unknown as OpenAPIDocument,
      { schemaLint: "strict" },
    );

    const post = (body: unknown) =>
      validator.validateRequest({
        method: "POST",
        path: "/a",
        headers: { "content-type": "application/json" },
        body,
        contentType: "application/json",
      } as never);

    it("reports through the HTTP validator", () => {
      validator.precompile();
      const codes = validator.stats.schemaLintIssues.map((i) => i.code);
      expect(codes).toContain(REQUIRED);
    });

    it("reports through a standalone compile", () => {
      const codes = compileSchema(schema as never, {
        dialect: openapi31Dialect,
        schemaLint: "strict",
      }).stats.schemaLintIssues.map((i) => i.code);
      expect(codes).toContain(REQUIRED);
    });

    it("does not change what the body accepts", () => {
      expect(post({ aa: 1 }).valid).toBe(true);
      expect(post({ a: 1 }).valid).toBe(false);
      expect(post({}).valid).toBe(false);
    });
  },
);

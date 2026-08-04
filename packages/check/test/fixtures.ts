/**
 * The documents both sides of the package seam grade: `check.test.ts`
 * through `checkSpec`, and `packages/cli/test/check-golden.test.ts`
 * through the CLI. One module rather than two copies, so "the same
 * input on both sides" is structural instead of a comment that an edit
 * to either copy would silently falsify.
 */

/**
 * One document reaching five of the six classes, split across two files
 * so `target.source` is exercised rather than assumed. The entry is
 * `entry.json`.
 *
 * `malformed` is deliberately absent: it forces exit 4, which would mask
 * the CLI suite's `--fail-on` rows. It gets its own fixture.
 */
export function kitchenSink(): Array<[string, unknown]> {
  return [
    [
      "entry.json",
      {
        openapi: "3.1.0",
        info: { title: "Kitchen Sink", version: "1.0.0" },
        paths: {
          // hygiene: `{petId}` is templated and never declared.
          "/pets/{petId}": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": { schema: { $ref: "./shared.json#/Pet" } },
                  },
                },
              },
            },
          },
          // conformance: `description` is required to be a string, and
          // this is legal JSON, so only the meta-schema catches it.
          "/status": { get: { responses: { "202": { description: null } } } },
          "/search": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    // examples: "EFT" is not in the enum.
                    schema: { type: "string", enum: ["ACH", "CHECK"] },
                    example: "EFT",
                  },
                },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
        components: {
          schemas: {
            // hygiene: nothing references this.
            Orphan: { type: "object" },
          },
        },
      },
    ],
    [
      "shared.json",
      {
        Pet: {
          type: "object",
          properties: {
            // redos: nested quantifier.
            slug: { type: "string", pattern: "^(a+)+$" },
            // schema: a format oaverify does not validate.
            ref: { type: "string", format: "not-a-real-format" },
            // schema: unsatisfiable, and a silent rewrite.
            code: { type: "string", pattern: "^[0-9]{5}$", maxLength: 2 },
          },
          // schema: `required` names a property that is not declared.
          required: ["slug", "absent"],
        },
      },
    ],
  ];
}

/**
 * A schema that will not compile, for the fatal-finding path (exit 4 in
 * the CLI). The entry is `spec.json`.
 */
export function malformedSpec(): Array<[string, unknown]> {
  return [
    [
      "spec.json",
      {
        openapi: "3.1.0",
        info: { title: "Malformed", version: "1.0.0" },
        paths: {
          "/t": {
            post: {
              requestBody: {
                content: { "application/json": { schema: { type: "object", required: 7 } } },
              },
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
    ],
  ];
}

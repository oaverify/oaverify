import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import {
  streamValidatorForOperation,
  ValidationFailedError,
  type StreamVerdict,
} from "../src/index.js";

const enc = new TextEncoder();

function petstore(openapi = "3.1.0"): OpenAPIDocument {
  return {
    openapi,
    info: { title: "petstore", version: "1.0.0" },
    paths: {
      "/pets": {
        post: {
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
        },
      },
    },
    components: {
      schemas: {
        Pet: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" }, tag: { type: "string" } },
        },
      },
    },
  } as OpenAPIDocument;
}

/** Validate a value through the built validator; return the verdict. */
async function run(
  validator: ReturnType<typeof streamValidatorForOperation>,
  value: unknown,
): Promise<StreamVerdict> {
  validator.on("error", () => {});
  try {
    await pipeline(
      Readable.from(Buffer.from(enc.encode(JSON.stringify(value)))),
      validator,
      new Writable({ write: (_c, _e, cb) => cb() }),
    );
  } catch (err) {
    if (!(err instanceof ValidationFailedError)) throw err;
  }
  return validator.result;
}

describe("streamValidatorForOperation", () => {
  it("carries components so an internal $ref body schema resolves", async () => {
    const ok = await run(
      streamValidatorForOperation(petstore(), { method: "post", path: "/pets" }),
      {
        name: "Fido",
        tag: "dog",
      },
    );
    expect(ok.valid).toBe(true);

    const bad = await run(
      streamValidatorForOperation(petstore(), { method: "post", path: "/pets" }),
      { tag: "dog" },
    );
    expect(bad.valid).toBe(false);
    expect(bad.violations[0]!.code).toBe("required");
  });

  it("resolves a bare top-level $ref body on a 3.0 doc (components survive normalization)", async () => {
    // Regression: a 3.0 bare-$ref body becomes `{ $ref, components }`, and
    // 3.0 $ref-sibling suppression then drops `components`, leaving the
    // internal $ref unresolvable. Dereferencing the top-level $ref before
    // attaching `components` keeps a non-$ref root the container sits beside.
    const ok = await run(
      streamValidatorForOperation(petstore("3.0.3"), { method: "post", path: "/pets" }),
      { name: "Fido", tag: "dog" },
    );
    expect(ok.valid).toBe(true);

    const bad = await run(
      streamValidatorForOperation(petstore("3.0.3"), { method: "post", path: "/pets" }),
      { tag: "dog" },
    );
    expect(bad.valid).toBe(false);
    expect(bad.violations[0]!.code).toBe("required");
  });

  it("normalizes a 3.0 component reached by an internal $ref (nullable / exclusive*)", async () => {
    // A nested $ref into components must hit the 3.0-normalized target, not
    // the raw 3.0 shape: `nullable` folds to a null union, boolean
    // `exclusiveMinimum` folds to the numeric form.
    const doc = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      n: { $ref: "#/components/schemas/Nullable" },
                      m: { $ref: "#/components/schemas/Excl" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Nullable: { type: "integer", nullable: true },
          Excl: { type: "integer", minimum: 5, exclusiveMinimum: true },
        },
      },
    } as unknown as OpenAPIDocument;

    const ok = await run(streamValidatorForOperation(doc, { method: "post", path: "/x" }), {
      n: null,
      m: 6,
    });
    expect(ok.valid).toBe(true);

    const bad = await run(streamValidatorForOperation(doc, { method: "post", path: "/x" }), {
      n: 1,
      m: 5, // excluded by exclusiveMinimum: 5
    });
    expect(bad.valid).toBe(false);
  });

  it("is case-insensitive on the method", () => {
    expect(() =>
      streamValidatorForOperation(petstore(), { method: "POST", path: "/pets" }),
    ).not.toThrow();
  });

  it("forwards options (maxErrors) to the validator", async () => {
    const v = streamValidatorForOperation(
      petstore(),
      { method: "post", path: "/pets" },
      { maxErrors: Number.POSITIVE_INFINITY, policy: "detach" },
    );
    const verdict = await run(v, { name: 42 });
    expect(verdict.valid).toBe(false);
  });

  it("reads the version off doc.openapi (3.0 normalizes nullable)", async () => {
    // A 3.0 doc with `nullable: true`: only the 3.0 normalization path
    // accepts an explicit null. Detecting the version off the doc proves
    // the right path ran.
    const doc = {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "string", nullable: true },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenAPIDocument;
    const verdict = await run(
      streamValidatorForOperation(doc, { method: "post", path: "/x" }),
      null,
    );
    expect(verdict.valid).toBe(true);
  });

  it("throws a clear error for a missing path / method / body / media type", () => {
    expect(() =>
      streamValidatorForOperation(petstore(), { method: "post", path: "/nope" }),
    ).toThrow(/no path "\/nope"/);
    expect(() => streamValidatorForOperation(petstore(), { method: "get", path: "/pets" })).toThrow(
      /no GET .* operation/,
    );
    expect(() =>
      streamValidatorForOperation(petstore(), {
        method: "post",
        path: "/pets",
        mediaType: "application/xml",
      }),
    ).toThrow(/no "application\/xml" content/);
    expect(() =>
      streamValidatorForOperation(petstore(), { method: "fetch", path: "/pets" }),
    ).toThrow(/unknown HTTP method/);
  });

  it("resolves a local requestBody $ref (#/components/requestBodies/...)", async () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/pets": { post: { requestBody: { $ref: "#/components/requestBodies/PetBody" } } } },
      components: {
        requestBodies: {
          PetBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
        },
        schemas: {
          Pet: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        },
      },
    } as unknown as OpenAPIDocument;
    const ok = await run(streamValidatorForOperation(doc, { method: "post", path: "/pets" }), {
      name: "Fido",
    });
    expect(ok.valid).toBe(true);
    const bad = await run(streamValidatorForOperation(doc, { method: "post", path: "/pets" }), {});
    expect(bad.valid).toBe(false);
  });

  it("throws on an unresolvable requestBody $ref", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/pets": { post: { requestBody: { $ref: "#/components/requestBodies/Missing" } } } },
    } as unknown as OpenAPIDocument;
    expect(() => streamValidatorForOperation(doc, { method: "post", path: "/pets" })).toThrow(
      /does not resolve/,
    );
  });

  it("throws on an external requestBody $ref that survived resolution", () => {
    const doc = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/pets": { post: { requestBody: { $ref: "common.yaml#/PetBody" } } } },
    } as unknown as OpenAPIDocument;
    expect(() => streamValidatorForOperation(doc, { method: "post", path: "/pets" })).toThrow(
      /external requestBody ref/,
    );
  });
});

import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { analyzeSpec } from "../src/index.js";

function doc(partial: Record<string, unknown>): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    ...partial,
  } as OpenAPIDocument;
}

describe("analyzeSpec", () => {
  it("analyzes request and response bodies, in document order", () => {
    const budget = analyzeSpec(
      doc({
        paths: {
          "/pets": {
            post: {
              requestBody: {
                content: { "application/json": { schema: { type: "object" } } },
              },
              responses: {
                "200": { content: { "application/json": { schema: { type: "array" } } } },
                default: { content: { "application/json": { schema: { type: "string" } } } },
              },
            },
          },
        },
      }),
    );
    expect(budget.operations).toHaveLength(1);
    const op = budget.operations[0]!;
    expect(op.method).toBe("POST");
    expect(op.path).toBe("/pets");
    expect(op.bodies.map((b) => [b.role, b.status])).toEqual([
      ["request", undefined],
      ["response", "200"],
      ["response", "default"],
    ]);
    expect(op.bodies.every((b) => b.report?.classification === "streamable")).toBe(true);
  });

  it("omits operations with no body schema", () => {
    const budget = analyzeSpec(
      doc({ paths: { "/ping": { get: { responses: { "204": { description: "no content" } } } } } }),
    );
    expect(budget.operations).toEqual([]);
  });

  it("carries components so an internal $ref body resolves and surfaces unbounded positions", () => {
    const budget = analyzeSpec(
      doc({
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
              additionalProperties: false,
              properties: { name: { type: "string", pattern: "^.+$" } },
            },
          },
        },
      }),
    );
    const report = budget.operations[0]!.bodies[0]!.report!;
    expect(report.classification).toBe("buffer");
    expect(report.positions).toContainEqual(
      expect.objectContaining({ path: "name", keyword: "pattern", maxBytes: "unbounded" }),
    );
  });

  it("follows a local response $ref", () => {
    const budget = analyzeSpec(
      doc({
        paths: {
          "/pets": {
            get: { responses: { "200": { $ref: "#/components/responses/Pets" } } },
          },
        },
        components: {
          responses: {
            Pets: { content: { "application/json": { schema: { type: "array" } } } },
          },
        },
      }),
    );
    expect(budget.operations[0]!.bodies[0]).toMatchObject({ role: "response", status: "200" });
    expect(budget.operations[0]!.bodies[0]!.report?.classification).toBe("streamable");
  });

  it("uses core JSON Pointer rules for local response refs", () => {
    const budget = analyzeSpec(
      doc({
        paths: {
          "/pets": {
            get: { responses: { "200": { $ref: "#/components/responses/Foo%2FBar" } } },
          },
        },
        components: {
          responses: {
            Foo: {
              Bar: {
                content: {
                  "application/json": {
                    schema: { type: "string", pattern: "^pet-" },
                  },
                },
              },
            },
            "Foo/Bar": {
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      }),
    );

    expect(budget.operations[0]!.bodies[0]!.report?.classification).toBe("buffer");
    expect(budget.operations[0]!.bodies[0]!.report?.positions).toContainEqual(
      expect.objectContaining({ keyword: "pattern", path: "" }),
    );
  });

  it("captures a classification failure per body instead of throwing", () => {
    const budget = analyzeSpec(
      doc({
        paths: {
          "/x": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: { type: "object", unevaluatedProperties: false },
                  },
                },
              },
              responses: {
                "200": { content: { "application/json": { schema: { type: "string" } } } },
              },
            },
          },
        },
      }),
    );
    const bodies = budget.operations[0]!.bodies;
    expect(bodies[0]!.error).toMatch(/unevaluatedProperties/);
    expect(bodies[0]!.report).toBeUndefined();
    // The bad request body does not stop the response from being analyzed.
    expect(bodies[1]!.report?.classification).toBe("streamable");
  });

  it("reads the OpenAPI version off doc.openapi (3.0 format is annotation, not buffered)", () => {
    // Under 3.0 OpenAPI semantics `format` asserts, so a format string buffers;
    // proving the version is detected. A bare 2020-12 schema would not.
    const budget = analyzeSpec(
      doc({
        openapi: "3.0.3",
        paths: {
          "/x": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      additionalProperties: false,
                      properties: { when: { type: "string", format: "date-time" } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    expect(budget.operations[0]!.bodies[0]!.report?.classification).toBe("buffer");
  });
});

describe("analyzeSpec and x- keys under paths (#1342)", () => {
  it("does not list an operation under an extension key", () => {
    const body = { content: { "application/json": { schema: { type: "object" } } } };
    const budget = analyzeSpec(
      doc({
        paths: {
          "/real": { post: { requestBody: body } },
          "x-vendor": { post: { requestBody: body } },
        },
      }),
    );
    expect(budget.operations.map((op) => `${op.method} ${op.path}`)).toEqual(["POST /real"]);
  });
});

describe("analyzeSpec reads operations from the operation model", () => {
  const body = (type: string) => ({
    content: { "application/json": { schema: { type } } },
  });
  const listed = (document: OpenAPIDocument): string[] =>
    analyzeSpec(document).operations.map((op) => `${op.method} ${op.path}`);

  it("lists an operation a paths entry reaches through a Path Item reference (#1343)", () => {
    const document = doc({
      paths: {
        "/direct": { post: { requestBody: body("object") } },
        "/viaRef": { $ref: "#/components/pathItems/P" },
      },
      components: { pathItems: { P: { post: { requestBody: body("array") } } } },
    });
    expect(listed(document)).toEqual(["POST /direct", "POST /viaRef"]);
  });

  it("follows a chain, the field written nearest the entry winning", () => {
    const document = doc({
      paths: { "/p": { $ref: "#/x-items/Mid", get: { requestBody: body("string") } } },
      "x-items": {
        Mid: {
          $ref: "#/x-items/Final",
          get: { requestBody: body("unknown-type-that-would-fail") },
          put: { requestBody: body("object") },
        },
        Final: { post: { requestBody: body("array") } },
      },
    });
    const budget = analyzeSpec(document);
    expect(budget.operations.map((op) => `${op.method} ${op.path}`)).toEqual([
      "GET /p",
      "PUT /p",
      "POST /p",
    ]);
    expect(budget.operations[0]!.bodies[0]!.error).toBeUndefined();
  });

  it("lists the entry's own operations when its reference does not resolve", () => {
    const document = doc({
      paths: { "/p": { $ref: "#/nope", post: { requestBody: body("object") } } },
    });
    expect(listed(document)).toEqual(["POST /p"]);
  });

  it("lists a referenced Path Item once for each path that references it", () => {
    const document = doc({
      paths: {
        "/a": { $ref: "#/components/pathItems/P" },
        "/b": { $ref: "#/components/pathItems/P" },
      },
      components: { pathItems: { P: { post: { requestBody: body("object") } } } },
    });
    expect(listed(document)).toEqual(["POST /a", "POST /b"]);
  });

  it("reads a method field an in-memory entry inherits or hides from enumeration", () => {
    const inherited = Object.create({ post: { requestBody: body("object") } }) as object;
    const hidden = Object.defineProperty({}, "put", {
      value: { requestBody: body("object") },
      enumerable: false,
    });
    const viaRef = Object.assign(
      Object.create({ get: { requestBody: body("string") } }) as object,
      {
        $ref: "#/components/pathItems/P",
      },
    );
    const document = doc({
      paths: { "/inherited": inherited, "/hidden": hidden, "/viaRef": viaRef },
      components: {
        pathItems: {
          P: { get: { requestBody: body("unknown-type") }, post: { requestBody: body("array") } },
        },
      },
    });
    const budget = analyzeSpec(document);
    expect(budget.operations.map((op) => `${op.method} ${op.path}`)).toEqual([
      "POST /inherited",
      "PUT /hidden",
      "GET /viaRef",
      "POST /viaRef",
    ]);
    expect(budget.operations[2]!.bodies[0]!.error).toBeUndefined();
  });

  it("lets a method field readable on the entry shadow the referenced one, whatever it holds", () => {
    const target = { post: { requestBody: body("string") }, put: { requestBody: body("array") } };
    const hidden = Object.defineProperty({ $ref: "#/components/pathItems/P" }, "post", {
      value: null,
    });
    const inherited = Object.assign(Object.create({ post: null }) as object, {
      $ref: "#/components/pathItems/P",
    });
    const document = doc({
      paths: {
        "/written": { $ref: "#/components/pathItems/P", post: null },
        "/hidden": hidden,
        "/inherited": inherited,
      },
      components: { pathItems: { P: target } },
    });
    expect(listed(document)).toEqual(["PUT /written", "PUT /hidden", "PUT /inherited"]);
  });

  it("keeps to paths and to fixed method fields", () => {
    const document = doc({
      openapi: "3.2.0",
      paths: {
        "/p": {
          query: { requestBody: body("object") },
          additionalOperations: {
            PURGE: { requestBody: body("object") },
            get: { requestBody: body("object") },
          },
          post: {
            requestBody: body("object"),
            callbacks: { c: { "{$url}": { post: { requestBody: body("object") } } } },
          },
        },
        "x-vendor": { get: { requestBody: body("object") } },
      },
      webhooks: { w: { post: { requestBody: body("object") } } },
      components: { pathItems: { Loose: { post: { requestBody: body("object") } } } },
    });
    expect(listed(document)).toEqual(["POST /p", "QUERY /p"]);
  });
});

describe("analyzeSpec and what lies outside paths", () => {
  it("does not descend into callbacks, however deeply they nest", () => {
    const body = { content: { "application/json": { schema: { type: "string" } } } };
    let nested: Record<string, unknown> = { post: { requestBody: body } };
    for (let i = 0; i < 20_000; i += 1) {
      nested = { post: { callbacks: { c: { "{$request.query.url}": nested } } } };
    }
    const budget = analyzeSpec(
      doc({
        paths: { "/p": { post: { requestBody: body, callbacks: { c: { "{$url}": nested } } } } },
        components: { pathItems: { Unused: nested } },
      }),
    );
    expect(budget.operations.map((op) => `${op.method} ${op.path}`)).toEqual(["POST /p"]);
  });

  it("returns for a document whose webhooks, components and callbacks hold broken references", () => {
    const body = { content: { "application/json": { schema: { type: "object" } } } };
    const budget = analyzeSpec(
      doc({
        paths: {
          "/p": {
            post: {
              requestBody: body,
              callbacks: {
                missing: { $ref: "#/components/callbacks/Nope" },
                loop: { $ref: "#/components/callbacks/A" },
                external: { $ref: "other.yaml#/cb" },
              },
            },
          },
        },
        webhooks: { w: { $ref: "#/nope" }, n: null, s: "text" },
        components: {
          callbacks: {
            A: { $ref: "#/components/callbacks/B" },
            B: { $ref: "#/components/callbacks/A" },
          },
          pathItems: { P: { $ref: "#/components/pathItems/P" } },
        },
      }),
    );
    expect(budget.operations.map((op) => `${op.method} ${op.path}`)).toEqual(["POST /p"]);
  });
});

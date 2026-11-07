import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { lintResolvedSpec } from "../src/lint.js";

const qs = (name: string) => ({
  name,
  in: "querystring",
  content: { "application/x-www-form-urlencoded": { schema: { type: "object" } } },
});
const query = (name: string) => ({ name, in: "query", schema: { type: "string" } });
const responses = { "200": { description: "ok" } };

function doc(pathItem: Record<string, unknown>, openapi = "3.2.0", rest = {}): OpenAPIDocument {
  return {
    openapi,
    info: { title: "t", version: "1" },
    paths: { "/a": pathItem },
    ...rest,
  } as unknown as OpenAPIDocument;
}

const found = (document: OpenAPIDocument, code = "querystring-conflict"): string[] =>
  lintResolvedSpec(document)
    .filter((i) => i.code === code)
    .map((i) => i.pointer);

describe("querystring-conflict", () => {
  it("reports two querystring parameters in one operation", () => {
    const document = doc({ get: { parameters: [qs("a"), qs("b")], responses } });
    expect(found(document)).toEqual(["/paths/~1a/get/parameters/1"]);
  });

  it("reports querystring mixed with query, in either order", () => {
    expect(found(doc({ get: { parameters: [query("a"), qs("b")], responses } }))).toEqual([
      "/paths/~1a/get/parameters/1",
    ]);
    expect(found(doc({ get: { parameters: [qs("b"), query("a")], responses } }))).toEqual([
      "/paths/~1a/get/parameters/1",
    ]);
  });

  it("spans the Path Item and the operation", () => {
    expect(
      found(doc({ parameters: [query("a")], get: { parameters: [qs("b")], responses } })),
    ).toEqual(["/paths/~1a/get/parameters/0"]);
    expect(
      found(doc({ parameters: [qs("b")], get: { parameters: [query("a")], responses } })),
    ).toEqual(["/paths/~1a/get/parameters/0"]);
    expect(
      found(doc({ parameters: [qs("a")], get: { parameters: [qs("b")], responses } })),
    ).toEqual(["/paths/~1a/get/parameters/0"]);
  });

  it("reports each operation a Path Item entry conflicts with", () => {
    const document = doc({
      parameters: [qs("a")],
      get: { parameters: [query("x")], responses },
      post: { responses },
      put: { parameters: [query("y")], responses },
    });
    expect(found(document)).toEqual(["/paths/~1a/get/parameters/0", "/paths/~1a/put/parameters/0"]);
  });

  it("reports a conflict inside a Path Item list once", () => {
    const document = doc({
      parameters: [qs("a"), query("b")],
      get: { responses },
      post: { responses },
    });
    expect(found(document)).toEqual(["/paths/~1a/parameters/1"]);
  });

  it("reports on a Path Item with no operations", () => {
    expect(found(doc({ parameters: [qs("a"), qs("b")] }))).toEqual(["/paths/~1a/parameters/1"]);
  });

  it("does not report an operation overriding a path-level querystring", () => {
    const document = doc({ parameters: [qs("a")], get: { parameters: [qs("a")], responses } });
    expect(found(document)).toEqual([]);
  });

  it("leaves the same name and location twice to duplicate-parameter", () => {
    const document = doc({ get: { parameters: [qs("a"), qs("a")], responses } });
    expect(found(document)).toEqual([]);
    expect(found(document, "duplicate-parameter")).toEqual(["/paths/~1a/get/parameters/1"]);
  });

  it("reads a parameter behind a reference", () => {
    const document = doc(
      { get: { parameters: [{ $ref: "#/components/parameters/Q" }, query("x")], responses } },
      "3.2.0",
      { components: { parameters: { Q: qs("a") } } },
    );
    expect(found(document)).toEqual(["/paths/~1a/get/parameters/1"]);
  });

  it("covers additionalOperations and webhooks", () => {
    expect(
      found(
        doc({
          additionalOperations: { COPY: { parameters: [qs("a"), qs("b")], responses } },
        }),
      ),
    ).toEqual(["/paths/~1a/additionalOperations/COPY/parameters/1"]);
    const webhook = doc({}, "3.2.0", {
      webhooks: { hook: { post: { parameters: [qs("a"), query("b")], responses } } },
    });
    expect(found(webhook)).toEqual(["/webhooks/hook/post/parameters/1"]);
  });

  describe("across a Path Item reference", () => {
    const P = "#/components/pathItems/P";

    it("sees parameters beside the reference and an operation in its target", () => {
      const document = doc({ $ref: P, parameters: [qs("whole")] }, "3.2.0", {
        components: { pathItems: { P: { get: { parameters: [query("q")], responses } } } },
      });
      expect(found(document)).toEqual(["/components/pathItems/P/get/parameters/0"]);
    });

    it("sees parameters in the target and an operation beside the reference", () => {
      const document = doc({ $ref: P, get: { parameters: [query("q")], responses } }, "3.2.0", {
        components: { pathItems: { P: { parameters: [qs("whole")] } } },
      });
      expect(found(document)).toEqual(["/paths/~1a/get/parameters/0"]);
    });

    it("reports a conflict in a target several entries reach once", () => {
      const document = {
        ...doc({ $ref: P }, "3.2.0", {
          components: {
            pathItems: { P: { get: { parameters: [qs("a"), qs("b")], responses } } },
          },
        }),
      } as OpenAPIDocument;
      (document.paths as Record<string, unknown>)["/b"] = { $ref: P };
      expect(found(document)).toEqual(["/components/pathItems/P/get/parameters/1"]);
    });
  });

  it("names the parameter each finding conflicts with", () => {
    const [issue] = lintResolvedSpec(
      doc({ parameters: [query("x")], get: { parameters: [qs("b")], responses } }),
    ).filter((i) => i.code === "querystring-conflict");
    expect(issue?.message).toBe(
      'querystring parameter "b" conflicts with query parameter "x" at /paths/~1a/parameters/0; querystring must not be combined with query parameters',
    );
  });

  it("accepts one querystring, and query parameters alone", () => {
    expect(found(doc({ get: { parameters: [qs("a")], responses } }))).toEqual([]);
    expect(found(doc({ get: { parameters: [query("a"), query("b")], responses } }))).toEqual([]);
  });

  it.each(["3.0.3", "3.1.0"])("does not apply to %s, which has no such location", (openapi) => {
    expect(found(doc({ get: { parameters: [qs("a"), qs("b")], responses } }, openapi))).toEqual([]);
  });

  it("does not trip on an unreadable list or entry", () => {
    expect(
      found(doc({ parameters: "nope", get: { parameters: [null, 1, qs("a")], responses } })),
    ).toEqual([]);
  });
});

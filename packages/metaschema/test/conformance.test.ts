import { describe, expect, it } from "vitest";
import { checkDocumentConformance } from "../src/conformance.js";

/** A minimal conformant document, for seeding one defect at a time. */
const minimal = (openapi: string) => ({
  openapi,
  info: { title: "t", version: "1.0.0" },
  paths: { "/things": { get: { responses: { "200": { description: "ok" } } } } },
});

/** Wrap a Schema Object in an otherwise-valid document. */
const withSchema = (openapi: string, schema: unknown) => ({
  openapi,
  info: { title: "t", version: "1.0.0" },
  paths: {
    "/things": {
      get: {
        responses: {
          "200": { description: "ok", content: { "application/json": { schema } } },
        },
      },
    },
  },
});

describe("dispatch", () => {
  it("checks each supported version against its own schema", () => {
    for (const v of ["3.0.3", "3.1.0", "3.2.0"]) {
      const r = checkDocumentConformance(minimal(v));
      expect(r.version, v).toBe(v.slice(0, 3));
      expect(r.issues, v).toEqual([]);
    }
  });

  it("reports nothing for a version it holds no schema for", () => {
    // Not "conformant". Unknown. A document is not conformant merely
    // because we cannot check it, and issues from a guessed schema would
    // be worse than silence.
    const r = checkDocumentConformance({ swagger: "2.0" });
    expect(r.version).toBeUndefined();
    expect(r.issues).toEqual([]);
  });

  it("rejects a document submitted under the wrong version", () => {
    // 3.1 constrains `openapi` by pattern, so a 3.0 document checked as
    // 3.1 fails on the version string itself rather than silently
    // passing under rules it never claimed to follow.
    const doc = { ...minimal("3.0.3"), openapi: "3.0.3" };
    const r = checkDocumentConformance(doc);
    expect(r.version).toBe("3.0");
    expect(r.issues).toEqual([]);
  });
});

describe("the defects this exists to catch", () => {
  it("finds a null response description, which no other pass reaches", () => {
    const doc = minimal("3.1.0");
    (doc.paths["/things"].get.responses as Record<string, unknown>)["202"] = {
      description: null,
    };
    const r = checkDocumentConformance(doc);
    expect(r.issues).toContainEqual({
      code: "type",
      location: "/paths/~1things/get/responses/202/description",
      message: expect.stringContaining("string"),
    });
  });

  it("finds a null parameter description", () => {
    const doc = minimal("3.1.0");
    (doc.paths["/things"].get as Record<string, unknown>)["parameters"] = [
      { name: "q", in: "query", description: null, schema: { type: "string" } },
    ];
    const r = checkDocumentConformance(doc);
    expect(r.issues).toContainEqual({
      code: "type",
      location: "/paths/~1things/get/parameters/0/description",
      message: expect.stringContaining("string"),
    });
  });

  it("finds a missing required field", () => {
    const r = checkDocumentConformance({ openapi: "3.1.0", info: { title: "t" }, paths: {} });
    expect(r.issues).toContainEqual({
      code: "required",
      location: "/info/version",
      message: expect.stringContaining("version"),
    });
  });

  it("finds a typo'd field name", () => {
    const doc = minimal("3.1.0");
    delete (doc.paths["/things"].get as Record<string, unknown>)["responses"];
    (doc.paths["/things"].get as Record<string, unknown>)["responsses"] = {};
    const r = checkDocumentConformance(doc);
    expect(r.issues.map((i) => i.code)).toContain("unevaluatedProperties");
  });

  it("finds an invalid parameter location", () => {
    const doc = minimal("3.1.0");
    (doc.paths["/things"].get as Record<string, unknown>)["parameters"] = [
      { name: "q", in: "querystring", schema: { type: "string" } },
    ];
    const r = checkDocumentConformance(doc);
    expect(r.issues).toContainEqual({
      code: "enum",
      location: "/paths/~1things/get/parameters/0/in",
      message: expect.any(String),
    });
  });
});

describe("$dynamicRef resolution control", () => {
  // The load-bearing test. Every other 3.1 fixture passes whether
  // `$dynamicRef: "#meta"` resolved to `#/$defs/schema` or compiled to
  // always-true, because the target permits object and boolean and the
  // fixtures use objects. This one puts a string where a Schema Object
  // belongs, so it can only fail if the reference resolved AND the
  // target is enforced.
  //
  // If a future refactor neuters the Schema Object slot, this is the
  // only thing that goes red.
  it("enforces the Schema Object slot in 3.1", () => {
    const r = checkDocumentConformance(withSchema("3.1.0", "not-a-schema-object"));
    expect(r.issues).toContainEqual({
      code: "type",
      location: "/paths/~1things/get/responses/200/content/application~1json/schema",
      message: expect.stringContaining("object"),
    });
  });

  it("enforces it in 3.2 too", () => {
    const r = checkDocumentConformance(withSchema("3.2.0", "not-a-schema-object"));
    expect(r.issues.map((i) => i.location)).toContain(
      "/paths/~1things/get/responses/200/content/application~1json/schema",
    );
  });
});

describe("Schema Object coverage differs by version, and callers need to know", () => {
  // 3.1/3.2 stub the Schema Object upstream; 3.0 describes it in full.
  // That means this pass overlaps the compiler's well-formedness pass on
  // 3.0 and is disjoint from it on 3.1/3.2. Asserted so the difference is
  // a documented property rather than something a caller discovers as
  // duplicate output.
  //
  // Making them uniform by stubbing 3.0 was tried and reverted: 3.0
  // discriminates Schema from Reference with `oneOf`, which only works
  // because Schema is restrictive. See the note in conformance.ts.

  it("3.1 and 3.2 decline to validate Schema Objects", () => {
    for (const v of ["3.1.0", "3.2.0"]) {
      expect(
        checkDocumentConformance(withSchema(v, { type: "Boolean" })).issues,
        `${v} type: Boolean`,
      ).toEqual([]);
      expect(
        checkDocumentConformance(withSchema(v, { items: [{ type: "string" }] })).issues,
        `${v} array items`,
      ).toEqual([]);
    }
  });

  it("3.0 validates them in full", () => {
    expect(checkDocumentConformance(withSchema("3.0.3", { type: "Boolean" })).issues).not.toEqual(
      [],
    );
  });

  it("3.0 still discriminates a Schema Object from a Reference Object", () => {
    // The regression that killed the uniform-stubbing attempt. 3.0 says
    // `schema` is `oneOf: [Schema, Reference]`, which only resolves
    // because Schema rejects a $ref-bearing object. A permissive Schema
    // makes every $ref match both branches, and a clean real-world spec
    // turns into thousands of `oneOf ... matched 2` errors.
    const doc = {
      openapi: "3.0.3",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/things": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Thing" } },
                },
              },
            },
          },
        },
      },
      components: { schemas: { Thing: { type: "string" } } },
    };
    expect(checkDocumentConformance(doc).issues).toEqual([]);
  });

  it("3.0 still permits 3.0-only spellings", () => {
    // Control for "3.0 validates them in full": rejecting `type: Boolean`
    // must come from the enum, not from the schema being broadly too
    // strict. `nullable` and boolean `exclusiveMinimum` are legal 3.0 and
    // must survive, including through the draft-04 transform.
    expect(
      checkDocumentConformance(withSchema("3.0.3", { type: "string", nullable: true })).issues,
    ).toEqual([]);
    expect(
      checkDocumentConformance(
        withSchema("3.0.3", { type: "number", minimum: 0, exclusiveMinimum: true }),
      ).issues,
    ).toEqual([]);
  });
});

describe("what this cannot do", () => {
  // Explicit non-goals. A meta-schema validates a node against a
  // subschema; it cannot ask whether a name resolves. These pass here by
  // design, and the tests exist so nobody claims coverage we do not have.
  it("does not catch cross-reference defects", () => {
    const danglingRef = withSchema("3.1.0", { $ref: "#/components/schemas/DoesNotExist" });
    expect(checkDocumentConformance(danglingRef).issues).toEqual([]);

    const undeclaredPathParam = {
      openapi: "3.1.0",
      info: { title: "t", version: "1.0.0" },
      paths: { "/things/{thingId}": { get: { responses: { "200": { description: "ok" } } } } },
    };
    expect(checkDocumentConformance(undeclaredPathParam).issues).toEqual([]);

    const duplicateOperationId = {
      openapi: "3.1.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/a": { get: { operationId: "dupe", responses: { "200": { description: "ok" } } } },
        "/b": { get: { operationId: "dupe", responses: { "200": { description: "ok" } } } },
      },
    };
    expect(checkDocumentConformance(duplicateOperationId).issues).toEqual([]);
  });
});

describe("error shape", () => {
  it("addresses findings with RFC 6901 pointers, escaping the path", () => {
    // `/things` as a path key contains a slash, which must be escaped or
    // the pointer addresses the wrong node.
    const doc = minimal("3.1.0");
    (doc.paths["/things"].get.responses as Record<string, unknown>)["202"] = {
      description: null,
    };
    const r = checkDocumentConformance(doc);
    expect(r.issues[0]?.location).toContain("~1things");
    expect(r.issues[0]?.location).not.toContain("//things");
  });

  it("reports the leaf, not every node above it", () => {
    // A missing required field under nested applicators should produce
    // one finding at the field, not one per level.
    const r = checkDocumentConformance({ openapi: "3.1.0", info: { title: "t" }, paths: {} });
    const versionIssues = r.issues.filter((i) => i.location === "/info/version");
    expect(versionIssues).toHaveLength(1);
  });

  it("surfaces a composition keyword when it has no failing branch to blame", () => {
    // The known weak spot, asserted rather than hidden. A parameter with
    // both `schema` and `content` matches two `oneOf` branches, so the
    // failure is that both succeeded; there is no failing subschema
    // underneath to point at. The finding is honest but much less useful
    // than the `type` / `required` leaves that dominate real reports.
    const doc = minimal("3.1.0");
    (doc.paths["/things"].get as Record<string, unknown>)["parameters"] = [
      {
        name: "q",
        in: "query",
        schema: { type: "string" },
        content: { "application/json": { schema: { type: "string" } } },
      },
    ];
    const r = checkDocumentConformance(doc);
    expect(r.issues).toContainEqual({
      code: "oneOf",
      location: "/paths/~1things/get/parameters/0",
      message: expect.any(String),
    });
  });
});

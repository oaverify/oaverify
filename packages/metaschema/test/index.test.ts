import { describe, expect, it } from "vitest";
import {
  METASCHEMA_REVISIONS,
  metaschemaFor,
  metaschemaUrl,
  metaschemaVersionOf,
  type MetaschemaVersion,
} from "../src/index.js";

const VERSIONS: MetaschemaVersion[] = ["3.0", "3.1", "3.2"];

describe("metaschemaVersionOf", () => {
  it("reads the minor version off a patch release", () => {
    expect(metaschemaVersionOf({ openapi: "3.0.3" })).toBe("3.0");
    expect(metaschemaVersionOf({ openapi: "3.1.0" })).toBe("3.1");
    expect(metaschemaVersionOf({ openapi: "3.2.0" })).toBe("3.2");
  });

  it("accepts a bare minor version", () => {
    expect(metaschemaVersionOf({ openapi: "3.1" })).toBe("3.1");
  });

  it("returns undefined rather than guessing", () => {
    // Guessing a schema for an unrecognised version would validate the
    // document against rules it never claimed to follow, and every
    // error downstream of the guess would be noise.
    expect(metaschemaVersionOf({ swagger: "2.0" })).toBeUndefined();
    expect(metaschemaVersionOf({ openapi: "3.3.0" })).toBeUndefined();
    expect(metaschemaVersionOf({ openapi: "4.0.0" })).toBeUndefined();
    expect(metaschemaVersionOf({ openapi: 3.1 })).toBeUndefined();
    expect(metaschemaVersionOf({})).toBeUndefined();
    expect(metaschemaVersionOf(null)).toBeUndefined();
    expect(metaschemaVersionOf("3.1.0")).toBeUndefined();
  });

  it("does not match a longer version that merely starts with a known one", () => {
    // "3.10" is not "3.1". Without the delimiter check a prefix match
    // would route a hypothetical 3.10 document to the 3.1 schema.
    expect(metaschemaVersionOf({ openapi: "3.10.0" })).toBeUndefined();
  });
});

describe("metaschemaFor", () => {
  it("returns a distinct document per version", () => {
    const docs = VERSIONS.map((v) => metaschemaFor(v));
    expect(new Set(docs).size).toBe(VERSIONS.length);
  });

  it("returns documents that declare the 2020-12 dialect", () => {
    // The compiler is 2020-12. 3.1 and 3.2 ship that way; 3.0 is
    // draft-04 upstream and only reaches here through the transform in
    // scripts/convert-oas30.mjs, so this assertion is what proves the
    // generated file was regenerated rather than the raw one vendored.
    for (const v of VERSIONS) {
      const doc = metaschemaFor(v) as { $schema?: string };
      expect(doc.$schema, `${v} dialect`).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });

  it("pins each document to the revision it claims", () => {
    for (const v of VERSIONS) {
      const doc = metaschemaFor(v) as { $id?: string };
      expect(doc.$id, `${v} $id`).toContain(METASCHEMA_REVISIONS[v]);
    }
  });

  // How much of the Schema Object a meta-schema covers differs by
  // version, and the division of labour with the compiler's
  // well-formedness pass follows from it. Asserted here so a change
  // upstream fails loudly instead of surfacing as duplicate findings
  // (3.1/3.2) or a silent coverage loss (3.0).

  it("stubs the Schema Object in 3.1 and 3.2", () => {
    // 3.1 aligned the Schema Object with JSON Schema 2020-12, so the
    // meta-schema defers to a swappable dialect through `$dynamicRef`
    // and validates none of it. The compiler's well-formedness pass
    // owns that half; the two do not overlap.
    for (const v of ["3.1", "3.2"] as const) {
      const doc = metaschemaFor(v) as { $defs?: { schema?: { type?: unknown } } };
      expect(doc.$defs?.schema?.type, `${v} Schema Object stub`).toEqual(["object", "boolean"]);
    }
  });

  it("describes the Schema Object in full in 3.0", () => {
    // 3.0's Schema Object is a bespoke subset rather than JSON Schema,
    // so OpenAPI had to spell it out: 35 properties, `type` constrained
    // to an enum, `items` required to be a Schema or Reference. The
    // practical consequence is that for 3.0 documents the meta-schema
    // and the well-formedness pass DO overlap, and both will have an
    // opinion about e.g. `type: Boolean`. Whichever surface reports
    // conformance findings has to decide precedence rather than
    // printing both.
    const doc = metaschemaFor("3.0") as {
      definitions?: { Schema?: { properties?: Record<string, unknown> } };
    };
    const props = doc.definitions?.Schema?.properties ?? {};
    expect(Object.keys(props).length).toBeGreaterThan(30);
    expect(props["type"]).toEqual({
      type: "string",
      enum: ["array", "boolean", "integer", "number", "object", "string"],
    });
  });
});

describe("metaschemaUrl", () => {
  it("addresses the pinned revision", () => {
    expect(metaschemaUrl("3.1")).toBe(
      `https://spec.openapis.org/oas/3.1/schema/${METASCHEMA_REVISIONS["3.1"]}`,
    );
  });

  it("covers every version", () => {
    for (const v of VERSIONS) expect(metaschemaUrl(v)).toContain(`/oas/${v}/schema/`);
  });
});

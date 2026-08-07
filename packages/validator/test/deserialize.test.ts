import { describe, expect, it } from "vitest";
import type { SchemaObject } from "@oaverify/internal-core";
import { createRefResolver, resolve } from "@oaverify/internal-schema";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import type { SchemaRefResolver } from "../src/deserialize.js";
import { coercionView, deserialize, matchMediaType, matchResponseKey } from "../src/deserialize.js";

describe("deserialize", () => {
  it("returns undefined for absent values", () => {
    expect(deserialize(undefined, { name: "x", in: "query" })).toBeUndefined();
  });

  it("coerces integer query scalars", () => {
    expect(deserialize("42", { name: "x", in: "query", schema: { type: "integer" } })).toBe(42);
  });

  it("leaves non-numeric integers as the original string", () => {
    expect(deserialize("abc", { name: "x", in: "query", schema: { type: "integer" } })).toBe("abc");
  });

  it("coerces boolean scalars", () => {
    expect(deserialize("true", { name: "x", in: "query", schema: { type: "boolean" } })).toBe(true);
    expect(deserialize("false", { name: "x", in: "query", schema: { type: "boolean" } })).toBe(
      false,
    );
  });

  it("splits comma-delimited arrays (form, no explode)", () => {
    const out = deserialize("1,2,3", {
      name: "ids",
      in: "query",
      explode: false,
      schema: { type: "array", items: { type: "integer" } },
    });
    // #707: item coercion is driven by `items`, so each element lands
    // as the integer its schema declares.
    expect(out).toEqual([1, 2, 3]);
  });

  it("coerces items of a repeated (exploded) array param", () => {
    // #707: `ids=1&ids=2&ids=3` arrives as a string[] from the adapter.
    const out = deserialize(["1", "2", "3"], {
      name: "ids",
      in: "query",
      schema: { type: "array", items: { type: "integer" } },
    });
    expect(out).toEqual([1, 2, 3]);
  });

  it("coerces items of a simple-style path array", () => {
    // #707: /pets/1,2,3
    const out = deserialize("1,2,3", {
      name: "ids",
      in: "path",
      schema: { type: "array", items: { type: "number" } },
    });
    expect(out).toEqual([1, 2, 3]);
  });

  it("coerces boolean array items", () => {
    const out = deserialize("true,false", {
      name: "flags",
      in: "query",
      explode: false,
      schema: { type: "array", items: { type: "boolean" } },
    });
    expect(out).toEqual([true, false]);
  });

  it("leaves items as strings when prefixItems governs the leading elements", () => {
    // #707 review: with prefixItems, `items` covers only the elements
    // past the prefix, so it cannot drive coercion for all of them.
    // Coercing here would turn a passing request into a 400.
    const out = deserialize("12,3", {
      name: "a",
      in: "query",
      explode: false,
      schema: {
        type: "array",
        prefixItems: [{ type: "string" }],
        items: { type: "number" },
      },
    });
    expect(out).toEqual(["12", "3"]);
  });

  it("leaves items as strings when the items schema is a $ref", () => {
    // resolveSpec leaves internal $refs at their use sites, so this is a
    // real spec shape. It coerces nothing, matching how a $ref-valued
    // scalar parameter schema already behaves.
    const out = deserialize("1,2", {
      name: "a",
      in: "query",
      explode: false,
      schema: { type: "array", items: { $ref: "#/components/schemas/Id" } },
    });
    expect(out).toEqual(["1", "2"]);
  });

  it("leaves items as strings when items is absent or tuple-form", () => {
    // No single item type to coerce with, so the raw strings stand.
    expect(
      deserialize("1,2", { name: "a", in: "query", explode: false, schema: { type: "array" } }),
    ).toEqual(["1", "2"]);
    expect(
      deserialize("1,2", {
        name: "a",
        in: "query",
        explode: false,
        schema: {
          type: "array",
          items: [{ type: "integer" }, { type: "integer" }],
        } as unknown as SchemaObject,
      }),
    ).toEqual(["1", "2"]);
  });

  it("splits pipe-delimited arrays", () => {
    const out = deserialize("a|b|c", {
      name: "tags",
      in: "query",
      style: "pipeDelimited",
      explode: false,
      schema: { type: "array" },
    });
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("splits space-delimited arrays on the decoded space", () => {
    // Query values reach deserialize already URL-decoded, so a
    // spaceDelimited array arrives space-separated, not "%20"-separated.
    const out = deserialize("a b c", {
      name: "ids",
      in: "query",
      style: "spaceDelimited",
      explode: false,
      schema: { type: "array" },
    });
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("treats empty string arrays as an empty array", () => {
    const out = deserialize("", {
      name: "ids",
      in: "query",
      schema: { type: "array" },
    });
    expect(out).toEqual([]);
  });

  it("strips matrix-style prefixes", () => {
    expect(
      deserialize(";petId=42", {
        name: "petId",
        in: "path",
        style: "matrix",
        schema: { type: "integer" },
      }),
    ).toBe(42);
  });

  it("strips label-style prefixes", () => {
    expect(
      deserialize(".42", {
        name: "petId",
        in: "path",
        style: "label",
        schema: { type: "integer" },
      }),
    ).toBe(42);
  });

  it("explodes form-style objects into records", () => {
    const out = deserialize("a=1&b=2", {
      name: "f",
      in: "query",
      schema: { type: "object" },
    });
    expect(out).toEqual({ a: "1", b: "2" });
  });

  it("returns the raw string for deepObject-style objects", () => {
    const out = deserialize("color[r]=100", {
      name: "color",
      in: "query",
      style: "deepObject",
      schema: { type: "object" },
    });
    expect(out).toBe("color[r]=100");
  });

  it("parses form-style objects with explode:false as flat comma-separated kv pairs", () => {
    // eov #1064: `?id=role,admin,firstName,Alex` against a type:object
    // schema with explode:false must produce { role: "admin", firstName: "Alex" }.
    const out = deserialize("role,admin,firstName,Alex", {
      name: "id",
      in: "query",
      explode: false,
      schema: { type: "object" },
    });
    expect(out).toEqual({ role: "admin", firstName: "Alex" });
  });

  it("wraps a single-value repeated-explode array param as a one-element array", () => {
    // eov #27: `?x=foo` against a type:array schema with explode:true
    // (the form default) must yield ["foo"], not "foo".
    const out = deserialize("foo", {
      name: "x",
      in: "query",
      schema: { type: "array", items: { type: "string" } },
    });
    expect(out).toEqual(["foo"]);
  });
});

describe("matchMediaType", () => {
  it("returns undefined when contentType is absent", () => {
    expect(matchMediaType(undefined, ["application/json"])).toBeUndefined();
  });

  it("matches an exact pattern", () => {
    expect(matchMediaType("application/json", ["application/json"])).toBe("application/json");
  });

  it("ignores charset parameters", () => {
    expect(matchMediaType("application/json; charset=utf-8", ["application/json"])).toBe(
      "application/json",
    );
  });

  it("prefers the more specific pattern when several match", () => {
    const patterns = ["*/*", "application/*", "application/json"];
    expect(matchMediaType("application/json", patterns)).toBe("application/json");
    expect(matchMediaType("application/xml", patterns)).toBe("application/*");
    expect(matchMediaType("text/plain", patterns)).toBe("*/*");
  });

  it("is case-insensitive", () => {
    expect(matchMediaType("Application/JSON", ["application/json"])).toBe("application/json");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchMediaType("text/plain", ["application/json"])).toBeUndefined();
  });

  it("matches versioned/vendor media-type parameters on both sides", () => {
    // eov #862: specs that declare vendored/versioned media types should
    // match requests with those parameters present.
    expect(matchMediaType("application/json; version=1", ["application/json; version=1"])).toBe(
      "application/json; version=1",
    );
    // Concrete side may carry additional parameters (e.g. charset) on
    // top of the ones the pattern requires.
    expect(
      matchMediaType("application/json; version=1; charset=utf-8", ["application/json; version=1"]),
    ).toBe("application/json; version=1");
  });

  it("prefers a pattern with matching parameters over a bare type", () => {
    const patterns = ["application/json", "application/json; version=1"];
    expect(matchMediaType("application/json; version=1", patterns)).toBe(
      "application/json; version=1",
    );
    expect(matchMediaType("application/json; version=2", patterns)).toBe("application/json");
  });

  it("rejects a request whose parameters don't match the pattern", () => {
    expect(matchMediaType("application/json", ["application/json; version=1"])).toBeUndefined();
    expect(
      matchMediaType("application/json; version=2", ["application/json; version=1"]),
    ).toBeUndefined();
  });

  it("matches case-insensitively across the whole value, including parameters", () => {
    // eov #463: the RFC says parameter names are case-insensitive; values
    // are usually token-compared case-insensitively too. Normalising both
    // sides to lowercase keeps the comparison consistent.
    expect(
      matchMediaType("Application/JSON; Charset=UTF-8", ["application/json; charset=utf-8"]),
    ).toBe("application/json; charset=utf-8");
  });
});

describe("matchResponseKey", () => {
  it("prefers an exact status over a class match", () => {
    expect(matchResponseKey(404, { "404": {}, "4XX": {}, default: {} })).toBe("404");
  });

  it("falls back to the NXX class when no exact match exists", () => {
    expect(matchResponseKey(422, { "4XX": {}, default: {} })).toBe("4XX");
  });

  it("falls back to default when neither exact nor class match", () => {
    expect(matchResponseKey(500, { default: {} })).toBe("default");
  });

  it("returns undefined when no applicable key exists", () => {
    expect(matchResponseKey(500, { "200": {} })).toBeUndefined();
  });
});

describe("coercionView", () => {
  // The real resolver, not a stand-in: it chases a whole chain and
  // throws on a ref it will not follow, and a double that did neither is
  // what hid both behaviors from these tests.
  const doc = {
    components: {
      schemas: {
        Id: { type: "integer" },
        Ref: { $ref: "#/components/schemas/Id" },
        Loop: { $ref: "#/components/schemas/Loop" },
        // A chain deeper than a small hand-picked bound would allow.
        C0: { $ref: "#/components/schemas/C1" },
        C1: { $ref: "#/components/schemas/C2" },
        C2: { $ref: "#/components/schemas/C3" },
        C3: { $ref: "#/components/schemas/C4" },
        C4: { $ref: "#/components/schemas/C5" },
        C5: { $ref: "#/components/schemas/C6" },
        C6: { $ref: "#/components/schemas/C7" },
        C7: { $ref: "#/components/schemas/C8" },
        C8: { $ref: "#/components/schemas/Id" },
      },
    },
  };
  // Mirrors what createValidator binds: one hop, through the resolver
  // schemas compile with, throwing on a ref it cannot resolve.
  const graph = resolve(doc as unknown as SchemaOrBoolean);
  const refResolver = createRefResolver(graph);
  const resolveRef: SchemaRefResolver = (schema) => {
    const ref = schema.$ref;
    if (typeof ref !== "string") return schema;
    return refResolver.resolve(ref);
  };

  it("returns the parameter unchanged, by identity, when nothing is a $ref", () => {
    const p = { name: "a", in: "query", schema: { type: "integer" } } as const;
    expect(coercionView(p, resolveRef)).toBe(p);
  });

  it("returns the parameter unchanged when it has no schema or a boolean one", () => {
    const bare = { name: "a", in: "query" } as const;
    expect(coercionView(bare, resolveRef)).toBe(bare);
    const boolean = { name: "a", in: "query", schema: true } as const;
    expect(coercionView(boolean, resolveRef)).toBe(boolean);
  });

  it("resolves the schema, its items, and its properties", () => {
    const view = coercionView(
      {
        name: "a",
        in: "query",
        schema: { type: "array", items: { $ref: "#/components/schemas/Id" } },
      },
      resolveRef,
    );
    expect(view.schema).toMatchObject({ type: "array", items: { type: "integer" } });

    const obj = coercionView(
      {
        name: "b",
        in: "query",
        schema: { type: "object", properties: { id: { $ref: "#/components/schemas/Id" } } },
      },
      resolveRef,
    );
    expect(obj.schema).toMatchObject({ properties: { id: { type: "integer" } } });
  });

  it("follows a chain of refs", () => {
    const view = coercionView(
      { name: "a", in: "query", schema: { $ref: "#/components/schemas/Ref" } },
      resolveRef,
    );
    expect(view.schema).toMatchObject({ type: "integer" });
  });

  it("keeps use-site siblings of a $ref, which are a conjunction", () => {
    // `{ $ref: Arr, items: Id }`: the compiled validator honours the
    // sibling, so the coercion view has to as well or the two disagree.
    const view = coercionView(
      {
        name: "a",
        in: "query",
        schema: { $ref: "#/components/schemas/Id", items: { $ref: "#/components/schemas/Id" } },
      },
      resolveRef,
    );
    expect(view.schema).toMatchObject({ items: { type: "integer" } });
  });

  it("follows a chain longer than a handful of hops", () => {
    // The bound matches the resolver the rest of the cache uses, so a
    // chain the compiler resolves does not silently lose its coercion.
    const view = coercionView(
      { name: "a", in: "query", schema: { $ref: "#/components/schemas/C0" } },
      resolveRef,
    );
    expect(deserialize("7", view)).toBe(7);
  });

  it("gives up on a ref cycle rather than spinning", () => {
    const view = coercionView(
      { name: "a", in: "query", schema: { $ref: "#/components/schemas/Loop" } },
      resolveRef,
    );
    expect(() => deserialize("1", view)).not.toThrow();
    expect(deserialize("1", view)).toBe("1");
  });

  it("leaves the value a string when the resolver throws", () => {
    // Coercion is best-effort: the compiler resolves and validates the
    // same schema, and only the coercion is lost.
    const view = coercionView(
      { name: "a", in: "query", schema: { $ref: "https://nowhere.example/Missing" } },
      resolveRef,
    );
    expect(() => deserialize("1", view)).not.toThrow();
    expect(deserialize("1", view)).toBe("1");
  });

  it("leaves the value a string when the ref does not resolve", () => {
    const view = coercionView(
      { name: "a", in: "query", schema: { $ref: "#/components/schemas/Missing" } },
      resolveRef,
    );
    expect(deserialize("1", view)).toBe("1");
  });
});

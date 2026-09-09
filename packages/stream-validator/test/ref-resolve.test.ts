import { describe, expect, it } from "vitest";
import type { SchemaObject } from "@oaverify/internal-core";
import { resolveRef } from "../src/ref-resolve.js";

describe("resolveRef", () => {
  it("decodes an encoded separator before evaluating the JSON Pointer", () => {
    const target = { type: "string" };
    const root = {
      $defs: {
        Foo: { Bar: target },
        "Foo/Bar": { type: "number" },
      },
    } as SchemaObject;

    expect(resolveRef(root, "#/$defs/Foo%2FBar")).toBe(target);
  });

  it("keeps ordinary percent-encoded property text inside one token", () => {
    const root = { $defs: { "Foo Bar": { type: "string" } } } as SchemaObject;

    expect(resolveRef(root, "#/$defs/Foo%20Bar")).toBe(root.$defs?.["Foo Bar"]);
  });

  it("does not traverse inherited object properties", () => {
    expect(resolveRef({} as SchemaObject, "#/constructor")).toBeUndefined();
  });

  it("uses the RFC 6901 array-index grammar", () => {
    const target = { type: "string" };
    const tuple = [target];
    const root = {
      $defs: { tuple },
    } as unknown as SchemaObject;

    expect(resolveRef(root, "#/$defs/tuple/0")).toBe(target);
    for (const ref of ["#/$defs/tuple/00", "#/$defs/tuple/01", "#/$defs/tuple/1e0"]) {
      expect(resolveRef(root, ref), ref).toBeUndefined();
    }
  });

  it("decodes valid percent-escape runs beside malformed escapes", () => {
    const root = { $defs: { "f%ZZ": { type: "string" } } } as SchemaObject;

    expect(resolveRef(root, "#/$defs/%66%ZZ")).toBe(root.$defs?.["f%ZZ"]);
  });
});

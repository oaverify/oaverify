import { describe, expect, it } from "vitest";
import { sourceOf, withSynthetic, type SpecRegion } from "../src/provenance.js";

const entry: SpecRegion = { kind: "mounted", at: "", uri: "entry.yaml", pointer: "", via: [] };

describe("sourceOf", () => {
  it("subtracts the mount point from the resolved pointer", () => {
    expect(sourceOf([entry], "/paths/~1orders/post")).toEqual({
      uri: "entry.yaml",
      pointer: "/paths/~1orders/post",
      via: [],
    });
  });

  it("addresses the mount point itself, not only nodes below it", () => {
    const regions: SpecRegion[] = [
      entry,
      {
        kind: "mounted",
        at: "/components/schemas/Order",
        uri: "order.yaml",
        pointer: "/components/schemas/Order",
        via: [{ uri: "entry.yaml", pointer: "/paths/~1orders/post/requestBody" }],
      },
    ];
    expect(sourceOf(regions, "/components/schemas/Order")?.pointer).toBe(
      "/components/schemas/Order",
    );
    expect(sourceOf(regions, "/components/schemas/Order/required")?.pointer).toBe(
      "/components/schemas/Order/required",
    );
  });

  it("relocates a hoisted subtree: the resolved name is not the source name", () => {
    const regions: SpecRegion[] = [
      entry,
      {
        kind: "mounted",
        at: "/components/schemas/Order_a1b2",
        uri: "order.yaml",
        pointer: "/definitions/Order",
        via: [],
      },
    ];
    expect(sourceOf(regions, "/components/schemas/Order_a1b2/required/0")).toEqual({
      uri: "order.yaml",
      pointer: "/definitions/Order/required/0",
      via: [],
    });
  });

  it("mounts a whole document at pointer '' and appends the full suffix", () => {
    const regions: SpecRegion[] = [
      entry,
      {
        kind: "mounted",
        at: "/x-oaverify-externals/pet.yaml",
        uri: "pet.yaml",
        pointer: "",
        via: [],
      },
    ];
    expect(sourceOf(regions, "/x-oaverify-externals/pet.yaml/type")).toEqual({
      uri: "pet.yaml",
      pointer: "/type",
      via: [],
    });
  });

  it("matches on segment boundaries, not string prefixes", () => {
    const regions: SpecRegion[] = [
      entry,
      { kind: "mounted", at: "/paths/~1a", uri: "a.yaml", pointer: "", via: [] },
    ];
    // "/paths/~1ab" starts with "/paths/~1a" as a string and is a
    // different path item.
    expect(sourceOf(regions, "/paths/~1ab")?.uri).toBe("entry.yaml");
    expect(sourceOf(regions, "/paths/~1a/get")?.uri).toBe("a.yaml");
  });

  it("crosses array index segments", () => {
    const regions: SpecRegion[] = [
      entry,
      { kind: "mounted", at: "/paths/~1a/get/parameters/0", uri: "p.yaml", pointer: "", via: [] },
    ];
    expect(sourceOf(regions, "/paths/~1a/get/parameters/0/schema/type")).toEqual({
      uri: "p.yaml",
      pointer: "/schema/type",
      via: [],
    });
    expect(sourceOf(regions, "/paths/~1a/get/parameters/1")?.uri).toBe("entry.yaml");
  });

  it("gives the deepest region, whatever order they were recorded in", () => {
    const deep: SpecRegion = {
      kind: "mounted",
      at: "/paths/~1a/get/responses/200",
      uri: "resp.yaml",
      pointer: "",
      via: [],
    };
    const shallow: SpecRegion = {
      kind: "mounted",
      at: "/paths/~1a",
      uri: "path.yaml",
      pointer: "",
      via: [],
    };
    expect(sourceOf([entry, shallow, deep], "/paths/~1a/get/responses/200/description")?.uri).toBe(
      "resp.yaml",
    );
    expect(sourceOf([entry, deep, shallow], "/paths/~1a/get/responses/200/description")?.uri).toBe(
      "resp.yaml",
    );
  });

  it("shadows a sibling key onto the referring document", () => {
    // {...inlined, ...siblings}: the node came from path.yaml, the
    // `summary` key beside the $ref came from the entry document.
    const regions: SpecRegion[] = [
      entry,
      { kind: "mounted", at: "/paths/~1a", uri: "path.yaml", pointer: "", via: [] },
      {
        kind: "mounted",
        at: "/paths/~1a/summary",
        uri: "entry.yaml",
        pointer: "/paths/~1a/summary",
        via: [],
      },
    ];
    expect(sourceOf(regions, "/paths/~1a/get")?.uri).toBe("path.yaml");
    expect(sourceOf(regions, "/paths/~1a/summary")).toEqual({
      uri: "entry.yaml",
      pointer: "/paths/~1a/summary",
      via: [],
    });
  });

  it("carries via through to the address unchanged", () => {
    const via = [
      { uri: "entry.yaml", pointer: "/paths/~1a/get/requestBody/content/application~1json/schema" },
      { uri: "order.yaml", pointer: "/components/schemas/Order/properties/line" },
    ];
    const regions: SpecRegion[] = [
      entry,
      { kind: "mounted", at: "/components/schemas/Line", uri: "line.yaml", pointer: "", via },
    ];
    expect(sourceOf(regions, "/components/schemas/Line/type")?.via).toEqual(via);
  });

  it("has no address for a synthetic region or anything below it", () => {
    const regions: SpecRegion[] = [entry, { kind: "synthetic", at: "/components" }];
    expect(sourceOf(regions, "/components")).toBeUndefined();
    expect(sourceOf(regions, "/components/schemas")).toBeUndefined();
    expect(sourceOf(regions, "/info/title")?.uri).toBe("entry.yaml");
  });

  it("lets a mount inside a synthetic container answer for itself", () => {
    // The container the resolver invented has no source; what it holds does.
    const regions: SpecRegion[] = [
      entry,
      { kind: "synthetic", at: "/components" },
      {
        kind: "mounted",
        at: "/components/schemas/Order",
        uri: "order.yaml",
        pointer: "/Order",
        via: [],
      },
    ];
    expect(sourceOf(regions, "/components/schemas")).toBeUndefined();
    expect(sourceOf(regions, "/components/schemas/Order/type")?.pointer).toBe("/Order/type");
  });

  it("resolves equal-depth regions to the last one recorded", () => {
    const regions: SpecRegion[] = [
      entry,
      { kind: "mounted", at: "/info", uri: "a.yaml", pointer: "", via: [] },
      { kind: "synthetic", at: "/info" },
    ];
    expect(sourceOf(regions, "/info/title")).toBeUndefined();
  });

  it("has no address when nothing covers the pointer", () => {
    expect(sourceOf([], "/info")).toBeUndefined();
    expect(
      sourceOf([{ kind: "mounted", at: "/a", uri: "a.yaml", pointer: "", via: [] }], "/b"),
    ).toBeUndefined();
  });
});

describe("withSynthetic", () => {
  it("suppresses a mount underneath the marked pointer", () => {
    // An overlay rewriting /paths/~1a invalidates the region for the
    // response nested inside it, which longest-prefix alone would not.
    const regions: SpecRegion[] = [
      entry,
      { kind: "mounted", at: "/paths/~1a", uri: "path.yaml", pointer: "", via: [] },
      {
        kind: "mounted",
        at: "/paths/~1a/get/responses/200",
        uri: "resp.yaml",
        pointer: "",
        via: [],
      },
    ];
    const after = withSynthetic(regions, "/paths/~1a");
    expect(sourceOf(after, "/paths/~1a/get/responses/200/description")).toBeUndefined();
    expect(sourceOf(after, "/paths/~1a")).toBeUndefined();
    expect(sourceOf(after, "/info/title")?.uri).toBe("entry.yaml");
  });

  it("keeps regions outside the marked subtree, including equal-depth siblings", () => {
    const sibling: SpecRegion = {
      kind: "mounted",
      at: "/paths/~1ab",
      uri: "ab.yaml",
      pointer: "",
      via: [],
    };
    const after = withSynthetic([entry, sibling], "/paths/~1a");
    expect(sourceOf(after, "/paths/~1ab/get")?.uri).toBe("ab.yaml");
  });

  it("keeps an ancestor region, which still answers outside the hole", () => {
    const regions: SpecRegion[] = [
      entry,
      { kind: "mounted", at: "/paths/~1a", uri: "path.yaml", pointer: "", via: [] },
    ];
    const after = withSynthetic(regions, "/paths/~1a/get/summary");
    expect(sourceOf(after, "/paths/~1a/get/summary")).toBeUndefined();
    expect(sourceOf(after, "/paths/~1a/get/operationId")?.uri).toBe("path.yaml");
  });

  it("does not modify the input", () => {
    const regions: SpecRegion[] = [entry];
    const after = withSynthetic(regions, "/info");
    expect(regions).toHaveLength(1);
    expect(after).toHaveLength(2);
  });

  it("drops every descendant when given the root pointer", () => {
    const regions: SpecRegion[] = [
      entry,
      { kind: "mounted", at: "/components/schemas/X", uri: "x.yaml", pointer: "", via: [] },
    ];
    const after = withSynthetic(regions, "");
    expect(after).toEqual([entry, { kind: "synthetic", at: "" }]);
    expect(sourceOf(after, "/components/schemas/X/type")).toBeUndefined();
  });

  it("marks the whole document when given the root pointer", () => {
    // The entry region sits at the same depth rather than below, so it
    // survives the filter and loses on order instead.
    const after = withSynthetic([entry], "");
    expect(after.at(-1)).toEqual({ kind: "synthetic", at: "" });
    expect(sourceOf(after, "/info")).toBeUndefined();
    expect(sourceOf(after, "")).toBeUndefined();
  });
});

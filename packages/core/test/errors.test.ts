import { describe, expect, it, expectTypeOf } from "vitest";
import {
  BUILT_IN_ERROR_CODES,
  SELF_LOCATING_ERROR_CODES,
  collectLeaves,
  createBranchError,
  createError,
  createLeafError,
  joinPath,
  walkErrors,
  type BuiltInErrorParams,
  type CustomErrorParams,
  type ErrorParams,
  type ErrorParamsFor,
  type PathSegment,
  type ValidationError,
} from "../src/errors.js";

describe("createError", () => {
  it("fills in empty children and params by default", () => {
    const err = createError({ code: "type", path: [], message: "x" });
    expect(err.children).toEqual([]);
    expect(err.params).toEqual({});
  });

  it("preserves provided children and params", () => {
    const child = createLeafError("required", ["body"], "missing");
    const err = createError({
      code: "body",
      path: [],
      message: "bad body",
      params: { matchCount: 0 },
      children: [child],
    });
    expect(err.children).toHaveLength(1);
    expect(err.children[0]).toBe(child);
    expect(err.params).toEqual({ matchCount: 0 });
  });

  it("snapshots `path` so later caller-side mutation can't corrupt the error", () => {
    // Generated validators reuse one mutable path array across traversal
    // (push/pop per depth). Without a snapshot the error would silently
    // point at whatever path the validator landed on next.
    const livePath: (string | number)[] = ["body", "items", 0, "name"];
    const err = createError({ code: "type", path: livePath, message: "x" });
    livePath.push("mutation");
    livePath[3] = "zzz";
    expect(err.path).toEqual(["body", "items", 0, "name"]);
  });
});

describe("createLeafError", () => {
  it("always produces an empty children array", () => {
    const err = createLeafError("type", ["a", 0], "must be string");
    expect(err.children).toEqual([]);
    expect(err.code).toBe("type");
    expect(err.path).toEqual(["a", 0]);
  });
  it("appends extraSegment to the path when provided", () => {
    const err = createLeafError("required", ["user"], "missing", { missing: "id" }, "id");
    expect(err.path).toEqual(["user", "id"]);
  });
  it("appends extraSegment + extraSegment2 when both are provided", () => {
    // Used by the subschema inliner when a caller's pending segment
    // stacks with the leaf keyword's own trailing segment.
    const err = createLeafError("required", [], "missing", { missing: "id" }, "user", "id");
    expect(err.path).toEqual(["user", "id"]);
  });
});

describe("createBranchError", () => {
  it("carries the supplied children", () => {
    const leaves = [createLeafError("type", [], "x"), createLeafError("enum", [], "y")];
    const err = createBranchError("oneOf", [], "must match one", leaves, { matchCount: 0 });
    expect(err.children).toBe(leaves);
    expect(err.params).toEqual({ matchCount: 0 });
  });
  it("appends extraSegment + extraSegment2 when both are provided", () => {
    const children = [createLeafError("type", ["a", "b"], "x")];
    const err = createBranchError("schema", [], "wrap", children, {}, "a", "b");
    expect(err.path).toEqual(["a", "b"]);
  });
});

describe("walkErrors", () => {
  it("visits every node in pre-order with depth tracking", () => {
    const tree: ValidationError = createBranchError("body", [], "bad body", [
      createBranchError("oneOf", ["body"], "no match", [
        createLeafError("type", ["body", 0], "wrong type"),
        createLeafError("required", ["body", 1], "missing x"),
      ]),
    ]);
    const visited: Array<[string, number]> = [];
    walkErrors(tree, (node, depth) => {
      visited.push([node.code, depth]);
    });
    expect(visited).toEqual([
      ["body", 0],
      ["oneOf", 1],
      ["type", 2],
      ["required", 2],
    ]);
  });

  it("handles very deep trees (20 levels)", () => {
    let node = createLeafError("leaf", [], "leaf");
    for (let i = 0; i < 20; i += 1) {
      node = createBranchError(`level-${i}`, [], "branch", [node]);
    }
    let maxDepth = 0;
    walkErrors(node, (_n, d) => {
      if (d > maxDepth) maxDepth = d;
    });
    expect(maxDepth).toBe(20);
  });
});

describe("collectLeaves", () => {
  it("returns only nodes whose children array is empty", () => {
    const tree = createBranchError("root", [], "r", [
      createBranchError("oneOf", [], "o", [
        createLeafError("type", ["a"], "t1"),
        createLeafError("type", ["b"], "t2"),
      ]),
      createLeafError("required", [], "r1"),
    ]);
    const leaves = collectLeaves(tree).map((l) => l.code);
    expect(leaves).toEqual(["type", "type", "required"]);
  });

  it("returns the root itself when the tree is a single leaf", () => {
    const leaf = createLeafError("type", [], "x");
    expect(collectLeaves(leaf)).toEqual([leaf]);
  });
});

describe("BuiltInErrorParams", () => {
  it("narrows known params shapes via ErrorParamsFor", () => {
    expectTypeOf<ErrorParamsFor<"type">>().toEqualTypeOf<{
      expected: string[];
      actual: string;
    }>();
    expectTypeOf<ErrorParamsFor<"required">>().toEqualTypeOf<{ missing: string }>();
    expectTypeOf<ErrorParamsFor<"allOf">>().toEqualTypeOf<{ total: number; failed: number }>();
  });

  it("keyof BuiltInErrorParams is a finite union, not string", () => {
    // Without an index signature the union collapses to the actual
    // documented keys. A regression that re-adds `[code: string]: ...`
    // would widen this to `string` and the assertion would fail at
    // compile time.
    type Keys = keyof BuiltInErrorParams;
    expectTypeOf<"type">().toExtend<Keys>();
    expectTypeOf<"required">().toExtend<Keys>();
    expectTypeOf<"header-param">().toExtend<Keys>();
    expectTypeOf<string>().not.toExtend<Keys>();
    // The union can exclude an arbitrary made-up code.
    expectTypeOf<"not-a-real-code">().not.toExtend<Keys>();
  });

  it("ErrorParams narrows for built-in codes and widens for custom", () => {
    expectTypeOf<ErrorParams<"required">>().toEqualTypeOf<{ missing: string }>();
    expectTypeOf<ErrorParams<"type">>().toEqualTypeOf<{ expected: string[]; actual: string }>();
    // A custom / unknown code widens to CustomErrorParams.
    expectTypeOf<ErrorParams<"my-custom-code">>().toEqualTypeOf<CustomErrorParams>();
  });

  it("demonstrates the read-side narrowing pattern", () => {
    const err: ValidationError = createLeafError("required", ["body"], "missing", {
      missing: "name",
    });
    if (err.code === "required") {
      const p = err.params as ErrorParamsFor<"required">;
      expect(p.missing).toBe("name");
    }
  });
});

describe("SELF_LOCATING_ERROR_CODES", () => {
  it("is a subset of BUILT_IN_ERROR_CODES", () => {
    const documented = new Set<string>(BUILT_IN_ERROR_CODES);
    for (const code of SELF_LOCATING_ERROR_CODES) {
      expect(documented).toContain(code);
    }
  });

  it("excludes the branch-only and schema-keyword codes", () => {
    const set = new Set<string>(SELF_LOCATING_ERROR_CODES);
    // Branches never reach a leaf renderer.
    expect(set).not.toContain("request");
    expect(set).not.toContain("response");
    // Keyword leaves carry generic messages; the path is load-bearing.
    for (const code of ["type", "enum", "format", "required", "pattern"]) {
      expect(set).not.toContain(code);
    }
  });
});

describe("joinPath", () => {
  it("renders strings dotted and numbers bracketed", () => {
    expect(joinPath(["body", "users", 3, "email"])).toBe("body.users[3].email");
  });

  it("produces '' for an empty path", () => {
    expect(joinPath([])).toBe("");
  });

  it("treats a leading number as a bracket", () => {
    expect(joinPath([0, "x"])).toBe("[0].x");
  });
});

describe.each([
  {
    name: "createLeafError",
    create: (path: readonly PathSegment[], extra?: PathSegment, extra2?: PathSegment) =>
      createLeafError("type", path, "bad value", {}, extra, extra2),
  },
  {
    name: "createBranchError",
    create: (path: readonly PathSegment[], extra?: PathSegment, extra2?: PathSegment) =>
      createBranchError("schema", path, "bad value", [], {}, extra, extra2),
  },
])("$name path inputs", ({ create }) => {
  it.each<{ extras: PathSegment[] }>([{ extras: [] }, { extras: [0] }, { extras: [0, "name"] }])(
    "copies a frozen readonly path with trailing segments $extras",
    ({ extras }) => {
      const path = Object.freeze(["body", "items"] as const);
      const error = create(path, extras[0], extras[1]);
      expect(error.path).toEqual([...path, ...extras]);
      expect(error.path).not.toBe(path);
      expect(path).toEqual(["body", "items"]);
    },
  );

  it.each<{ extras: PathSegment[] }>([{ extras: [] }, { extras: [0] }, { extras: [0, "name"] }])(
    "snapshots a mutable path with trailing segments $extras",
    ({ extras }) => {
      const path: PathSegment[] = ["body", "items"];
      const error = create(path, extras[0], extras[1]);
      path[0] = "response";
      path.push("later");
      expect(error.path).toEqual(["body", "items", ...extras]);
      expect(error.path).not.toBe(path);
    },
  );
});

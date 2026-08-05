/* eslint-disable unicorn/no-thenable -- `then` is a JSON Schema keyword here */
import { describe, expect, it } from "vitest";
import { compile } from "./helpers.js";
import { openapi31Dialect } from "../src/keywords/vocabulary.js";

/**
 * Runtime dynamic-scope resolution for `$dynamicRef`.
 *
 * These cases are transcribed from the JSON Schema Test Suite
 * (`tests/draft2020-12/dynamicRef.json`). They live here as well as in
 * the conformance run because they pin the two model questions the
 * implementation turns on, and a unit test says which model is wrong
 * where a suite tally only says the count moved.
 */
describe("$dynamicRef dynamic scope", () => {
  /**
   * The arbitrating case: is a `$dynamicAnchor` in scope because the
   * enclosing schema resource was entered, or because the anchor's own
   * subschema was evaluated?
   *
   * The chain is `base -> first#/$defs/stuff -> second#/$defs/stuff ->
   * third#/$defs/stuff -> $dynamicRef "#length"`. Nothing ever evaluates
   * `second`'s root schema or its `$defs/length`; the reference still
   * has to bind there, because passing through a node whose base URI is
   * `second` puts the whole resource's anchors in scope. Binding to
   * `third` (maxLength 3) is what a lexical reading produces, and it
   * shows up as `"hey"` coming back valid.
   */
  it("registers a resource's anchors on entry, not on evaluation", () => {
    const v = compile({
      $id: "https://test.json-schema.org/dynamic-ref-avoids-root-of-each-schema/base",
      $ref: "first#/$defs/stuff",
      $defs: {
        first: {
          $id: "first",
          $defs: {
            stuff: { $ref: "second#/$defs/stuff" },
            length: { maxLength: 1 },
          },
        },
        second: {
          $id: "second",
          $defs: {
            stuff: { $ref: "third#/$defs/stuff" },
            length: { $dynamicAnchor: "length", maxLength: 2 },
          },
        },
        third: {
          $id: "third",
          $defs: {
            stuff: { $dynamicRef: "#length" },
            length: { $dynamicAnchor: "length", maxLength: 3 },
          },
        },
      },
    });
    expect(v.validate("hi").valid).toBe(true);
    // Binds to second (maxLength 2). Under a lexical reading it binds to
    // third (maxLength 3) and this comes back valid.
    expect(v.validate("hey").valid).toBe(false);
  });

  /**
   * The scope has to unwind as accurately as it extends. `first_scope`
   * is entered by `if` and left again before `then` runs, so its
   * `thingy` is out of scope by the time the `$dynamicRef` resolves.
   * These three fail in opposite directions today, which is why a design
   * that resolves uniformly deeper or uniformly shallower cannot pass
   * them together.
   */
  describe("after leaving a dynamic scope, it is not used by a $dynamicRef", () => {
    const schema = {
      $id: "https://test.json-schema.org/dynamic-ref-leaving-dynamic-scope/main",
      if: {
        $id: "first_scope",
        $defs: {
          thingy: { $dynamicAnchor: "thingy", type: "number" },
        },
      },
      then: {
        $id: "second_scope",
        $ref: "start",
        $defs: {
          thingy: { $dynamicAnchor: "thingy", type: "null" },
        },
      },
      $defs: {
        start: { $id: "start", $dynamicRef: "inner_scope#thingy" },
        thingy: { $id: "inner_scope", $dynamicAnchor: "thingy", type: "string" },
      },
    };

    it("does not stop at /$defs/thingy", () => {
      expect(compile(schema).validate("a string").valid).toBe(false);
    });

    it("does not use first_scope, which has been left", () => {
      expect(compile(schema).validate(42).valid).toBe(false);
    });

    it("stops at /then/$defs/thingy", () => {
      expect(compile(schema).validate(null).valid).toBe(true);
    });
  });

  /**
   * Intermediate resources that declare no matching anchor are passed
   * through without affecting the binding. `intermediate-scope` is also
   * a pure-`$ref` schema that declares an `$id`, the shape that the
   * pure-ref elision at `compiler.ts` removes from the call graph.
   */
  it("passes through intermediate scopes that declare no matching anchor", () => {
    const schema = {
      $id: "https://test.json-schema.org/dynamic-resolution-with-intermediate-scopes/root",
      $ref: "intermediate-scope",
      $defs: {
        foo: { $dynamicAnchor: "items", type: "string" },
        "intermediate-scope": { $id: "intermediate-scope", $ref: "list" },
        list: {
          $id: "list",
          type: "array",
          items: { $dynamicRef: "#items" },
          $defs: {
            items: { $dynamicAnchor: "items" },
          },
        },
      },
    };
    expect(compile(schema).validate(["foo", "bar"]).valid).toBe(true);
    expect(compile(schema).validate(["foo", 42]).valid).toBe(false);
  });

  /**
   * Existing behaviour, and it stays. A `$dynamicRef` whose target is
   * not bookended by a matching `$dynamicAnchor` in the dynamic scope
   * resolves the way `$ref` does.
   */
  it("falls back to $ref semantics with no matching anchor in scope", () => {
    const v = compile({
      $defs: { Thing: { $dynamicAnchor: "T", type: "string" } },
      $dynamicRef: "#T",
    });
    expect(v.validate("ok").valid).toBe(true);
    expect(v.validate(1).valid).toBe(false);
  });

  it("resolves statically when the target carries only a plain $anchor", () => {
    const v = compile({
      $id: "https://example.test/plain-anchor",
      $dynamicAnchor: "thing",
      $defs: { thing: { $anchor: "thing", type: "string" } },
      properties: { a: { $dynamicRef: "#thing" } },
    });
    // Bookending fails: `#thing` resolves to the plain `$anchor`, which
    // declares no `$dynamicAnchor`, so the reference stays put.
    expect(v.validate({ a: "ok" }).valid).toBe(true);
    expect(v.validate({ a: 1 }).valid).toBe(false);
  });
});

describe("$dynamicRef scope hygiene", () => {
  /**
   * The scope is mutable state in the generated closure, so a throw
   * part-way through a validation leaves it pushed. `validate()` resets
   * it on entry, the same way it resets the recursion counter, so the
   * damage cannot reach the next call.
   */
  it("recovers the scope after a keyword throws mid-validation", () => {
    let shouldThrow = true;
    // `crash` descends into the `second` resource, which declares
    // `meta`, and throws while it is on the scope. `probe` sits in the
    // root resource, which declares no `meta`, so its `$dynamicRef`
    // must fall back to its static target (`third`, a string). If the
    // throw left `second` pushed, the next call binds `meta` to it
    // instead and rejects the string.
    const v = compile(
      {
        $id: "https://example.test/throwing/root",
        properties: {
          crash: { $ref: "second" },
          probe: { $dynamicRef: "third#meta" },
        },
        $defs: {
          second: {
            $id: "second",
            $dynamicAnchor: "meta",
            type: "object",
            properties: { boom: { type: "string", format: "explosive" } },
          },
          third: {
            $id: "third",
            $dynamicAnchor: "meta",
            type: "string",
          },
        },
      },
      {
        // `format` asserts under the OpenAPI 3.1 dialect, which is what
        // gives this test a keyword that can throw at validation time.
        dialect: openapi31Dialect,
        formats: {
          explosive: () => {
            if (shouldThrow) throw new Error("boom");
            return true;
          },
        },
      },
    );

    // Sanity: with no crash, `probe` binds to the string target.
    shouldThrow = false;
    expect(v.validate({ probe: "a string" }).valid).toBe(true);

    shouldThrow = true;
    expect(() => v.validate({ crash: { boom: "x" } })).toThrow("boom");

    shouldThrow = false;
    expect(v.validate({ probe: "a string" }).valid).toBe(true);
  });

  it("compiles a boolean root alongside an external that uses dynamic scoping", () => {
    const external = new Map<string, unknown>([
      [
        "https://example.test/ext",
        {
          $id: "https://example.test/ext",
          $dynamicAnchor: "meta",
          properties: { next: { $dynamicRef: "#meta" } },
        },
      ],
    ]);
    const v = compile(true, { external: external as never });
    expect(v.validate({ anything: 1 }).valid).toBe(true);
  });

  /**
   * The candidate set is bounded to resources this compile unit can
   * reach, and reaching them means resolving each document's references
   * against that document's own base URI. Here `a` refers to `b`
   * relatively, so a walk that resolved against the root base instead
   * would never find `b`, drop it from the candidate set, and let the
   * `$dynamicRef` bind to `c` (a number) rather than `b` (a string).
   */
  it("reaches a resource referenced relatively from an external schema", () => {
    const external = new Map<string, unknown>([
      ["https://example.test/a", { $id: "https://example.test/a", $ref: "b" }],
      [
        "https://example.test/b",
        {
          $id: "https://example.test/b",
          $ref: "c",
          $defs: { m: { $dynamicAnchor: "meta", type: "string" } },
        },
      ],
      [
        "https://example.test/c",
        {
          $id: "https://example.test/c",
          type: "object",
          properties: { probe: { $dynamicRef: "#meta" } },
          $defs: { m: { $dynamicAnchor: "meta", type: "number" } },
        },
      ],
    ]);
    const v = compile(
      { $id: "https://example.test/root", $ref: "https://example.test/a" },
      { external: external as never },
    );
    // Scope at the $dynamicRef is [root, a, b, c]; `b` is the outermost
    // resource declaring `meta`, and it constrains to a string.
    expect(v.validate({ probe: "hi" }).valid).toBe(true);
    expect(v.validate({ probe: 42 }).valid).toBe(false);
  });

  it("does not mistake an inherited object property for a binding", () => {
    // The candidate table is keyed by base URI, and base URIs come from
    // user `$id` values. Held in a plain object, a lookup for a base URI
    // the table has no entry for still finds an inherited name:
    // `table["toString"]` is a function, so the scope walk would take it
    // for a validator and call it. The base URI has to be one the table
    // does *not* carry, or its own entry shadows the inherited one.
    const v = compile({
      $id: "toString",
      properties: { probe: { $dynamicRef: "third#meta" } },
      $defs: {
        third: { $id: "third", $dynamicAnchor: "meta", type: "string" },
      },
    });
    // No `meta` in scope, so this falls back to its static target.
    expect(v.validate({ probe: "a string" }).valid).toBe(true);
    expect(v.validate({ probe: 42 }).valid).toBe(false);
  });
});

/**
 * The perf gate. A compile unit that does not use both keywords must
 * emit what it emitted before dynamic scoping existed, so the cost is
 * confined to the schemas that ask for it.
 *
 * These assert on the emitted source rather than on timings. The full
 * demonstration is a byte-for-byte diff of a corpus compiled by two
 * checkouts; this pins the property in the repo so a later change
 * cannot quietly start threading a scope through every schema.
 */
describe("$dynamicRef zero cost when unused", () => {
  const DYNAMIC_TOKENS = ["dynScope", "dynLookup", "enter_", "DYN_"];

  const expectNoDynamicCode = (schema: Record<string, unknown>) => {
    for (const output of ["flat", "tree", "predicate"] as const) {
      const { source } = compile(schema, { output });
      for (const token of DYNAMIC_TOKENS) {
        expect(source, `${output} mode emitted ${token}`).not.toContain(token);
      }
    }
  };

  it("emits nothing for a schema with neither keyword", () => {
    expectNoDynamicCode({
      $id: "https://example.test/plain",
      type: "object",
      properties: { a: { $ref: "#/$defs/leaf" } },
      $defs: { leaf: { type: "string" } },
    });
  });

  it("emits nothing for a $dynamicAnchor that nothing references", () => {
    expectNoDynamicCode({
      $id: "https://example.test/anchor-only",
      $dynamicAnchor: "meta",
      type: "object",
      properties: { a: { type: "string" } },
    });
  });

  it("emits nothing for a $dynamicRef with no anchor to rebind to", () => {
    expectNoDynamicCode({
      $id: "https://example.test/ref-only",
      $defs: { thing: { $anchor: "thing", type: "string" } },
      properties: { a: { $dynamicRef: "#thing" } },
    });
  });

  it("emits nothing when a resource crosses a boundary without dynamic keywords", () => {
    expectNoDynamicCode({
      $id: "https://example.test/root",
      $ref: "inner",
      $defs: {
        inner: {
          $id: "inner",
          type: "object",
          properties: { deeper: { $ref: "#/$defs/leaf" } },
          $defs: { leaf: { type: "string" } },
        },
      },
    });
  });
});

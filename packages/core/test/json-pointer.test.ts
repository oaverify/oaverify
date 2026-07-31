import { describe, expect, it } from "vitest";
import {
  escapePointerSegment,
  pointerFromFragment,
  pointerFromRefFragment,
  resolveJsonPointer,
} from "../src/json-pointer.js";

describe("resolveJsonPointer", () => {
  const doc = {
    a: { b: "value" },
    "slashed/key": "x",
    "tilde~y": "y",
    "50%": "percent",
    paths: { "/v2/apps/{app_id}": { get: { parameters: [{ name: "id" }] } } },
    list: ["zero", "one", "two"],
  };

  it("returns root for the empty pointer, and only for it", () => {
    expect(resolveJsonPointer(doc, "")).toBe(doc);
  });

  it("treats `/` as the member keyed by the empty string, not the root", () => {
    // RFC 6901 §3: a pointer is a sequence of `/` followed by a
    // reference token, so `/` is one token whose value is `""`. An
    // empty-string key is rare and legal, and reading `/` as the root
    // resolves a present pointer to the wrong node.
    const withEmptyKey = { "": "empty-key", a: 1 };
    expect(resolveJsonPointer(withEmptyKey, "/")).toBe("empty-key");
    expect(resolveJsonPointer(withEmptyKey, "")).toBe(withEmptyKey);
    // And through the ref-fragment path, where `#/` is a legal ref.
    expect(resolveJsonPointer(withEmptyKey, pointerFromRefFragment("#/") as string)).toBe(
      "empty-key",
    );
  });

  it("walks property chains", () => {
    expect(resolveJsonPointer(doc, "/a/b")).toBe("value");
  });

  it("decodes ~1 to '/' and ~0 to '~' (RFC 6901 §4)", () => {
    expect(resolveJsonPointer(doc, "/slashed~1key")).toBe("x");
    expect(resolveJsonPointer(doc, "/tilde~0y")).toBe("y");
  });

  it("resolves a `$ref` fragment once it has been converted to a pointer", () => {
    // The realistic shape: a `$ref` whose path template is percent-
    // encoded. Conversion is the caller's step, because this function
    // takes a pointer; see the pointerFromFragment block below.
    const fragment = "/paths/~1v2~1apps~1%7Bapp_id%7D/get/parameters/0";
    expect(resolveJsonPointer(doc, pointerFromFragment(fragment))).toEqual({ name: "id" });
    // Handed the fragment directly it addresses a key that is not there,
    // which is the point of keeping the two operations apart.
    expect(() => resolveJsonPointer(doc, fragment)).toThrow(/not found/);
  });

  it("preserves stray `%` that isn't a valid %XX escape", () => {
    expect(resolveJsonPointer(doc, "/50%")).toBe("percent");
  });

  it("indexes arrays by integer position", () => {
    expect(resolveJsonPointer(doc, "/list/1")).toBe("one");
  });

  it("throws when the path walks into a primitive", () => {
    expect(() => resolveJsonPointer(doc, "/a/b/c")).toThrow(/traverses a primitive/);
  });

  it("throws when the target is missing", () => {
    expect(() => resolveJsonPointer(doc, "/a/missing")).toThrow(/not found/);
  });

  it("rejects non-empty pointers that don't start with `/`", () => {
    expect(() => resolveJsonPointer(doc, "a/b")).toThrow(/invalid JSON pointer/);
  });
});

describe("resolveJsonPointer takes a pointer, not a URI fragment", () => {
  // The two are different strings with different meanings, and this
  // function evaluates only the first. A caller holding a `$ref` has a
  // fragment and converts with pointerFromFragment before arriving.
  const doc = {
    "a%2Fb": "literal percent-two-eff",
    "caf%C3%A9": "literal escape text",
    café: "accented",
    "50%": "percent",
    a: { b: "nested" },
  };

  it("treats %2F as ordinary characters in a key, not a separator", () => {
    expect(resolveJsonPointer(doc, "/a%2Fb")).toBe("literal percent-two-eff");
    // The separator spelling for a `/` inside a key is `~1`.
    expect(resolveJsonPointer({ "a/b": "escaped" }, "/a~1b")).toBe("escaped");
  });

  it("does not decode a multi-byte escape, which would address a different key", () => {
    expect(resolveJsonPointer(doc, "/caf%C3%A9")).toBe("literal escape text");
    expect(resolveJsonPointer(doc, "/café")).toBe("accented");
  });

  it("passes a stray `%` through untouched", () => {
    expect(resolveJsonPointer(doc, "/50%")).toBe("percent");
  });
});

describe("pointerFromFragment", () => {
  // The decode that resolveJsonPointer no longer does, at the boundary
  // where the input really is a URI fragment.
  it("decodes a multi-byte sequence as one character", () => {
    // Decoding each `%XX` alone throws URIError on the first half of a
    // UTF-8 pair, so this is what proves the whole string decodes.
    expect(pointerFromFragment("/caf%C3%A9")).toBe("/café");
  });

  it("decodes before the pointer is split, so %2F becomes a separator", () => {
    // RFC 6901 §6 then §4: percent-decode the fragment, then interpret
    // the result as a pointer. A `/` inside a key is `~1` at the
    // pointer level, before any percent-encoding, so `%2F` cannot mean
    // one. Round-tripping shows the effect.
    expect(pointerFromFragment("/a%2Fb")).toBe("/a/b");
    expect(resolveJsonPointer({ a: { b: "nested" } }, pointerFromFragment("/a%2Fb"))).toBe(
      "nested",
    );
  });

  it("preserves a stray `%` rather than refusing the whole fragment", () => {
    expect(pointerFromFragment("/50%")).toBe("/50%");
    expect(pointerFromFragment("/100%25")).toBe("/100%");
  });
});

describe("escapePointerSegment", () => {
  it("escapes `~` before `/`, so a token holding both round-trips", () => {
    expect(escapePointerSegment("a/b~c")).toBe("a~1b~0c");
    // `~0` must not be produced by escaping the `/`, which is what a
    // wrong order would do.
    expect(escapePointerSegment("~1")).toBe("~01");
  });

  it("leaves an ordinary token alone", () => {
    expect(escapePointerSegment("application/json")).toBe("application~1json");
    expect(escapePointerSegment("plain")).toBe("plain");
  });

  it("round-trips through resolveJsonPointer", () => {
    const doc = { "a/b~c": "found" };
    expect(resolveJsonPointer(doc, `/${escapePointerSegment("a/b~c")}`)).toBe("found");
  });
});

describe("pointerFromRefFragment", () => {
  it("turns a local ref into the pointer it names", () => {
    expect(pointerFromRefFragment("#/components/schemas/Pet")).toBe("/components/schemas/Pet");
  });

  it("keeps ~0 / ~1 escapes, which are pointer syntax rather than encoding", () => {
    expect(pointerFromRefFragment("#/paths/~1pets/get")).toBe("/paths/~1pets/get");
  });

  it("percent-decodes, including multi-byte", () => {
    expect(pointerFromRefFragment("#/components/My%20Schema")).toBe("/components/My Schema");
    expect(pointerFromRefFragment("#/components/caf%C3%A9")).toBe("/components/café");
  });

  it("declines anything that names no position in this document", () => {
    // An anchor names a schema; an external URI names another document.
    // Absence is the contract, not a best-effort address.
    expect(pointerFromRefFragment("#some-anchor")).toBeUndefined();
    expect(pointerFromRefFragment("https://example.com/other.json#/A")).toBeUndefined();
    expect(pointerFromRefFragment("other.json")).toBeUndefined();
    // The whole-document ref, which is a legal pointer but not a
    // position this library reports against.
    expect(pointerFromRefFragment("#")).toBeUndefined();
  });
});

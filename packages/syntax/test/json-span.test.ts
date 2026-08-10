import { describe, expect, it } from "vitest";
import {
  createSourceSpanResolver,
  STDIN_URI,
  type SourceSpan,
  type SourceText,
} from "@oaverify/internal-spec";
import { createYamlSpanBackend } from "../src/span.js";
import { createJsonSpanBackend } from "../src/json-span.js";

/**
 * The JSON backend against the same table the YAML one answers, since
 * the two are behind one interface and a difference between them is a
 * defect rather than a property of the format.
 */

const backend = createJsonSpanBackend();

function spanIn(
  text: string,
  pointer: string,
  options: { want?: "value" | "key"; uri?: string; syntax?: SourceText["syntax"] } = {},
): SourceSpan | undefined {
  const uri = options.uri ?? "doc.json";
  const resolver = createSourceSpanResolver({
    texts: { textFor: (asked) => (asked === uri ? { text, syntax: options.syntax } : undefined) },
    backends: [backend],
  });
  return resolver.spanFor({ uri, pointer, want: options.want });
}

function sliceOf(text: string, span: SourceSpan | undefined): string | undefined {
  return span === undefined ? undefined : text.slice(span.start.offset, span.end.offset);
}

const SPEC = `{
  "openapi": "3.1.0",
  "info": { "title": "Widgets", "version": "1" },
  "paths": {
    "/orders/{id}": {
      "get": { "responses": { "200": { "description": "ok" } } }
    }
  },
  "components": {
    "schemas": {
      "Order": {
        "type": "object",
        "required": ["id", "nope"]
      }
    }
  }
}`;

describe("node kinds", () => {
  it("addresses a scalar value, including its quotes", () => {
    const span = spanIn(SPEC, "/info/title");
    expect(sliceOf(SPEC, span)).toBe('"Widgets"');
    expect(span?.start.line).toBe(3);
  });

  it("addresses an object value as the whole subtree, braces included", () => {
    const span = spanIn(SPEC, "/components/schemas/Order");
    expect(sliceOf(SPEC, span)).toBe(
      '{\n        "type": "object",\n        "required": ["id", "nope"]\n      }',
    );
  });

  it("addresses an array element", () => {
    expect(sliceOf(SPEC, spanIn(SPEC, "/components/schemas/Order/required/1"))).toBe('"nope"');
    expect(sliceOf(SPEC, spanIn(SPEC, "/components/schemas/Order/required/0"))).toBe('"id"');
  });

  it("addresses an array as a whole", () => {
    expect(sliceOf(SPEC, spanIn(SPEC, "/components/schemas/Order/required"))).toBe(
      '["id", "nope"]',
    );
  });

  it("addresses a property key", () => {
    const key = spanIn(SPEC, "/components/schemas/Order", { want: "key" });
    expect(sliceOf(SPEC, key)).toBe('"Order"');
    expect(key?.start.line).toBe(11);
  });

  it("addresses the whole document at the root pointer", () => {
    const span = spanIn(SPEC, "");
    expect(span?.start.offset).toBe(0);
    expect(span?.end.offset).toBe(SPEC.length);
  });

  it("has no key for an array element, and none for the root", () => {
    expect(spanIn(SPEC, "/components/schemas/Order/required/1", { want: "key" })).toBeUndefined();
    expect(spanIn(SPEC, "", { want: "key" })).toBeUndefined();
  });

  it("returns undefined for pointers that do not resolve", () => {
    expect(spanIn(SPEC, "/components/schemas/Missing")).toBeUndefined();
    expect(spanIn(SPEC, "/info/title/deeper")).toBeUndefined();
    expect(spanIn(SPEC, "/components/schemas/Order/required/2")).toBeUndefined();
  });
});

describe("key shapes", () => {
  it("resolves a path template, whose key contains the pointer separator", () => {
    expect(sliceOf(SPEC, spanIn(SPEC, "/paths/~1orders~1{id}/get/responses/200/description"))).toBe(
      '"ok"',
    );
    expect(sliceOf(SPEC, spanIn(SPEC, "/paths/~1orders~1{id}", { want: "key" }))).toBe(
      '"/orders/{id}"',
    );
  });

  const awkward = `{ "x": { "a~b": "tilde", "a%20b": "percent", "a b": "space", "": "empty", "1": "one" } }`;

  it("resolves tilde, percent, space, empty and numeric-looking keys", () => {
    expect(sliceOf(awkward, spanIn(awkward, "/x/a~0b"))).toBe('"tilde"');
    expect(sliceOf(awkward, spanIn(awkward, "/x/a%20b"))).toBe('"percent"');
    expect(sliceOf(awkward, spanIn(awkward, "/x/a b"))).toBe('"space"');
    expect(sliceOf(awkward, spanIn(awkward, "/x/"))).toBe('"empty"');
    expect(sliceOf(awkward, spanIn(awkward, "/x/1"))).toBe('"one"');
  });

  it("resolves a key whose text is escaped in the source", () => {
    // `/` is a solidus, so the member's name is `a/b` and its
    // pointer segment is `a~1b`. The span still covers the source
    // spelling, escape and all.
    const text = String.raw`{ "a/b": 1, "q\"uote": 2 }`;
    expect(sliceOf(text, spanIn(text, "/a~1b"))).toBe("1");
    expect(sliceOf(text, spanIn(text, "/a~1b", { want: "key" }))).toBe(String.raw`"a/b"`);
    expect(sliceOf(text, spanIn(text, '/q"uote'))).toBe("2");
  });

  it("resolves a duplicate key to the last member, as JSON.parse would", () => {
    const text = `{ "a": 1, "a": 2 }`;
    expect(JSON.parse(text)).toEqual({ a: 2 });
    expect(sliceOf(text, spanIn(text, "/a"))).toBe("2");
  });
});

describe("text quirks", () => {
  it("counts CRLF line endings as one line each", () => {
    const text = SPEC.replaceAll("\n", "\r\n");
    const span = spanIn(text, "/info/title");
    expect(sliceOf(text, span)).toBe('"Widgets"');
    expect(span?.start.line).toBe(3);
  });

  it("handles a document with no trailing newline, and one with several", () => {
    expect(sliceOf(SPEC, spanIn(SPEC, "/openapi"))).toBe('"3.1.0"');
    const padded = `${SPEC}\n\n`;
    expect(sliceOf(padded, spanIn(padded, "/openapi"))).toBe('"3.1.0"');
  });

  it("counts columns in UTF-16 code units, not code points", () => {
    const text = '{ "x": "\u{1F600}", "b": "hi" }';
    const span = spanIn(text, "/b");
    expect(sliceOf(text, span)).toBe('"hi"');
    expect(span?.start.offset).toBe(text.indexOf('"hi"'));
    expect(span?.start.column).toBe(text.indexOf('"hi"') + 1);
    // A code-point count would be one lower: the emoji is two units.
    expect(Array.from(text.slice(0, span?.start.offset ?? 0))).toHaveLength(
      (span?.start.column ?? 0) - 2,
    );
  });

  it("answers relative to the text it was given, BOM included", () => {
    // A BOM is not JSON, so the offsets stay offsets into the text as
    // supplied rather than into some stripped copy of it. A caller that
    // strips the BOM before checking must strip it here too.
    const text = `﻿${SPEC}`;
    const span = spanIn(text, "/info/title");
    expect(sliceOf(text, span)).toBe('"Widgets"');
    expect(span?.start.line).toBe(3);
  });
});

describe("degenerate documents", () => {
  it("returns undefined for an empty document", () => {
    expect(spanIn("", "")).toBeUndefined();
    expect(spanIn("", "/info")).toBeUndefined();
  });

  it("addresses a document whose root is not an object", () => {
    expect(sliceOf("[1, 2]", spanIn("[1, 2]", "/1"))).toBe("2");
    expect(sliceOf('"bare"', spanIn('"bare"', ""))).toBe('"bare"');
    expect(spanIn('"bare"', "/info")).toBeUndefined();
  });

  it("answers from what a truncated document parsed, and does not throw", () => {
    const text = '{ "a": { "b": 1 }, "c": ';
    expect(sliceOf(text, spanIn(text, "/a/b"))).toBe("1");
    expect(spanIn(text, "/c")).toBeUndefined();
  });

  it("addresses null, booleans and numbers", () => {
    const text = '{ "n": null, "t": true, "f": 1.5e3 }';
    expect(sliceOf(text, spanIn(text, "/n"))).toBe("null");
    expect(sliceOf(text, spanIn(text, "/t"))).toBe("true");
    expect(sliceOf(text, spanIn(text, "/f"))).toBe("1.5e3");
  });

  it("addresses nested arrays by index", () => {
    const text = '{ "a": [[10, 20], [30, 40]] }';
    expect(sliceOf(text, spanIn(text, "/a/1/0"))).toBe("30");
    expect(sliceOf(text, spanIn(text, "/a/1"))).toBe("[30, 40]");
  });
});

describe("backend selection", () => {
  const jsonText = '{ "a": 1 }';
  const yamlText = "a: 1\n";

  it("claims a .json uri and declines a .yaml one", () => {
    expect(backend.claims({ uri: "a.json", text: jsonText })).toBe(true);
    expect(backend.claims({ uri: "a.yaml", text: yamlText })).toBe(false);
  });

  it("obeys a declared syntax over the uri, in both directions", () => {
    expect(backend.claims({ uri: "a.yaml", text: jsonText, syntax: "json" })).toBe(true);
    expect(backend.claims({ uri: "a.json", text: jsonText, syntax: "yaml" })).toBe(false);
  });

  it("sniffs a uri that says nothing, and leaves YAML-shaped text alone", () => {
    expect(backend.claims({ uri: STDIN_URI, text: jsonText })).toBe(true);
    expect(backend.claims({ uri: STDIN_URI, text: yamlText })).toBe(false);
  });

  it("splits stdin with the YAML backend, whichever order they are wired in", () => {
    for (const backends of [
      [createYamlSpanBackend(), backend],
      [backend, createYamlSpanBackend()],
    ]) {
      const resolve = (text: string) =>
        createSourceSpanResolver({ texts: { textFor: () => ({ text }) }, backends }).spanFor({
          uri: STDIN_URI,
          pointer: "/a",
        });

      expect(sliceOf(jsonText, resolve(jsonText))).toBe("1");
      expect(sliceOf(yamlText, resolve(yamlText))).toBe("1");
    }
  });
});

describe("the two backends answer the same question the same way", () => {
  // The same document in both syntaxes, laid out so the addressed nodes
  // sit on the same lines. A divergence here is a defect in one of the
  // backends rather than a property of the format.
  const json = `{
  "info": { "title": "Widgets" },
  "paths": { "/orders/{id}": { "get": { "tags": ["a", "b"] } } }
}`;
  const yaml = `info: { title: Widgets }
paths: { "/orders/{id}": { get: { tags: [a, b] } } }
`;

  const cases = [
    { pointer: "/info/title", want: "value" as const, json: '"Widgets"', yaml: "Widgets" },
    { pointer: "/info", want: "key" as const, json: '"info"', yaml: "info" },
    {
      pointer: "/paths/~1orders~1{id}",
      want: "key" as const,
      json: '"/orders/{id}"',
      yaml: '"/orders/{id}"',
    },
    { pointer: "/paths/~1orders~1{id}/get/tags/1", want: "value" as const, json: '"b"', yaml: "b" },
  ];

  it.each(cases)("resolves $pointer ($want) in both", ({ pointer, want, ...expected }) => {
    const jsonSpan = spanIn(json, pointer, { want });
    const yamlSpan = createSourceSpanResolver({
      texts: { textFor: () => ({ text: yaml, syntax: "yaml" as const }) },
      backends: [createYamlSpanBackend()],
    }).spanFor({ uri: "doc.yaml", pointer, want });

    expect(sliceOf(json, jsonSpan)).toBe(expected.json);
    expect(sliceOf(yaml, yamlSpan)).toBe(expected.yaml);
    // Same line in both, because the fixtures put the node there.
    expect(jsonSpan?.start.line).toBe((yamlSpan?.start.line ?? 0) + 1);
  });

  it("agrees on the absences", () => {
    const yamlResolver = createSourceSpanResolver({
      texts: { textFor: () => ({ text: yaml, syntax: "yaml" as const }) },
      backends: [createYamlSpanBackend()],
    });
    for (const pointer of ["/nope", "/info/title/deeper", "/paths/~1orders~1{id}/get/tags/9"]) {
      expect(spanIn(json, pointer)).toBeUndefined();
      expect(yamlResolver.spanFor({ uri: "doc.yaml", pointer })).toBeUndefined();
    }
    // And on the one shape neither can answer.
    expect(spanIn(json, "/paths/~1orders~1{id}/get/tags/1", { want: "key" })).toBeUndefined();
    expect(
      yamlResolver.spanFor({
        uri: "doc.yaml",
        pointer: "/paths/~1orders~1{id}/get/tags/1",
        want: "key",
      }),
    ).toBeUndefined();
  });
});

describe("the root pointer and the empty key are different addresses", () => {
  // `""` names the document and `"/"` names the member whose key is the
  // empty string. A path encoding that joined segments rather than
  // prefixing them would give both the same key and answer one with the
  // other's span.
  const text = `{ "": "empty-key" }`;

  it("keeps them apart", () => {
    expect(sliceOf(text, spanIn(text, ""))).toBe(text);
    expect(sliceOf(text, spanIn(text, "/"))).toBe('"empty-key"');
    expect(sliceOf(text, spanIn(text, "/", { want: "key" }))).toBe('""');
  });

  it("keeps them apart when both are asked for at once", () => {
    const resolver = createSourceSpanResolver({
      texts: { textFor: () => ({ text, syntax: "json" as const }) },
      backends: [backend],
    });
    const [root, member] = resolver.spansFor([
      { uri: "doc.json", pointer: "" },
      { uri: "doc.json", pointer: "/" },
    ]);
    expect(sliceOf(text, root)).toBe(text);
    expect(sliceOf(text, member)).toBe('"empty-key"');
  });
});

describe("a duplicate key takes its descendants with it", () => {
  // `JSON.parse` keeps the last member, so the earlier one's subtree is
  // not in the checked document and must not be addressable. A
  // streaming walk sees the earlier subtree first, so recording as it
  // goes is not enough on its own.
  it("drops a descendant of an overwritten object", () => {
    const text = `{ "a": { "b": 1 }, "a": 2 }`;
    expect(JSON.parse(text)).toEqual({ a: 2 });
    expect(sliceOf(text, spanIn(text, "/a"))).toBe("2");
    expect(spanIn(text, "/a/b")).toBeUndefined();
  });

  it("keeps the later duplicate's own descendants", () => {
    const text = `{ "a": { "b": 1 }, "a": { "b": 2, "c": 3 } }`;
    expect(JSON.parse(text)).toEqual({ a: { b: 2, c: 3 } });
    expect(sliceOf(text, spanIn(text, "/a/b"))).toBe("2");
    expect(sliceOf(text, spanIn(text, "/a/c"))).toBe("3");
  });

  it("drops a descendant when the winner is an array of different shape", () => {
    const text = `{ "a": { "b": 1 }, "a": [7] }`;
    expect(JSON.parse(text)).toEqual({ a: [7] });
    expect(sliceOf(text, spanIn(text, "/a/0"))).toBe("7");
    expect(spanIn(text, "/a/b")).toBeUndefined();
  });

  it("drops a deep descendant, not only an immediate one", () => {
    const text = `{ "a": { "b": { "c": 1 } }, "a": 2 }`;
    expect(spanIn(text, "/a/b/c")).toBeUndefined();
    expect(spanIn(text, "/a/b", { want: "key" })).toBeUndefined();
  });
});

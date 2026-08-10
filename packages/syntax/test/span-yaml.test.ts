import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  composeReaders,
  createFileReader,
  createSourceSpanResolver,
  loadSpec,
  sourceOf,
  STDIN_URI,
  type SourceSpan,
  type SourceText,
} from "@oaverify/internal-spec";
import { createYamlFileReader, createYamlSpanBackend } from "../src/index.js";

/**
 * The YAML backend against the cases the brief's coverage table names,
 * plus the ones it does not. Every case asserts a defined answer;
 * `undefined` is an answer and is asserted as one.
 *
 * Spans are checked by slicing the source text with the offsets rather
 * than by asserting a line number alone: a line number can be right by
 * accident, and the slice says which node was addressed.
 */

const backend = createYamlSpanBackend();

/** Span for one pointer in one text, through the public resolver. */
function spanIn(
  text: string,
  pointer: string,
  options: { want?: "value" | "key"; uri?: string; syntax?: SourceText["syntax"] } = {},
): SourceSpan | undefined {
  const uri = options.uri ?? "doc.yaml";
  const resolver = createSourceSpanResolver({
    texts: { textFor: (asked) => (asked === uri ? { text, syntax: options.syntax } : undefined) },
    backends: [backend],
  });
  return resolver.spanFor({ uri, pointer, want: options.want });
}

/** The text a span addresses. */
function sliceOf(text: string, span: SourceSpan | undefined): string | undefined {
  return span === undefined ? undefined : text.slice(span.start.offset, span.end.offset);
}

const SPEC = `openapi: 3.1.0
info:
  title: Widgets
  version: "1"
paths:
  /orders/{id}:
    get:
      responses:
        "200":
          description: ok
components:
  schemas:
    Order:
      type: object
      required: [id, nope]
`;

describe("node kinds", () => {
  it("addresses a scalar value", () => {
    const span = spanIn(SPEC, "/info/title");
    expect(sliceOf(SPEC, span)).toBe("Widgets");
    expect(span?.start.line).toBe(3);
    expect(span?.start.column).toBe(10);
  });

  it("addresses a mapping value as the whole subtree", () => {
    const span = spanIn(SPEC, "/components/schemas/Order");
    expect(sliceOf(SPEC, span)).toBe("type: object\n      required: [id, nope]\n");
    expect(span?.start.line).toBe(14);
  });

  it("addresses a sequence element", () => {
    const span = spanIn(SPEC, "/components/schemas/Order/required/1");
    expect(sliceOf(SPEC, span)).toBe("nope");
  });

  it("addresses a mapping key, which is what a whole-component finding wants", () => {
    const value = spanIn(SPEC, "/components/schemas/Order");
    const key = spanIn(SPEC, "/components/schemas/Order", { want: "key" });

    expect(sliceOf(SPEC, key)).toBe("Order");
    expect(key?.start.line).toBe(13);
    // The point of the distinction: the key is one line, the value is
    // the component. An editor squiggle over the second says nothing.
    expect(value?.end.line).toBeGreaterThan(value?.start.line ?? 0);
    expect(key?.end.line).toBe(key?.start.line);
  });

  it("addresses the whole document at the root pointer", () => {
    const span = spanIn(SPEC, "");
    expect(span?.start.line).toBe(1);
    expect(span?.start.offset).toBe(0);
  });

  it("has no key for a sequence element, and none for the root", () => {
    expect(spanIn(SPEC, "/components/schemas/Order/required/1", { want: "key" })).toBeUndefined();
    expect(spanIn(SPEC, "", { want: "key" })).toBeUndefined();
  });
});

describe("key shapes", () => {
  it("resolves a path template, whose key contains the pointer separator", () => {
    const span = spanIn(SPEC, "/paths/~1orders~1{id}/get");
    expect(sliceOf(SPEC, span)).toBe('responses:\n        "200":\n          description: ok\n');

    const key = spanIn(SPEC, "/paths/~1orders~1{id}", { want: "key" });
    expect(sliceOf(SPEC, key)).toBe("/orders/{id}");
  });

  const awkward = `x:
  "a~b": tilde
  "a%20b": percent
  "a b": space
  "": empty
  "1": quoted-number
`;

  it("resolves a key containing a literal tilde", () => {
    expect(sliceOf(awkward, spanIn(awkward, "/x/a~0b"))).toBe("tilde");
  });

  it("resolves a key containing a percent sequence, without decoding it", () => {
    expect(sliceOf(awkward, spanIn(awkward, "/x/a%20b"))).toBe("percent");
    // The pointer arrives percent-decoded, so `a b` is a different key.
    expect(sliceOf(awkward, spanIn(awkward, "/x/a b"))).toBe("space");
  });

  it("resolves the empty key, which is a legal pointer segment", () => {
    expect(sliceOf(awkward, spanIn(awkward, "/x/"))).toBe("empty");
  });

  it("resolves a numeric key in a mapping, which is a string in a pointer", () => {
    expect(sliceOf(awkward, spanIn(awkward, "/x/1"))).toBe("quoted-number");
  });

  it("returns undefined for a key that is not there", () => {
    expect(spanIn(SPEC, "/components/schemas/Missing")).toBeUndefined();
    expect(spanIn(SPEC, "/info/title/deeper")).toBeUndefined();
  });

  it("returns undefined for a sequence index that is not an index", () => {
    const required = "/components/schemas/Order/required";
    expect(spanIn(SPEC, `${required}/0`)).toBeDefined();
    expect(spanIn(SPEC, `${required}/2`)).toBeUndefined();
    expect(spanIn(SPEC, `${required}/-`)).toBeUndefined();
    expect(spanIn(SPEC, `${required}/01`)).toBeUndefined();
    expect(spanIn(SPEC, `${required}/x`)).toBeUndefined();
  });
});

describe("text quirks", () => {
  it("counts CRLF line endings as one line each", () => {
    const text = SPEC.replaceAll("\n", "\r\n");
    const span = spanIn(text, "/info/title");
    expect(sliceOf(text, span)).toBe("Widgets");
    expect(span?.start.line).toBe(3);
  });

  it("takes a leading BOM in its stride", () => {
    const text = `﻿${SPEC}`;
    const span = spanIn(text, "/info/title");
    expect(sliceOf(text, span)).toBe("Widgets");
    expect(span?.start.line).toBe(3);
  });

  it("handles a file with no trailing newline", () => {
    const text = SPEC.trimEnd();
    expect(sliceOf(text, spanIn(text, "/components/schemas/Order/required/1"))).toBe("nope");
  });

  it("counts columns in UTF-16 code units, not code points", () => {
    // One astral character before the target on the same line. Its two
    // code units are what SARIF and LSP both count by default; a
    // code-point count would put `hi` one column earlier.
    const text = 'a: {x: "\u{1F600}", b: hi}\n';
    const span = spanIn(text, "/a/b");
    expect(sliceOf(text, span)).toBe("hi");
    expect(span?.start.column).toBe(17);
    expect(span?.start.offset).toBe(text.indexOf("hi"));
    // The same position counted in code points, which is what a
    // terminal would want and what this type does not promise.
    // `Array.from` rather than a spread: `[...str]` is the type-aware
    // lint failure AGENTS.md records, and this package has no access to
    // the schema compiler's `n` helper.
    expect(Array.from(text.slice(0, span?.start.offset ?? 0))).toHaveLength(15);
  });

  it("answers from what a tab-indented document recovers, and does not throw", () => {
    // Tabs are not legal YAML indentation. `yaml` collects the error
    // and returns the document it recovered, and this backend answers
    // from that: the root is addressable, the node under the bad indent
    // is not. Undefined here means "not in the tree", the same as any
    // other missing pointer. Deciding what a partially-readable
    // document means for a whole run is a different contract.
    const text = "info:\n\ttitle: X\n";
    expect(spanIn(text, "/info/title")).toBeUndefined();
    expect(spanIn(text, "")?.start.line).toBe(1);
  });
});

describe("degenerate documents", () => {
  it("returns undefined for an empty document", () => {
    expect(spanIn("", "")).toBeUndefined();
    expect(spanIn("", "/info")).toBeUndefined();
  });

  it("addresses a document that is valid YAML and not a mapping", () => {
    expect(sliceOf("just a string\n", spanIn("just a string\n", ""))).toBe("just a string");
    expect(spanIn("just a string\n", "/info")).toBeUndefined();
  });

  it("addresses a sequence at the root", () => {
    const text = "- first\n- second\n";
    expect(sliceOf(text, spanIn(text, "/1"))).toBe("second");
  });

  it("gives an alias its own span and does not follow it", () => {
    const text = "base: &shared\n  type: object\nuse: *shared\n";
    expect(sliceOf(text, spanIn(text, "/use"))).toBe("*shared");
    // Descending through the alias would land on text the pointer does
    // not address, in another part of the file.
    expect(spanIn(text, "/use/type")).toBeUndefined();
  });
});

describe("backend selection", () => {
  const yamlText = "info:\n  title: X\n";

  it("claims a .yaml or .yml uri, and declines a .json one", () => {
    expect(backend.claims({ uri: "a.yaml", text: yamlText })).toBe(true);
    expect(backend.claims({ uri: "a.YML", text: yamlText })).toBe(true);
    expect(backend.claims({ uri: "a.json", text: "{}" })).toBe(false);
  });

  it("obeys a declared syntax over the uri, in both directions", () => {
    expect(backend.claims({ uri: "a.json", text: "{}", syntax: "yaml" })).toBe(true);
    expect(backend.claims({ uri: "a.yaml", text: yamlText, syntax: "json" })).toBe(false);
  });

  it("sniffs a uri that says nothing, which is what stdin is", () => {
    expect(backend.claims({ uri: STDIN_URI, text: yamlText })).toBe(true);
    expect(backend.claims({ uri: STDIN_URI, text: '{"a": 1}' })).toBe(false);
    expect(backend.claims({ uri: "https://example.com/openapi", text: yamlText })).toBe(true);
    expect(backend.claims({ uri: "mem://spec", text: yamlText })).toBe(true);
  });

  it("resolves a stdin document the caller supplied text and syntax for", () => {
    const span = spanIn(yamlText, "/info/title", { uri: STDIN_URI, syntax: "yaml" });
    expect(sliceOf(yamlText, span)).toBe("X");
  });

  it("declines a JSON document, so round 1 answers nothing for one", () => {
    const json = '{"info": {"title": "X"}}';
    const resolver = createSourceSpanResolver({
      texts: { textFor: () => ({ text: json, syntax: "json" as const }) },
      backends: [backend],
    });
    expect(resolver.spanFor({ uri: "a.json", pointer: "/info/title" })).toBeUndefined();
    expect(resolver.stats()).toEqual({ parses: 0, noText: 0, noBackend: 1, notFound: 0 });
  });
});

describe("end to end, from a loaded spec's source address", () => {
  const ENTRY = `openapi: 3.1.0
info: { title: X, version: "1" }
paths:
  /orders/{id}:
    post:
      responses: { "200": { description: ok } }
      requestBody:
        content:
          application/json:
            schema:
              $ref: "./order.yaml#/components/schemas/Order"
`;

  const ORDER = `components:
  schemas:
    Order:
      type: object
      required: [id, nope]
      properties:
        id: { type: string }
`;

  let dir: string;
  const texts: Record<string, string> = { "entry.yaml": ENTRY, "order.yaml": ORDER };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oav-span-"));
    writeFileSync(join(dir, "entry.yaml"), ENTRY);
    writeFileSync(join(dir, "order.yaml"), ORDER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The caller supplies text it already holds, which is the editor
   * case. Nothing here re-reads by URI: the resolver has no way to.
   */
  const resolverOver = (held: Record<string, string>) =>
    createSourceSpanResolver({
      texts: {
        textFor: (uri) => {
          const text = held[uri];
          return text === undefined ? undefined : { text, syntax: "yaml" };
        },
      },
      backends: [backend],
    });

  const load = async () => {
    const reader = composeReaders([createYamlFileReader(dir), createFileReader(dir)]);
    return loadSpec({ reader, entry: "entry.yaml", provenance: true });
  };

  it("lands on the line the author wrote, in the file the author wrote it in", async () => {
    const { regions } = await load();
    const address = sourceOf(regions ?? [], "/components/schemas/Order/required");
    expect(address?.uri).toBe("order.yaml");

    const span = resolverOver(texts).spanFor(address ?? { uri: "", pointer: "" });
    expect(span?.start.line).toBe(5);
    expect(sliceOf(ORDER, span)).toBe("[id, nope]");
  });

  it("resolves a hop through the same call, because a hop is the same shape", async () => {
    const { regions } = await load();
    const address = sourceOf(regions ?? [], "/components/schemas/Order/required");
    const hop = address?.via[0];
    expect(hop?.uri).toBe("entry.yaml");

    // Address and hop in one batch, which is what a SARIF result with
    // relatedLocations needs.
    const resolver = resolverOver(texts);
    const [addressSpan, hopSpan] = resolver.spansFor([
      address ?? { uri: "", pointer: "" },
      hop ?? { uri: "", pointer: "" },
    ]);

    expect(sliceOf(ORDER, addressSpan)).toBe("[id, nope]");
    expect(sliceOf(ENTRY, hopSpan)?.trim()).toBe('$ref: "./order.yaml#/components/schemas/Order"');
    expect(resolver.stats().parses).toBe(2);
  });

  it("parses each document once across many addresses in two files", async () => {
    const { regions } = await load();
    const pointers = [
      "/components/schemas/Order/required",
      "/components/schemas/Order/required/1",
      "/components/schemas/Order/type",
      "/components/schemas/Order/properties/id",
      "/info/title",
      "/paths/~1orders~1{id}/post/responses/200/description",
    ];
    const addresses = pointers
      .map((pointer) => sourceOf(regions ?? [], pointer))
      .filter((address) => address !== undefined);
    expect(addresses).toHaveLength(pointers.length);
    expect(new Set(addresses.map((address) => address.uri)).size).toBe(2);

    const resolver = resolverOver(texts);
    const spans = resolver.spansFor(addresses);

    expect(spans.filter((span) => span !== undefined)).toHaveLength(pointers.length);
    // Six addresses, two documents, two parses.
    expect(resolver.stats().parses).toBe(2);
  });

  it("resolves nothing for a node the resolver invented, and says why", async () => {
    const { regions } = await load();
    // The hoisted schema's container is synthetic: no source node
    // corresponds to it, so there is no address to ask for a span with.
    expect(sourceOf(regions ?? [], "/components/schemas")).toBeUndefined();
  });

  it("gives undefined, not a wrong span, when the caller holds no text for a document", async () => {
    const { regions } = await load();
    const address = sourceOf(regions ?? [], "/components/schemas/Order/required");

    // An editor with entry.yaml open and order.yaml closed.
    const resolver = resolverOver({ "entry.yaml": ENTRY });
    expect(resolver.spanFor(address ?? { uri: "", pointer: "" })).toBeUndefined();
    expect(resolver.stats().noText).toBe(1);
  });

  it("gives undefined when the caller's text has moved on past the address", async () => {
    const { regions } = await load();
    const address = sourceOf(regions ?? [], "/components/schemas/Order/required");

    // The failure mode a file re-read has and a live buffer does not.
    // Where the edit removes the node, the answer is undefined, which
    // is the safe direction. Where an edit leaves the pointer
    // resolvable, the span moves with it and is right for the text it
    // was given, which is all this call claims.
    const edited = ORDER.replace("required: [id, nope]", "type: object");
    expect(
      resolverOver({ "order.yaml": edited }).spanFor(address ?? { uri: "", pointer: "" }),
    ).toBeUndefined();

    const shifted = `# a comment someone added at the top\n${ORDER}`;
    const span = resolverOver({ "order.yaml": shifted }).spanFor(
      address ?? { uri: "", pointer: "" },
    );
    expect(span?.start.line).toBe(6);
    expect(sliceOf(shifted, span)).toBe("[id, nope]");
  });
});

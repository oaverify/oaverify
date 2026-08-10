import { describe, expect, it, vi } from "vitest";
import {
  createSourceSpanResolver,
  pointerSegments,
  type SourceDocument,
  type SourceSpan,
  type SpanBackend,
  type SpanQuery,
  type SpanRequest,
  type SourceText,
} from "../src/index.js";

/**
 * The resolver's own contract, with parsing stubbed out. What is under
 * test here is grouping, positional alignment, backend selection and
 * the counts; the YAML backend's tests cover what a real parse answers.
 */

function span(line: number): SourceSpan {
  return {
    start: { line, column: 1, offset: line },
    end: { line, column: 2, offset: line + 1 },
  };
}

/** Answers every query with a span encoding the query's index. */
function countingBackend(options: { claims?: (doc: SourceDocument) => boolean } = {}): {
  backend: SpanBackend;
  calls: { uri: string; queries: readonly SpanQuery[] }[];
} {
  const calls: { uri: string; queries: readonly SpanQuery[] }[] = [];
  return {
    calls,
    backend: {
      claims: options.claims ?? (() => true),
      spansIn(doc, queries) {
        calls.push({ uri: doc.uri, queries });
        return queries.map((query, index) =>
          query.pointer === "/missing" ? undefined : span(index),
        );
      },
    },
  };
}

function textsFrom(map: Record<string, SourceText>) {
  return { textFor: (uri: string) => map[uri] };
}

describe("createSourceSpanResolver groups by document", () => {
  it("parses each document once however many requests name it", () => {
    const { backend, calls } = countingBackend();
    const resolver = createSourceSpanResolver({
      texts: textsFrom({ "a.yaml": { text: "a" } }),
      backends: [backend],
    });

    const requests: SpanRequest[] = Array.from({ length: 50 }, (_, index) => ({
      uri: "a.yaml",
      pointer: `/x/${index}`,
    }));
    const spans = resolver.spansFor(requests);

    expect(spans).toHaveLength(50);
    // The constraint the brief states as O(documents), as a number.
    expect(calls).toHaveLength(1);
    expect(resolver.stats().parses).toBe(1);
    expect(calls[0]?.queries).toHaveLength(50);
  });

  it("makes one call per distinct document and keeps answers in request order", () => {
    const { backend, calls } = countingBackend();
    const resolver = createSourceSpanResolver({
      texts: textsFrom({ "a.yaml": { text: "a" }, "b.yaml": { text: "b" } }),
      backends: [backend],
    });

    // Interleaved on purpose: grouping must not reorder the result.
    const spans = resolver.spansFor([
      { uri: "a.yaml", pointer: "/one" },
      { uri: "b.yaml", pointer: "/two" },
      { uri: "a.yaml", pointer: "/three" },
    ]);

    expect(calls.map((call) => call.uri)).toEqual(["a.yaml", "b.yaml"]);
    expect(spans[0]).toEqual(span(0)); // first of a.yaml's group
    expect(spans[1]).toEqual(span(0)); // first of b.yaml's group
    expect(spans[2]).toEqual(span(1)); // second of a.yaml's group
    expect(resolver.stats().parses).toBe(2);
  });

  it("gives the same pointer with two targets two answers", () => {
    const { backend, calls } = countingBackend();
    const resolver = createSourceSpanResolver({
      texts: textsFrom({ "a.yaml": { text: "a" } }),
      backends: [backend],
    });

    const spans = resolver.spansFor([
      { uri: "a.yaml", pointer: "/x", want: "value" },
      { uri: "a.yaml", pointer: "/x", want: "key" },
      { uri: "a.yaml", pointer: "/x" },
    ]);

    expect(spans).toHaveLength(3);
    expect(calls[0]?.queries).toEqual([
      { pointer: "/x", want: "value" },
      { pointer: "/x", want: "key" },
      // `want` defaulted before the backend sees it.
      { pointer: "/x", want: "value" },
    ]);
  });

  it("re-parses per call for spanFor, which is what its TSDoc says it costs", () => {
    const { backend, calls } = countingBackend();
    const resolver = createSourceSpanResolver({
      texts: textsFrom({ "a.yaml": { text: "a" } }),
      backends: [backend],
    });

    resolver.spanFor({ uri: "a.yaml", pointer: "/one" });
    resolver.spanFor({ uri: "a.yaml", pointer: "/two" });

    expect(calls).toHaveLength(2);
    expect(resolver.stats().parses).toBe(2);
  });
});

describe("createSourceSpanResolver distinguishes the ways a span can be absent", () => {
  it("counts a document with no text, and asks no backend about it", () => {
    const { backend, calls } = countingBackend();
    const resolver = createSourceSpanResolver({
      texts: textsFrom({ "a.yaml": { text: "a" } }),
      backends: [backend],
    });

    const spans = resolver.spansFor([
      { uri: "a.yaml", pointer: "/one" },
      { uri: "gone.yaml", pointer: "/two" },
      { uri: "gone.yaml", pointer: "/three" },
    ]);

    expect(spans[1]).toBeUndefined();
    expect(spans[2]).toBeUndefined();
    expect(calls.map((call) => call.uri)).toEqual(["a.yaml"]);
    expect(resolver.stats()).toEqual({ parses: 1, noText: 2, noBackend: 0, notFound: 0 });
  });

  it("counts a document no backend claims", () => {
    const { backend } = countingBackend({ claims: (doc) => doc.uri.endsWith(".yaml") });
    const resolver = createSourceSpanResolver({
      texts: textsFrom({ "a.json": { text: "{}" } }),
      backends: [backend],
    });

    expect(resolver.spansFor([{ uri: "a.json", pointer: "/one" }])[0]).toBeUndefined();
    expect(resolver.stats()).toEqual({ parses: 0, noText: 0, noBackend: 1, notFound: 0 });
  });

  it("counts a pointer the backend could not resolve", () => {
    const { backend } = countingBackend();
    const resolver = createSourceSpanResolver({
      texts: textsFrom({ "a.yaml": { text: "a" } }),
      backends: [backend],
    });

    expect(resolver.spansFor([{ uri: "a.yaml", pointer: "/missing" }])[0]).toBeUndefined();
    expect(resolver.stats()).toEqual({ parses: 1, noText: 0, noBackend: 0, notFound: 1 });
  });

  it("resolves nothing at all with no backends wired", () => {
    const resolver = createSourceSpanResolver({
      texts: textsFrom({ "a.yaml": { text: "a" } }),
      backends: [],
    });

    expect(resolver.spansFor([{ uri: "a.yaml", pointer: "/one" }])).toEqual([undefined]);
    expect(resolver.stats().noBackend).toBe(1);
  });

  it("returns an empty result for an empty batch, and parses nothing", () => {
    const { backend, calls } = countingBackend();
    const resolver = createSourceSpanResolver({
      texts: textsFrom({ "a.yaml": { text: "a" } }),
      backends: [backend],
    });

    expect(resolver.spansFor([])).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(resolver.stats()).toEqual({ parses: 0, noText: 0, noBackend: 0, notFound: 0 });
  });
});

describe("createSourceSpanResolver picks a backend the way composeReaders picks a reader", () => {
  it("takes the first claimer and asks no further", () => {
    const first = countingBackend();
    const second = countingBackend();
    const secondClaims = vi.spyOn(second.backend, "claims");
    const resolver = createSourceSpanResolver({
      texts: textsFrom({ "a.yaml": { text: "a" } }),
      backends: [first.backend, second.backend],
    });

    resolver.spansFor([{ uri: "a.yaml", pointer: "/one" }]);

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
    expect(secondClaims).not.toHaveBeenCalled();
  });

  it("hands the backend the uri, the text and the declared syntax", () => {
    const seen: SourceDocument[] = [];
    const backend: SpanBackend = {
      claims(doc) {
        seen.push(doc);
        return true;
      },
      spansIn: (_doc, queries) => queries.map(() => undefined),
    };
    const resolver = createSourceSpanResolver({
      // The case URI-based selection cannot answer: stdin says nothing.
      texts: textsFrom({ "-": { text: "openapi: 3.1.0\n", syntax: "yaml" } }),
      backends: [backend],
    });

    resolver.spansFor([{ uri: "-", pointer: "" }]);

    expect(seen).toEqual([{ uri: "-", text: "openapi: 3.1.0\n", syntax: "yaml" }]);
  });
});

describe("pointerSegments round-trips the keys check actually reports", () => {
  it("returns no segments for the root pointer", () => {
    expect(pointerSegments("")).toEqual([]);
  });

  it("unescapes a path template, which contains the separator", () => {
    expect(pointerSegments("/paths/~1orders~1{id}/get")).toEqual(["paths", "/orders/{id}", "get"]);
  });

  it("unescapes a literal tilde, and a tilde next to a one", () => {
    expect(pointerSegments("/x/a~0b")).toEqual(["x", "a~b"]);
    // `a~1b` escapes to `a~01b`: unescaping `~1` first must not see the
    // `~1` that the `~0` escape ends in.
    expect(pointerSegments("/x/a~01b")).toEqual(["x", "a~1b"]);
  });

  it("leaves percent sequences alone, because the pointer arrives decoded", () => {
    expect(pointerSegments("/x/a%20b")).toEqual(["x", "a%20b"]);
    expect(pointerSegments("/x/100%25")).toEqual(["x", "100%25"]);
  });

  it("keeps a space, and an empty segment", () => {
    expect(pointerSegments("/x/a b")).toEqual(["x", "a b"]);
    expect(pointerSegments("/x/")).toEqual(["x", ""]);
  });
});

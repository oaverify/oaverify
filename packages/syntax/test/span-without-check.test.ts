import { describe, expect, it } from "vitest";
import { createSourceSpanResolver } from "@oaverify/internal-spec";
import { createJsonSpanBackend, createYamlSpanBackend } from "../src/index.js";

/**
 * A span for either syntax, reachable from the kernel and this package
 * alone.
 *
 * The imports are the assertion. Nothing here reaches `@oaverify/check`
 * or the CLI, so an editor or any other consumer that wants a position
 * for a source address needs neither. The dependency direction is
 * asserted separately, from the manifests, by `scripts/check-deps.mjs`.
 *
 * Both syntaxes resolve through one resolver, because a spec assembled
 * from several files can mix them.
 */

const JSON_TEXT = `{
  "components": {
    "schemas": {
      "Order": { "required": ["id", "nope"] }
    }
  }
}
`;

const YAML_TEXT = `components:
  schemas:
    Order:
      required: [id, nope]
`;

const POINTER = "/components/schemas/Order/required";

const TEXTS: Record<string, { text: string; syntax: "json" | "yaml" }> = {
  "spec.json": { text: JSON_TEXT, syntax: "json" },
  "spec.yaml": { text: YAML_TEXT, syntax: "yaml" },
};

function resolver() {
  return createSourceSpanResolver({
    texts: { textFor: (uri) => TEXTS[uri] },
    backends: [createYamlSpanBackend(), createJsonSpanBackend()],
  });
}

describe("a source span, without check or the CLI", () => {
  it.each([
    ["spec.json", 4, '["id", "nope"]'],
    ["spec.yaml", 4, "[id, nope]"],
  ])("resolves %s to the text the author wrote", (uri, line, text) => {
    const span = resolver().spanFor({ uri, pointer: POINTER });
    expect(span).toBeDefined();
    expect(span?.start.line).toBe(line);
    expect(TEXTS[uri]?.text.slice(span?.start.offset, span?.end.offset)).toBe(text);
  });

  it("parses each document once however many pointers name it", () => {
    const r = resolver();
    const queries = Array.from({ length: 20 }, () => ({ uri: "spec.json", pointer: POINTER }));
    const spans = r.spansFor(queries);
    expect(spans).toHaveLength(20);
    expect(spans.every((s) => s?.start.line === 4)).toBe(true);
    expect(r.stats().parses).toBe(1);
  });

  it("answers for both syntaxes through one resolver", () => {
    const r = resolver();
    const spans = r.spansFor([
      { uri: "spec.json", pointer: POINTER },
      { uri: "spec.yaml", pointer: POINTER },
    ]);
    expect(spans.map((s) => s?.start.line)).toEqual([4, 4]);
    expect(r.stats().parses).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import {
  createSourceSpanResolver,
  resolveSpec,
  type DocumentReader,
  type SourceText,
} from "@oaverify/internal-spec";
import { createYamlSpanBackend } from "../src/span.js";
import { parseYamlString } from "../src/index.js";

/**
 * A reference that will not follow, resolved to a line and a column.
 *
 * The point of the exercise. `ResolvedSpec.unresolved` carries the
 * chain that reached the failing reference, and the last hop of that
 * chain is `{uri, pointer}` addressing the reference in the file that
 * holds it. That is structurally a `SpanRequest`, so the position comes
 * out of the resolver a caller already runs for findings, with no
 * second addressing scheme and no code that knows about YAML in the
 * path between them.
 */

const MAIN = `openapi: 3.1.0
info:
  title: X
  version: "1"
paths:
  /p:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: missing.yaml#/Order
`;

function readerOver(texts: Map<string, string>): DocumentReader {
  return {
    canRead: (uri) => texts.has(uri),
    read: async (uri) => {
      const text = texts.get(uri);
      if (text === undefined) throw new Error(`no entry for ${uri}`);
      return parseYamlString(text);
    },
  };
}

describe("a hole resolved to a position", () => {
  it("puts a line and column on the reference that would not follow", async () => {
    const texts = new Map([["main.yaml", MAIN]]);
    const resolved = await resolveSpec({
      reader: readerOver(texts),
      entry: "main.yaml",
      provenance: true,
      onUnresolved: "record",
    });

    expect(resolved.unresolved).toHaveLength(1);
    const hole = resolved.unresolved![0]!;
    const at = hole.via.at(-1)!;

    const spans = createSourceSpanResolver({
      texts: {
        textFor: (uri): SourceText | undefined => {
          const text = texts.get(uri);
          return text === undefined ? undefined : { text, syntax: "yaml" };
        },
      },
      backends: [createYamlSpanBackend()],
    });

    // The hop is handed over unchanged: `SpanRequest` is satisfied by a
    // `SourceHop`, which is why there is no adapter here.
    const [span] = spans.spansFor([at]);
    expect(span).toBeDefined();
    // Line 14 is the `$ref` line, and the span covers the reference
    // node rather than the whole operation.
    expect(span!.start.line).toBe(14);
    expect(MAIN.slice(span!.start.offset, span!.end.offset).trimEnd()).toBe(
      "$ref: missing.yaml#/Order",
    );
  });

  it("locates a fragment that names no node in the file that holds the reference", async () => {
    const texts = new Map([
      ["main.yaml", MAIN.replace("missing.yaml#/Order", "ext.yaml#/Ord")],
      ["ext.yaml", "Order:\n  type: object\n"],
    ]);
    const resolved = await resolveSpec({
      reader: readerOver(texts),
      entry: "main.yaml",
      provenance: true,
      onUnresolved: "record",
    });

    const hole = resolved.unresolved![0]!;
    // The file read; the pointer into it did not resolve.
    expect(hole.fragment).toBe("/Ord");

    const spans = createSourceSpanResolver({
      texts: {
        textFor: (uri): SourceText | undefined => {
          const text = texts.get(uri);
          return text === undefined ? undefined : { text, syntax: "yaml" };
        },
      },
      backends: [createYamlSpanBackend()],
    });
    const [span] = spans.spansFor([hole.via.at(-1)!]);
    // The position is on the reference the author is typing, not on the
    // file it names: the fix is to the fragment, and that is where the
    // caret belongs.
    expect(span).toBeDefined();
    expect(span!.start.line).toBe(14);
  });
});

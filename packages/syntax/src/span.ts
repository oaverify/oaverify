/**
 * The YAML {@link SpanBackend}: line and column for a pointer into a
 * YAML source document (#610).
 *
 * Positions are the part of a YAML parse that is already paid for. The
 * CST is built whether or not anyone asks for ranges, so attaching a
 * `LineCounter` costs nothing measurable; what costs is retaining the
 * tree, and this backend retains nothing past a call.
 *
 * @packageDocumentation
 */

import { LineCounter, isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";
import type { Node, Pair } from "yaml";
import {
  pointerSegments,
  type SourceDocument,
  type SourcePosition,
  type SourceSpan,
  type SpanBackend,
  type SpanQuery,
} from "@oaverify/internal-spec";

/** A node with the three-element range `yaml` gives every CST node. */
type Ranged = { range?: [number, number, number] | null };

function looksLikeJsonText(text: string): boolean {
  return text.trimStart().startsWith("{");
}

/**
 * Claim rule, in the order it is applied.
 *
 * A declared `syntax` is authoritative: `"json"` is declined even
 * though YAML would parse it, because a JSON document deserves JSON
 * positions from a JSON backend rather than positions from a parser
 * that happens to accept the grammar.
 *
 * With no declared syntax, a `.yaml` / `.yml` URI is claimed and a
 * `.json` URI is declined. Anything else, which is every `-` (stdin),
 * memory and extension-less HTTP URI, is decided by the same sniff the
 * stdin reader uses: text starting with `{` is JSON-shaped and is
 * declined, everything else is claimed. So YAML is the fallback for a
 * URI that says nothing, which is what the loader does too.
 */
function claims(doc: SourceDocument): boolean {
  if (doc.syntax !== undefined) return doc.syntax === "yaml";
  const lower = doc.uri.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return true;
  if (lower.endsWith(".json")) return false;
  return !looksLikeJsonText(doc.text);
}

/** The scalar key of a pair as a pointer segment, or undefined. */
function keyToken(pair: Pair<unknown, unknown>): string | undefined {
  const key: unknown = pair.key;
  if (!isScalar(key)) return undefined;
  const value: unknown = key.value;
  // A pointer segment is a string, and the resolved document reached
  // these keys through the same conversion: YAML admits numeric,
  // boolean and null keys, and each addresses as its scalar spelling.
  // Anything else (a mapping or sequence used as a key, which YAML
  // allows and OpenAPI never uses) has no pointer spelling at all.
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      return undefined;
  }
}

/**
 * The node a pointer addresses, or the key that introduces it.
 *
 * Walked by hand rather than through `doc.getIn`, because `getIn`
 * returns the value node and the key is a different lookup: only the
 * `Pair` knows both, and the walk is the only place that holds one.
 */
function nodeAt(root: unknown, segments: readonly string[], want: SpanQuery["want"]): unknown {
  let current: unknown = root;

  for (const [depth, segment] of segments.entries()) {
    const last = depth === segments.length - 1;

    if (isMap(current)) {
      const pair = current.items.find(
        (item) => isPair(item) && keyToken(item as Pair<unknown, unknown>) === segment,
      );
      if (pair === undefined) return undefined;
      if (last && want === "key") return (pair as Pair<unknown, unknown>).key;
      current = (pair as Pair<unknown, unknown>).value;
      continue;
    }

    if (isSeq(current)) {
      // RFC 6901 array indices are digits only: `01` and `-` are not
      // indices, and neither is anything a `parseInt` would salvage.
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return undefined;
      const item: unknown = current.items[Number(segment)];
      if (item === undefined) return undefined;
      // A sequence element has no key. Answering with the element would
      // be a different node wearing the requested name.
      if (last && want === "key") return undefined;
      current = item;
      continue;
    }

    return undefined;
  }

  // The root pointer with `want: "key"` has no answer for the same
  // reason a sequence element does not: nothing introduces it.
  if (segments.length === 0 && want === "key") return undefined;
  return current;
}

function positionAt(counter: LineCounter, offset: number): SourcePosition {
  const { line, col } = counter.linePos(offset);
  return { line, column: col, offset };
}

/**
 * A YAML {@link @oaverify/core/spec!SpanBackend}.
 *
 * Stateless and retains nothing: each {@link @oaverify/core/spec!SpanBackend.spansIn}
 * call parses the text it is given, answers every query against that
 * one parse, and drops it. A caller controls how often that happens by
 * how it batches.
 *
 * Two behaviours worth knowing before reading an `undefined` as "the
 * node is not there":
 *
 * - **Parse errors do not throw.** `yaml` collects them and returns
 *   whatever document it recovered, and this backend answers from that.
 *   A pointer into the part that parsed still resolves. Deciding what a
 *   partially-readable document means for a whole `check` run is a
 *   different contract and is not this call's business.
 * - **Aliases are not followed.** A pointer landing on an alias gets the
 *   span of the alias, which is where the author wrote it. A pointer
 *   descending *through* an alias resolves to `undefined`, because the
 *   node under it was written somewhere else and a span there would
 *   name text the pointer does not address.
 *
 * @public
 */
export function createYamlSpanBackend(): SpanBackend {
  return {
    claims,

    spansIn(doc: SourceDocument, queries: readonly SpanQuery[]) {
      const counter = new LineCounter();
      // `keepSourceTokens` is off: the CST is built either way and the
      // node ranges are what this needs.
      const parsed = parseDocument(doc.text, { lineCounter: counter });
      const root: Node | null = parsed.contents;

      return queries.map((query) => {
        const node = nodeAt(root, pointerSegments(query.pointer), query.want);
        const range = (node as Ranged | undefined | null)?.range;
        if (range === undefined || range === null) return undefined;
        const [start, end] = range;
        return { start: positionAt(counter, start), end: positionAt(counter, end) } as SourceSpan;
      });
    },
  };
}

/**
 * The JSON {@link SpanBackend}: line and column for a pointer into a
 * JSON source document (#610).
 *
 * Streaming rather than tree-building. `jsonc-parser` offers both
 * `parseTree` plus `findNodeAtLocation`, which is random access into a
 * retained tree, and `visit`, which is one pass that retains nothing.
 * The second is faster and holds nothing, and it is expressible only
 * because {@link SpanBackend.spansIn} is handed every pointer for a
 * document at once. That is what the batch interface bought.
 *
 * The cost is here rather than in the interface: matching a pointer
 * during a visit means tracking the path across the callbacks, which
 * `findNodeAtLocation` would have done. The path tracking is the whole
 * of this file.
 *
 * `jsonc-parser` is this package's to carry, not `@oaverify/core`'s.
 * The kernel is dependency-free and holds the contracts this file
 * implements; the parsers live here. See AGENTS.md, "Package roles".
 *
 * @packageDocumentation
 */

import { visit } from "jsonc-parser";
import {
  pointerSegments,
  type SourceDocument,
  type SourcePosition,
  type SourceSpan,
  type SpanBackend,
  type SpanQuery,
} from "@oaverify/internal-spec";

function looksLikeJsonText(text: string): boolean {
  return text.trimStart().startsWith("{");
}

/**
 * Claim rule, mirroring the YAML backend's so that the two together
 * answer for any URI without overlapping.
 *
 * A declared `syntax` is authoritative. Without one, a `.json` URI is
 * claimed and `.yaml` / `.yml` declined; anything else, which is every
 * `-` (stdin), memory and extension-less HTTP URI, is claimed only if
 * the text is JSON-shaped. So a YAML backend listed first still wins a
 * YAML-shaped stdin document, and this one wins a JSON-shaped one.
 */
function claims(doc: SourceDocument): boolean {
  if (doc.syntax !== undefined) return doc.syntax === "json";
  const lower = doc.uri.toLowerCase();
  if (lower.endsWith(".json")) return true;
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return false;
  return looksLikeJsonText(doc.text);
}

/** Offsets of every line start, for turning an offset into a position. */
function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/** The line holding `offset`, by binary search over line starts. */
function positionAt(starts: readonly number[], offset: number): SourcePosition {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1, offset };
}

/** One object or array the visit is inside. */
interface Frame {
  readonly kind: "object" | "array";
  /** {@link keyOf} for the path naming this container. */
  readonly path: string;
  /** Offset of the opening brace or bracket. */
  readonly start: number;
  /** Next index, for an array. */
  index: number;
  /** The property whose value comes next, for an object. */
  key?: string;
}

/**
 * A path as one string, for map lookup.
 *
 * A string rather than an array because the visit derives one per value
 * it walks, and on a 7 MB document that is hundreds of thousands of
 * them: an array plus a `JSON.stringify` per node measured 168 ms
 * against this form's 74 ms.
 *
 * Every segment is *prefixed* by a separator no segment can contain,
 * rather than joined by one. Joining would give the root pointer `""`
 * and the pointer `"/"`, whose one segment is the empty string, the
 * same key.
 */
const SEP = "\u0000";

function keyOf(segments: readonly string[]): string {
  let key = "";
  for (const segment of segments) key += SEP + segment;
  return key;
}

/**
 * A JSON {@link @oaverify/core/spec!SpanBackend}.
 *
 * One pass per {@link @oaverify/core/spec!SpanBackend.spansIn} call,
 * retaining nothing but the spans it was asked for. Answers `"key"` as
 * the property including its quotes, and `"value"` as the value token
 * or the whole container.
 *
 * Two behaviours a caller should know:
 *
 * - **Parse errors do not throw.** `jsonc-parser` reports them through
 *   its error callback and keeps going, so a pointer into the part
 *   that parsed still resolves. This backend ignores the errors, the
 *   way the YAML one ignores `yaml`'s.
 * - **A duplicate key resolves to the last one**, which is what
 *   `JSON.parse` does, so the span names the member the checked
 *   document actually holds.
 *
 * @public
 */
export function createJsonSpanBackend(): SpanBackend {
  return {
    claims,

    spansIn(doc: SourceDocument, queries: readonly SpanQuery[]) {
      const spans: (SourceSpan | undefined)[] = new Array<SourceSpan | undefined>(queries.length);

      // Slots wanted per path, split by target, so a match is a lookup
      // rather than a scan of the query list.
      const wantValue = new Map<string, number[]>();
      const wantKey = new Map<string, number[]>();
      for (const [slot, query] of queries.entries()) {
        const into = query.want === "key" ? wantKey : wantValue;
        const key = keyOf(pointerSegments(query.pointer));
        const slots = into.get(key);
        if (slots === undefined) into.set(key, [slot]);
        else slots.push(slot);
      }
      if (wantValue.size === 0 && wantKey.size === 0) return spans;

      // Every wanted path, indexed by each of its proper prefixes, so a
      // member that is about to be re-opened by a duplicate key can drop
      // what the earlier member recorded below it. Built from the
      // queries rather than from the document, so it is proportional to
      // the batch and not to the file.
      const below = new Map<string, string[]>();
      for (const path of [...wantValue.keys(), ...wantKey.keys()]) {
        for (let cut = path.indexOf(SEP, 1); cut !== -1; cut = path.indexOf(SEP, cut + 1)) {
          const prefix = path.slice(0, cut);
          const under = below.get(prefix);
          if (under === undefined) below.set(prefix, [path]);
          else under.push(path);
        }
      }

      const starts = lineStartsOf(doc.text);
      /**
       * Forget what an earlier member with this key recorded below it.
       *
       * `JSON.parse` keeps the last member of a duplicated key, so the
       * earlier one's subtree is not in the document that was checked
       * and must not be addressable. The member's own path needs no
       * clearing: the winning value records over it. Its descendants do,
       * because the winner may not have any.
       */
      const forgetBelow = (path: string) => {
        for (const under of below.get(path) ?? []) {
          for (const slot of wantValue.get(under) ?? []) spans[slot] = undefined;
          for (const slot of wantKey.get(under) ?? []) spans[slot] = undefined;
        }
      };

      const record = (into: Map<string, number[]>, path: string, from: number, to: number) => {
        const slots = into.get(path);
        if (slots === undefined) return;
        // Built once per match rather than per slot: two queries for the
        // same path get the same span, and it is immutable.
        const span: SourceSpan = { start: positionAt(starts, from), end: positionAt(starts, to) };
        // Assigned rather than kept: a duplicate key means the later
        // member is the one `JSON.parse` would have produced.
        for (const slot of slots) spans[slot] = span;
      };

      const stack: Frame[] = [];
      /** The path of the value that is about to be read. */
      const pathOfNextValue = (): string => {
        const top = stack.at(-1);
        if (top === undefined) return "";
        const segment = top.kind === "object" ? (top.key ?? "") : String(top.index);
        return top.path + SEP + segment;
      };
      /** A value at the current position finished; advance the parent. */
      const finished = () => {
        const top = stack.at(-1);
        if (top === undefined) return;
        if (top.kind === "array") top.index += 1;
        else top.key = undefined;
      };
      const enter = (kind: Frame["kind"], offset: number) => {
        stack.push({ kind, path: pathOfNextValue(), start: offset, index: 0 });
      };
      const leave = (offset: number, length: number) => {
        const frame = stack.pop();
        if (frame === undefined) return;
        record(wantValue, frame.path, frame.start, offset + length);
        finished();
      };

      visit(doc.text, {
        onObjectBegin: (offset) => {
          enter("object", offset);
        },
        onObjectProperty: (name, offset, length) => {
          const top = stack.at(-1);
          if (top === undefined) return;
          top.key = name;
          const path = pathOfNextValue();
          // Before the value is walked, so anything this member records
          // survives and only the previous member's subtree is dropped.
          forgetBelow(path);
          record(wantKey, path, offset, offset + length);
        },
        onObjectEnd: leave,
        onArrayBegin: (offset) => {
          enter("array", offset);
        },
        onArrayEnd: leave,
        onLiteralValue: (_value, offset, length) => {
          record(wantValue, pathOfNextValue(), offset, offset + length);
          finished();
        },
      });

      return spans;
    },
  };
}

/**
 * Line and column for a source address (#610).
 *
 * `sourceOf` answers *which document and where in it*. This file
 * answers *which line*, and it is deliberately a second call rather
 * than a field on `SourceAddress`: an address is present or
 * absent as a unit, and "no source node corresponds to this" is a fact
 * about the node, while "no position is available" is a fact about what
 * the caller supplied and which backends it wired. Folding the second
 * into the first would put two different absences behind one `undefined`.
 *
 * Three things a reader should know before using any of this.
 *
 * **Text comes from the caller.** Nothing in the load path retains the
 * bytes a document was parsed from; `DocumentReader.read` returns
 * parsed data. So a {@link SourceTextProvider} is a required option,
 * and what it returns is the caller's claim about what was checked.
 * See its TSDoc for what happens when that claim is wrong.
 *
 * **Backends carry the parsers.** This module knows nothing about YAML
 * or JSON. `@oaverify/syntax` exports a {@link SpanBackend}, and a caller
 * that wires none gets `undefined` for everything. That is what keeps
 * `@oaverify/core` free of a parser dependency.
 *
 * **Resolution is per document, not per request.** Requests are grouped
 * by URI and each document's backend is called once with every query
 * against it, so N findings in one file cost one parse. That is the
 * whole reason {@link SpanBackend.spansIn} takes a list.
 *
 * @packageDocumentation
 */

/**
 * A position in a source document.
 *
 * `line` and `column` are 1-based; `offset` is 0-based. All three count
 * **UTF-16 code units**, which is what JavaScript string indices are,
 * what SARIF `region` counts by default, and what LSP negotiates to by
 * default. A consumer that wants code points (a terminal drawing a
 * caret, say) converts at its own edge.
 *
 * `offset` is here because both SARIF (`charOffset` / `charLength`) and
 * `text.slice(start.offset, end.offset)` want it, and every backend
 * produces it before it produces a line.
 *
 * @public
 */
export interface SourcePosition {
  /** 1-based line. */
  readonly line: number;
  /** 1-based column, in UTF-16 code units. */
  readonly column: number;
  /** 0-based offset from the start of the document, in UTF-16 code units. */
  readonly offset: number;
}

/**
 * A stretch of a source document, `start` inclusive and `end`
 * **exclusive**.
 *
 * Exclusive so that `text.slice(start.offset, end.offset)` is the
 * addressed text and `end.offset - start.offset` is SARIF's
 * `charLength`. A single-character span therefore has
 * `end.column === start.column + 1`.
 *
 * @public
 */
export interface SourceSpan {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

/**
 * The syntax a source document is written in.
 *
 * @public
 */
export type SourceSyntax = "yaml" | "json";

/**
 * The text of one source document, as the caller reports it.
 *
 * `syntax` is authoritative when present: a backend that handles a
 * different syntax declines rather than guessing. Omit it to let
 * backends infer from the URI and the text, which is best effort and
 * is the only option for a document whose URI carries no extension.
 * {@link STDIN_URI} is the case that forces this to exist: `-` says
 * nothing about whether the piped bytes were YAML or JSON.
 *
 * @public
 */
export interface SourceText {
  readonly text: string;
  readonly syntax?: SourceSyntax;
}

/**
 * Where {@link createSourceSpanResolver} gets document text.
 *
 * A required option, because there is nowhere else for text to come
 * from: resolution discards it, and a URI is not a promise that the
 * bytes behind it are still the bytes that were checked. Returning
 * `undefined` for a URI means "no text available", and every request
 * against that document resolves to `undefined`.
 *
 * **What this interface asks of a caller.** The text must be the text
 * the document at `uri` was *loaded from*. Two failure modes follow,
 * and neither is detectable from inside a resolver:
 *
 * - Text that has changed in a way that moves or removes the addressed
 *   node yields `undefined`, because the pointer no longer resolves.
 *   That is the safe direction.
 * - Text that has changed while leaving the pointer resolvable yields a
 *   **span pointing at the wrong thing**. A file re-read from disk after
 *   an edit is exactly this case.
 *
 * An editor supplying the buffer it is displaying has neither problem,
 * because the buffer is what its user is looking at. A CLI re-reading
 * files it just loaded has the second one, bounded by how long the run
 * takes.
 *
 * @public
 */
export interface SourceTextProvider {
  textFor(uri: string): SourceText | undefined;
}

/**
 * One document, as a backend sees it.
 *
 * @public
 */
export interface SourceDocument {
  /** The URI the caller asked about, unmodified. */
  readonly uri: string;
  readonly text: string;
  /** Authoritative when present. See {@link SourceText.syntax}. */
  readonly syntax?: SourceSyntax;
}

/**
 * Which node of an addressed entry a span should cover.
 *
 * The pointer addresses a value, and for a value inside a mapping there
 * are two defensible answers. `"value"` is the node the pointer names.
 * `"key"` is the key that introduces it, which is what a reader wants
 * for a finding about a component's existence rather than its contents:
 * a squiggle under 400 lines of schema says less than one under
 * `Order`.
 *
 * Deliberately a caller's choice rather than something inferred from
 * `check`'s `FindingAnchor`. That type says whether a
 * `$ref` was crossed, which is a fact about the resolver's walk;
 * key-versus-value is a fact about what a reader should look at. The
 * two are unrelated, and a rule that wants the key is not thereby a
 * rule that crossed a reference.
 *
 * `"key"` on a node that is not a mapping entry (a sequence element, or
 * the document root) has no answer and resolves to `undefined`.
 *
 * A third member covering key through value, which is what a "delete
 * this entry" editor action wants, is a plausible addition and would
 * widen this union without changing what either existing member means.
 *
 * @public
 */
export type SpanTarget = "value" | "key";

/**
 * One thing a caller wants a span for.
 *
 * Structurally satisfied by both `SourceAddress` and
 * `SourceHop`, so a `via` hop resolves through the same call as
 * the address it hangs off, and a consumer building SARIF
 * `relatedLocations` needs no second API.
 *
 * @public
 */
export interface SpanRequest {
  readonly uri: string;
  /** RFC 6901 pointer into the document at `uri`, `~0` / `~1` escaped. */
  readonly pointer: string;
  /** Defaults to `"value"`. */
  readonly want?: SpanTarget;
}

/**
 * A request as a backend receives it: no `uri`, because every query in
 * a call is against the one document passed alongside, and `want`
 * filled in.
 *
 * @public
 */
export interface SpanQuery {
  readonly pointer: string;
  readonly want: SpanTarget;
}

/**
 * A parser that can turn pointers into spans for one syntax.
 *
 * Backends are tried in the order the caller listed them and the first
 * to {@link SpanBackend.claims | claim} a document handles it, which is
 * the rule `composeReaders` already uses for readers. Order matters
 * where two backends could both claim: YAML parses JSON-shaped text, so
 * a YAML backend ahead of a JSON one will answer for a `.json`
 * document that declares no syntax, and the answer it gives is its own
 * rule rather than this module's.
 *
 * @public
 */
export interface SpanBackend {
  /**
   * Does this backend handle `doc`?
   *
   * A backend must decline a document whose `syntax` it does not
   * handle. With `syntax` absent it may infer from the URI and the
   * text, and that inference is best effort.
   */
  claims(doc: SourceDocument): boolean;

  /**
   * Resolve every query against `doc`, in one pass.
   *
   * Returns one entry per query, positionally aligned with `queries`,
   * `undefined` where the pointer does not resolve or the requested
   * target does not exist. Duplicate pointers and the same pointer with
   * different `want` values are both legal and each gets its own entry.
   *
   * Called at most once per document per {@link SpanRequest} batch,
   * which is what makes the cost of a batch proportional to the
   * documents in it rather than to the requests. A backend that throws
   * on unparseable text is left to throw; degrading gracefully on a
   * partial document is a separate contract.
   */
  spansIn(doc: SourceDocument, queries: readonly SpanQuery[]): readonly (SourceSpan | undefined)[];
}

/**
 * Counts from a resolver's life so far, for diagnosis rather than for
 * branching on.
 *
 * `parses` is the number of {@link SpanBackend.spansIn} calls made,
 * which is the number of documents whose text was handed to a parser.
 * It is the measurable form of the claim that cost is per document: a
 * batch of N requests against one URI leaves it at 1.
 *
 * The three absence counts add up with the resolved spans to the number
 * of requests, and exist so a caller staring at an empty column can
 * tell "no text was supplied" from "no backend claimed this" from "the
 * pointer did not resolve".
 *
 * @public
 */
export interface SourceSpanStats {
  readonly parses: number;
  readonly noText: number;
  readonly noBackend: number;
  readonly notFound: number;
}

/** @public */
export interface SourceSpanResolverOptions {
  /** Where document text comes from. See {@link SourceTextProvider}. */
  readonly texts: SourceTextProvider;
  /** Tried in order; the first to claim a document handles it. */
  readonly backends: readonly SpanBackend[];
}

/**
 * Resolves source addresses to line and column, over text the caller
 * supplies.
 *
 * @public
 */
export interface SourceSpanResolver {
  /**
   * Spans for a batch of requests, positionally aligned with it.
   *
   * Requests are grouped by URI, so the cost is one text lookup and at
   * most one parse per distinct document however many requests name it.
   * Pass everything you want at once; see {@link SourceSpanResolver.spanFor}
   * for what asking one at a time costs.
   */
  spansFor(requests: readonly SpanRequest[]): readonly (SourceSpan | undefined)[];

  /**
   * One span, for a caller that has one address in hand.
   *
   * A batch of one, and it re-parses the document every call. Where a
   * whole run's addresses are already known, which for a finished
   * `check` they are, {@link SourceSpanResolver.spansFor} does the same
   * work once.
   */
  spanFor(request: SpanRequest): SourceSpan | undefined;

  /** Diagnostic counts. See {@link SourceSpanStats}. */
  stats(): SourceSpanStats;
}

/**
 * Build a resolver over caller-supplied text and caller-wired backends.
 *
 * Nothing here is wired by default and nothing is retained between
 * calls: the resolver holds its options and its counts. A caller
 * controls parse cost by how it batches, and controls staleness by what
 * its {@link SourceTextProvider} returns, so an editor that re-reads a
 * buffer per keystroke needs no invalidation call.
 *
 * @example
 * ```ts
 * import { createSourceSpanResolver, type SourceAddress } from "@oaverify/core/spec";
 * import { createYamlSpanBackend } from "@oaverify/syntax";
 *
 * // What an editor holds: the buffer text, keyed by the URI the spec
 * // was loaded under. `textFor` returns a SourceText, so the syntax
 * // travels with the text rather than being guessed from the URI.
 * declare const buffers: Map<string, string>;
 * // Whatever `checkSpec` returned.
 * declare const findings: { target?: { source?: SourceAddress } }[];
 *
 * const resolver = createSourceSpanResolver({
 *   texts: {
 *     textFor: (uri) => {
 *       const text = buffers.get(uri);
 *       return text === undefined ? undefined : { text, syntax: "yaml" };
 *     },
 *   },
 *   backends: [createYamlSpanBackend()],
 * });
 *
 * const addresses = findings
 *   .map((finding) => finding.target?.source)
 *   .filter((address) => address !== undefined);
 * const spans = resolver.spansFor(addresses);
 * ```
 *
 * @public
 */
export function createSourceSpanResolver(options: SourceSpanResolverOptions): SourceSpanResolver {
  const { texts, backends } = options;
  let parses = 0;
  let noText = 0;
  let noBackend = 0;
  let notFound = 0;

  function spansFor(requests: readonly SpanRequest[]): readonly (SourceSpan | undefined)[] {
    const spans: (SourceSpan | undefined)[] = new Array<SourceSpan | undefined>(requests.length);

    // Grouped by URI so a document is looked up and parsed once. Each
    // group carries the slot its answer belongs in, because the result
    // is positional: the backend sees queries in group order and its
    // answers go back where they came from.
    const groups = new Map<string, { slot: number; query: SpanQuery }[]>();
    for (const [slot, request] of requests.entries()) {
      const query: SpanQuery = { pointer: request.pointer, want: request.want ?? "value" };
      const group = groups.get(request.uri);
      if (group === undefined) groups.set(request.uri, [{ slot, query }]);
      else group.push({ slot, query });
    }

    for (const [uri, group] of groups) {
      const source = texts.textFor(uri);
      if (source === undefined) {
        noText += group.length;
        continue;
      }
      const doc: SourceDocument = { uri, text: source.text, syntax: source.syntax };
      const backend = backends.find((candidate) => candidate.claims(doc));
      if (backend === undefined) {
        noBackend += group.length;
        continue;
      }

      parses += 1;
      const answers = backend.spansIn(
        doc,
        group.map((entry) => entry.query),
      );
      for (const [position, entry] of group.entries()) {
        const span = answers[position];
        if (span === undefined) notFound += 1;
        spans[entry.slot] = span;
      }
    }

    return spans;
  }

  return {
    spansFor,
    spanFor(request) {
      return spansFor([request])[0];
    },
    stats() {
      return { parses, noText, noBackend, notFound };
    },
  };
}

/**
 * Split an RFC 6901 pointer into its unescaped segments.
 *
 * Exported for backends, which all need the same decoding and must not
 * each invent it. `""` is the document root and yields no segments.
 * `~1` becomes `/` and `~0` becomes `~`, in that order, which is what
 * makes a path template key (`/orders/{id}`, stored as
 * `~1orders~1{id}`) survive the round trip.
 *
 * Percent sequences are left alone: a `check` finding's pointer is
 * already percent-decoded, so decoding again would corrupt a key that
 * genuinely contains `%20`.
 *
 * @public
 */
export function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

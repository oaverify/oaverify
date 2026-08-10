/**
 * Positions for `oaverify check --format sarif` (#610).
 *
 * The resolver takes text from its caller and nothing in the load path
 * retains any, so this is where the CLI answers "what were the bytes we
 * checked". It re-reads by URI, which is a claim rather than a fact:
 * correct for a file that has not changed since the run started, and
 * unavailable for a document that has no file.
 *
 * What each text source gets, and why:
 *
 * | Source | Region |
 * |---|---|
 * | file, absolute or relative | yes, re-read from disk |
 * | `file:` URL | yes, re-read from disk |
 * | stdin (`-`) | no: the stream was consumed by the load and cannot be rewound |
 * | `http:` / `https:` | no: re-fetching would be a second request, and could answer differently |
 * | a caller-supplied reader with no file behind it | no: nothing to read |
 *
 * Every "no" is a location that addresses its file exactly as it did
 * before regions existed. None of them degrades into a wrong position.
 *
 * @packageDocumentation
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSourceSpanResolver,
  STDIN_URI,
  type SourceSpan,
  type SourceSyntax,
  type SourceText,
  type SpanRequest,
} from "@oaverify/internal-spec";
import { createJsonSpanBackend, createYamlSpanBackend } from "@oaverify/syntax";
import type { CheckFinding } from "@oaverify/check";

/**
 * One map key for a document and a pointer within it.
 *
 * Joined by an escaped NUL, which neither a URI nor a pointer can
 * contain, so no pair of distinct addresses collides. Written as an
 * escape rather than as the character itself: a literal control byte in
 * a source file makes it a binary diff.
 */
function keyOf(at: SpanRequest): string {
  return `${at.uri}\u0000${at.pointer}`;
}

/** Every address and hop the SARIF emitter will ask about. */
function requestsIn(findings: readonly CheckFinding[]): SpanRequest[] {
  const seen = new Set<string>();
  const requests: SpanRequest[] = [];
  for (const finding of findings) {
    const source = finding.target?.source;
    if (source === undefined) continue;
    for (const at of [source, ...source.via]) {
      const key = keyOf(at);
      if (seen.has(key)) continue;
      seen.add(key);
      requests.push({ uri: at.uri, pointer: at.pointer });
    }
  }
  return requests;
}

/** The file a URI names, or `undefined` where it names no file. */
function pathFor(uri: string, base: string): string | undefined {
  if (uri === STDIN_URI) return undefined;
  if (/^https?:/i.test(uri)) return undefined;
  if (uri.startsWith("file:")) return fileURLToPath(uri);
  return isAbsolute(uri) ? uri : resolvePath(base, uri);
}

/**
 * What the caller says a document is written in.
 *
 * Only from the extension, and absent where there is none: a backend
 * seeing no syntax sniffs the text, which is a better guess than one
 * made here from the same information.
 */
function syntaxFor(uri: string): SourceSyntax | undefined {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  return undefined;
}

/**
 * A `spanOf` lookup for `renderSarif`, over the documents this run can
 * still read.
 *
 * Reads every document once, resolves every address and hop in one
 * batch, and answers from the result, so the cost is one read and one
 * parse per document rather than per finding. Returns `undefined` for
 * everything when no finding carries a source address, which is also
 * what a run without `provenance: true` produces.
 *
 * `want` is left at its default, so a region covers the value at the
 * pointer. A per-code choice of the key instead is a separate question:
 * it belongs with the rule that raised the finding, not here.
 *
 * @param findings - The findings that will be rendered.
 * @param readText - How to read a file; the command's own IO, so a test
 *   supplies its own filesystem.
 * @param base - Directory relative URIs resolve against. The same base
 *   the SARIF emitter relativises against, so a location and its region
 *   describe the same file.
 */
export async function spanLookupFor(
  findings: readonly CheckFinding[],
  readText: (path: string) => Promise<string>,
  base: string,
): Promise<(of: SpanRequest) => SourceSpan | undefined> {
  const requests = requestsIn(findings);
  if (requests.length === 0) return () => undefined;

  const texts = new Map<string, SourceText>();
  const uris = [...new Set(requests.map((request) => request.uri))];
  await Promise.all(
    uris.map(async (uri) => {
      const path = pathFor(uri, base);
      if (path === undefined) return;
      try {
        texts.set(uri, { text: await readText(path), syntax: syntaxFor(uri) });
      } catch {
        // A document that was readable during the load and is not now.
        // No region is the right answer; the finding keeps its file.
      }
    }),
  );
  if (texts.size === 0) return () => undefined;

  const resolver = createSourceSpanResolver({
    texts: { textFor: (uri) => texts.get(uri) },
    // YAML first, so an extension-less document that parses as either
    // is read the way the loader reads it.
    backends: [createYamlSpanBackend(), createJsonSpanBackend()],
  });

  const spans = new Map<string, SourceSpan>();
  for (const [index, span] of resolver.spansFor(requests).entries()) {
    const request = requests[index];
    if (span === undefined || request === undefined) continue;
    spans.set(keyOf(request), span);
  }

  return (of) => spans.get(keyOf(of));
}

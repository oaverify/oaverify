/**
 * Syntax support for `@oaverify/core`. Each implements
 * {@link @oaverify/core/spec!DocumentReader} and is designed to
 * be composed via
 * {@link @oaverify/core/spec!composeReaders}: order YAML readers
 * first so the JSON-only readers in `@oaverify/core/spec` act as the
 * fallback for `.json` paths.
 *
 * `@oaverify/core` intentionally doesn't carry YAML parsing so it can
 * advertise zero runtime dependencies; this package adds it, at the
 * cost of a dependency on `yaml`.
 *
 * @example
 * ```ts
 * import { composeReaders, createFileReader, loadSpec } from "@oaverify/core/spec";
 * import { createYamlFileReader } from "@oaverify/syntax";
 *
 * const reader = composeReaders([createYamlFileReader(), createFileReader()]);
 * const { document } = await loadSpec({ reader, entry: "openapi.yaml" });
 * ```
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import {
  loadSpecSync as loadSpecSyncCore,
  STDIN_URI,
  type DocumentReader,
  type FileReaderOptions,
  type HttpReaderOptions,
  type LoadSpecSyncOptions,
  type ResolvedSpec,
} from "@oaverify/internal-spec";
import {
  composeReadersSync,
  createFileReaderSync,
  fetchInit,
  readStream,
  assertWithinMaxBytes,
  assertWithinMaxBytesSync,
  resolveReadPath,
  resolveReadPathSync,
  responseText,
  trimStdinText,
  type SyncDocumentReader,
} from "@oaverify/internal-spec/internals";
import { parse as parseYaml, parseDocument as parseYamlNode } from "yaml";

function decodePercent(s: string): string {
  return s.replace(/%[0-9A-Fa-f]{2}/g, (m) => decodeURIComponent(m));
}

function hasYamlExtension(uri: string): boolean {
  const lower = uri.toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml");
}

/**
 * Read YAML files from the local filesystem. Only claims URIs whose
 * path ends in `.yaml` or `.yml`; compose with the main package's
 * `createFileReader` to cover JSON alongside.
 *
 * @param cwd - Optional base directory. Defaults to `process.cwd()`.
 *
 * @example
 * ```ts
 * import { composeReaders, createFileReader } from "@oaverify/core/spec";
 * import { createYamlFileReader } from "@oaverify/syntax";
 *
 * const reader = composeReaders([createYamlFileReader(), createFileReader()]);
 * ```
 *
 * @public
 */
export function createYamlFileReader(
  cwd: string = process.cwd(),
  options: FileReaderOptions = {},
): DocumentReader {
  const root = resolvePath(cwd);
  return {
    canRead(uri) {
      if (/^(https?|memory):/i.test(uri)) return false;
      return hasYamlExtension(uri);
    },
    async read(uri) {
      const stripped = uri.replace(/^file:\/\//, "");
      // `$ref` URIs are percent-encoded per RFC 3986, so a filesystem
      // path like "my spec.yaml" arrives here as "my%20spec.yaml".
      // Decode well-formed %XX escapes before hitting the disk; stray
      // `%` that isn't a valid escape passes through so it can match
      // a literal filename that actually contains one.
      const decoded = decodePercent(stripped);
      const path = await resolveReadPath(root, decoded, uri, options.confine === true);
      await assertWithinMaxBytes(path, uri, options.maxBytes);
      const raw = await readFile(path, "utf8");
      return parseYamlDocument(raw, uri);
    },
  };
}

/**
 * Parse YAML, refusing a source that carries no document.
 *
 * An empty file, a whitespace-only one, and one holding nothing but
 * comments all parse to `null`, and returning that hands the caller a
 * document-shaped hole: `loadSpecSync` answered `{ document: null }` and
 * threw nothing, so the failure surfaced later as something unrelated
 * (#850). The JSON sibling throws `Unexpected end of JSON input` on a
 * source with nothing in it, and these two readers should not disagree
 * about whether a file contained anything. They agree at the other end
 * too: a source that explicitly says `null`, `~` or `---` is a document
 * whose value is null, `JSON.parse` accepts that, and so does this.
 *
 * Deliberately narrow. This asks whether there is a document, not
 * whether it is a *spec*: a scalar, an array and a boolean all pass,
 * because JSON accepts `42` and `true` too and because a `$ref` target
 * is not always an object. Whether the entry document is an OpenAPI
 * document is `assertEntryDocument`'s question, one layer up, where the
 * caller's intent is known.
 */
function parseYamlDocument(source: string, uri: string): unknown {
  const parsed = parseYaml(source) as unknown;
  if (parsed !== null && parsed !== undefined) return parsed;

  // `null` here has two causes and only one is a mistake. A source with
  // no content node at all (empty, whitespace, comments) carries no
  // document. A source that says `null`, `~` or `---` is a document
  // whose value happens to be null, which `JSON.parse` accepts too, so
  // refusing it would make these readers disagree with their JSON
  // siblings on identical content. `parseDocument` tells the two apart,
  // and runs only on this path, which is the rare one.
  if (parseYamlNode(source).contents !== null) return parsed;

  throw new Error(`${uri} contains no document: it is empty, whitespace, or comments only.`);
}

/**
 * Read one document from standard input, JSON or YAML.
 *
 * Compose it at the **front** of the chain: `createFileReader`'s
 * `canRead` claims every non-HTTP, non-memory URI, so anything later
 * would take `-` and look for a file of that name.
 *
 * There is no extension to dispatch on, so the format is decided by a
 * stated rule rather than by sniffing:
 *
 * > Read the stream to completion, strip a BOM, trim leading
 * > whitespace. If the first character is `{`, parse as JSON.
 * > Otherwise parse as YAML.
 *
 * The whole stream has to be read before either parser can run, so the
 * rule costs nothing. Routing `{`-leading input to the JSON parser
 * rather than leaning on YAML being a JSON superset is deliberate:
 * YAML 1.2 flow mappings and JSON objects are not quite the same
 * grammar, and a JSON document should be parsed by the JSON parser.
 *
 * The one shape this decides against is a spec written in YAML flow
 * style at the top level (`{openapi: 3.1.0, ...}`), which is legal YAML
 * and vanishingly rare for a document anyone pipes. Write it as a file,
 * or as block-style YAML.
 *
 * The stream is read once and the parsed document memoised, since a
 * stream cannot be rewound.
 *
 * @param stdin - Optional stream to read. Defaults to `process.stdin`.
 * @returns A {@link @oaverify/core/spec!DocumentReader}.
 *
 * @example
 * ```ts
 * // redocly bundle openapi.yaml | oaverify check -
 * const reader = composeReaders([
 *   createYamlStdinReader(),
 *   createYamlFileReader(),
 *   createFileReader(),
 * ]);
 * ```
 *
 * @public
 */
export function createYamlStdinReader(stdin?: AsyncIterable<Uint8Array>): DocumentReader {
  let pending: Promise<unknown> | undefined;
  return {
    canRead(uri) {
      return uri === STDIN_URI;
    },
    async read(uri) {
      if (uri !== STDIN_URI) throw new Error(`stdin reader: ${uri} is not ${STDIN_URI}`);
      pending ??= (async () => {
        const text = trimStdinText(await readStream(stdin ?? process.stdin));
        if (text === "") throw new Error("stdin: no input");
        return text.startsWith("{") ? JSON.parse(text) : parseYamlDocument(text, "stdin");
      })();
      return pending;
    },
  };
}

function isYamlMime(mime: string): boolean {
  // application/yaml, application/x-yaml, text/yaml, text/x-yaml.
  return /^(?:application|text)\/(?:x-)?yaml$/i.test(mime);
}

function isJsonMime(mime: string): boolean {
  // application/json, text/json, application/vnd.openapi+json, etc.
  // The subtype prefix may carry dots (vnd.api+json), per RFC 6838.
  return /^(?:application|text)\/(?:\w[\w.-]*\+)?json$/i.test(mime);
}

/**
 * Read JSON-or-YAML OpenAPI documents over HTTP/HTTPS. Claims any
 * `http:` / `https:` URI; dispatches by response `Content-Type` with
 * URL extension as a fallback.
 *
 * Dispatch rules:
 * 1. `Content-Type` matches a YAML media type (`application/yaml`,
 *    `application/x-yaml`, `text/yaml`, `text/x-yaml`, any of the
 *    above with `; charset=...`) → parse as YAML.
 * 2. `Content-Type` matches a JSON media type (`application/json`,
 *    `text/json`, any `*+json` suffix like `application/vnd.api+json`)
 *    → parse as JSON.
 * 3. Ambiguous Content-Type (missing, `text/plain`,
 *    `application/octet-stream`, etc.) → fall back to the URL path
 *    extension: `.yaml` / `.yml` → YAML, else JSON.
 *
 * Handles the common case where the user points at
 * `https://api.example.com/openapi` (no extension) and the server
 * advertises YAML via its Content-Type.
 *
 * @example
 * ```ts
 * import { composeReaders, createFileReader } from "@oaverify/core/spec";
 * import { createSmartHttpReader } from "@oaverify/syntax";
 *
 * const reader = composeReaders([createSmartHttpReader(), createFileReader()]);
 * ```
 *
 * @public
 */
export function createSmartHttpReader(options: HttpReaderOptions = {}): DocumentReader {
  return {
    canRead(uri) {
      return /^https?:/i.test(uri);
    },
    async read(uri) {
      if (options.allowUri?.(uri) === false) {
        throw new Error(`${uri}: refused by allowUri`);
      }
      const init = fetchInit(options);
      const res = init === undefined ? await fetch(uri) : await fetch(uri, init);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${uri}`);
      const text = await responseText(res, uri, options.maxBytes);
      const contentType = res.headers.get("content-type") ?? "";
      const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
      if (isYamlMime(mime)) return parseYamlDocument(text, uri);
      if (isJsonMime(mime)) return JSON.parse(text);
      // Ambiguous Content-Type: use URL extension as the tiebreaker,
      // defaulting to JSON for extensionless URLs. A misconfigured
      // server that returns YAML with `text/plain` and a URL like
      // `/openapi` will fail with a JSON parse error; escape hatch is
      // to supply a `.yaml` suffix or plug in a custom reader.
      if (hasYamlExtension(uri)) return parseYamlDocument(text, uri);
      return JSON.parse(text);
    },
  };
}

/**
 * Parse a YAML string. Exposed so callers that drive the main
 * package's `createMemoryReader` with pre-parsed objects can convert
 * YAML sources once at setup time.
 *
 * Returns `unknown` because YAML is dynamic; cast to
 * {@link @oaverify/core!OpenAPIDocument} (or your own narrower type) when feeding
 * the result to `createValidator`.
 *
 * @example
 * ```ts
 * import { createValidator, type OpenAPIDocument } from "@oaverify/core";
 * import { parseYamlString } from "@oaverify/syntax";
 *
 * const spec = parseYamlString(yamlSource) as OpenAPIDocument;
 * const validator = createValidator(spec);
 * ```
 *
 * Raw parse semantics, unlike the readers. A source carrying no
 * document (empty, whitespace, or comments only) returns `null` here
 * rather than throwing, because this is the primitive a caller reaches
 * for when it wants the parser rather than a spec loader. The readers
 * behind `loadSpec` refuse that input instead, so the loaders cannot
 * hand back `{ document: null }` (#850). A caller feeding this function
 * a file it did not write should check the result before casting.
 *
 * @public
 */
export function parseYamlString(source: string): unknown {
  return parseYaml(source);
}

/**
 * Synchronous YAML filesystem reader: the sync counterpart of
 * {@link createYamlFileReader}, used as the default reader inside
 * {@link loadSpecSync}. Kept module-internal on purpose: the narrow
 * sync surface is `loadSpecSync` alone, which defaults its reader, so
 * the common case never names a reader. (The JSON sync primitives are
 * reachable via `@oaverify/core/spec/internals` for custom compose orders; a
 * caller needing YAML in a custom sync compose can pass `loadSpecSync`
 * a `reader` built from those plus their own YAML step.)
 */
function createYamlFileReaderSync(
  cwd: string = process.cwd(),
  options: FileReaderOptions = {},
): SyncDocumentReader {
  const root = resolvePath(cwd);
  return {
    canRead(uri) {
      if (/^(https?|memory):/i.test(uri)) return false;
      return hasYamlExtension(uri);
    },
    read(uri) {
      const stripped = uri.replace(/^file:\/\//, "");
      const decoded = decodePercent(stripped);
      const path = resolveReadPathSync(root, decoded, uri, options.confine === true);
      assertWithinMaxBytesSync(path, uri, options.maxBytes);
      return parseYamlDocument(readFileSync(path, "utf8"), uri);
    },
  };
}

/**
 * Synchronous spec loader with YAML support.
 * Same contract as {@link @oaverify/core/spec!loadSpecSync} from
 * `@oaverify/core`, but its default reader reads YAML and JSON files from
 * disk (the core loader is JSON-only), so `loadSpecSync({ entry:
 * "openapi.yaml" })` works without composing readers.
 *
 * For load-once-at-boot programs and CLIs that build a validator in a
 * synchronous bootstrap and can't await {@link @oaverify/core/spec!loadSpec}.
 * Blocking by construction (`readFileSync`); for boot-time / CLI use, not
 * per-request. For non-blocking contexts the async
 * {@link @oaverify/core/spec!loadSpec}
 * stays the right tool. An unreadable or malformed spec throws; a
 * caller wanting "unreadable spec disables validation rather than
 * crashing boot" wraps the call in its own `try`/`catch`.
 *
 * Pass `reader` to override the default (a `{ read, canRead }` object
 * satisfies the synchronous reader shape; the JSON-only primitives live
 * at `@oaverify/core/spec/internals`).
 *
 * @example
 * ```ts
 * import { createValidator } from "@oaverify/core";
 * import { loadSpecSync } from "@oaverify/syntax";
 *
 * const { document } = loadSpecSync({ entry: "openapi.yaml" });
 * const validator = createValidator(document);
 * ```
 *
 * @public
 */
export function loadSpecSync(options: LoadSpecSyncOptions): ResolvedSpec {
  const reader =
    options.reader ?? composeReadersSync([createYamlFileReaderSync(), createFileReaderSync()]);
  return loadSpecSyncCore({ ...options, reader });
}

export type { FileReaderOptions, HttpReaderOptions } from "@oaverify/internal-spec";
export { createYamlSpanBackend } from "./span.js";
export { createJsonSpanBackend } from "./json-span.js";

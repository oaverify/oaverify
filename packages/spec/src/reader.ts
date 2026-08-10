import { readFileSync, realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";

/**
 * Opaque reader that turns a URI into a parsed JSON-compatible value.
 * Multiple readers can be layered via {@link composeReaders} so the
 * resolver can accept different URI schemes uniformly.
 *
 * @public
 */
export interface DocumentReader {
  read(uri: string): Promise<unknown>;
  /** Returns true if this reader can handle the given URI. */
  canRead(uri: string): boolean;
}

function hasYamlExtension(uri: string): boolean {
  const lower = uri.toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml");
}

// The `root + sep` comparison is what keeps `/a/spec` from admitting
// `/a/spec-other`: a bare `startsWith(root)` would treat any sibling
// directory whose name extends the root as inside it.
function outsideRoot(root: string, path: string): boolean {
  return path !== root && !path.startsWith(root + sep);
}

function isMissingPath(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Resolve a decoded `$ref` path against the reader's root, enforcing
 * containment when asked.
 *
 * @internal
 */
export async function resolveReadPath(
  root: string,
  decoded: string,
  uri: string,
  confine: boolean,
): Promise<string> {
  const path = resolvePath(root, decoded);
  if (!confine) return path;
  if (outsideRoot(root, path)) {
    throw new Error(`${uri}: refusing to read outside ${root}`);
  }
  try {
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
    if (outsideRoot(realRoot, realPath)) {
      throw new Error(`${uri}: refusing to read outside ${root}`);
    }
  } catch (err) {
    if (!isMissingPath(err)) throw err;
  }
  return path;
}

/** @internal */
export function resolveReadPathSync(
  root: string,
  decoded: string,
  uri: string,
  confine: boolean,
): string {
  const path = resolvePath(root, decoded);
  if (!confine) return path;
  if (outsideRoot(root, path)) {
    throw new Error(`${uri}: refusing to read outside ${root}`);
  }
  try {
    const realRoot = realpathSync(root);
    const realPath = realpathSync(path);
    if (outsideRoot(realRoot, realPath)) {
      throw new Error(`${uri}: refusing to read outside ${root}`);
    }
  } catch (err) {
    if (!isMissingPath(err)) throw err;
  }
  return path;
}

const YAML_HINT =
  "@oaverify/core does not parse YAML directly. Install @oaverify/syntax " +
  "and compose createYamlFileReader() / createSmartHttpReader() ahead of the " +
  "JSON-only readers from @oaverify/core/spec.";

/**
 * Options for {@link createFileReader} and {@link createFileReaderSync}.
 *
 * @public
 */
export interface FileReaderOptions {
  /**
   * Refuse to read any path that is outside the reader's base
   * directory, both before and after resolving real paths. A symlink
   * that resolves inside the base directory is allowed; a symlink that
   * resolves outside it is refused.
   *
   * Off by default, because the base directory has never confined
   * reads and multi-file specs legitimately `$ref` across sibling
   * directories. Turn it on whenever the spec is untrusted: a `$ref` is
   * a file read, and `resolveSpec` hoists what it reads into the
   * resolved document, where it typically reaches a response body or a
   * log.
   */
  confine?: boolean;

  /**
   * Refuse to read a file larger than this many bytes.
   *
   * Unbounded by default, matching {@link HttpReaderOptions.maxBytes}.
   * Set it whenever the spec is untrusted: a `$ref` is a file read, and
   * `resolveSpec` hoists what it reads into the resolved document.
   *
   * Checked by size on disk before the read, so an oversized file is
   * never held in memory. A file that grows between the check and the
   * read is not caught; this bounds the ordinary case, not a racing
   * writer.
   */
  maxBytes?: number;
}

/**
 * Refuse a file larger than `maxBytes`, by size on disk.
 *
 * Shared with `@oaverify/syntax`'s file readers, which take the same
 * {@link FileReaderOptions}: an option one reader honours and another
 * ignores is worse than no option.
 *
 * @internal
 */
export async function assertWithinMaxBytes(
  path: string,
  uri: string,
  maxBytes: number | undefined,
): Promise<void> {
  if (maxBytes === undefined) return;
  const { size } = await stat(path);
  if (size > maxBytes) throw new Error(`${uri}: file exceeds maxBytes (${maxBytes})`);
}

/** Synchronous {@link assertWithinMaxBytes}. @internal */
export function assertWithinMaxBytesSync(
  path: string,
  uri: string,
  maxBytes: number | undefined,
): void {
  if (maxBytes === undefined) return;
  const { size } = statSync(path);
  if (size > maxBytes) throw new Error(`${uri}: file exceeds maxBytes (${maxBytes})`);
}

/**
 * Read files from the local filesystem. JSON only; `.yaml` / `.yml`
 * paths throw with a clear install hint. Pair with
 * `@oaverify/syntax`'s `createYamlFileReader` via
 * {@link composeReaders} for YAML support.
 *
 * The base directory is a resolution root, not a sandbox, unless
 * {@link FileReaderOptions.confine} is set.
 *
 * @param cwd - Optional base directory. Defaults to `process.cwd()`.
 * @param options - Optional containment controls. See {@link FileReaderOptions}.
 * @returns A {@link DocumentReader}.
 *
 * @example
 * ```ts
 * const reader = createFileReader("/abs/spec");
 * await reader.read("openapi.json");
 *
 * // Untrusted spec: refuse anything outside /abs/spec.
 * const confined = createFileReader("/abs/spec", { confine: true });
 * ```
 *
 * @public
 */
export function createFileReader(
  cwd: string = process.cwd(),
  options: FileReaderOptions = {},
): DocumentReader {
  const root = resolvePath(cwd);
  return {
    canRead(uri) {
      // Anything that isn't HTTP or memory; YAML paths we still claim
      // so we can produce the install-hint error rather than silently
      // passing to the next reader in a compose chain (would surface
      // as an opaque "no reader can handle" elsewhere).
      return !/^(https?|memory):/i.test(uri);
    },
    async read(uri) {
      const stripped = uri.replace(/^file:\/\//, "");
      // `$ref` URIs are percent-encoded per RFC 3986, so a filesystem
      // path like "my spec.json" arrives here as "my%20spec.json". Decode
      // well-formed %XX escapes before hitting the disk. Stray `%` that
      // isn't a valid escape passes through so it can match a literal
      // filename that actually contains one.
      const decoded = stripped.replace(/%[0-9A-Fa-f]{2}/g, (m) => decodeURIComponent(m));
      const path = await resolveReadPath(root, decoded, uri, options.confine === true);
      if (hasYamlExtension(path)) throw new Error(`${uri}: ${YAML_HINT}`);
      await assertWithinMaxBytes(path, uri, options.maxBytes);
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw);
    },
  };
}

/**
 * Options for {@link createHttpReader}.
 *
 * All four are inert by default, so an existing caller's behavior is
 * unchanged. Reach for them when the spec is untrusted: a `$ref` is an
 * outbound request, and `resolveSpec` hoists what it fetches into the
 * resolved document.
 *
 * @public
 */
export interface HttpReaderOptions {
  /**
   * Called with every URI before the request. Return false to refuse it.
   * Use for a scheme or host allowlist.
   *
   * An allowlist alone does not survive a redirect. `fetch` follows
   * redirects by default and this callback never sees the hop, so an
   * approved host that responds 302 can still send the reader to an
   * internal address. Pair it with `redirects: "error"` when the
   * allowlist is the control you are relying on.
   */
  allowUri?: (uri: string) => boolean;
  /**
   * How to treat an HTTP redirect. `"follow"` (the default) matches
   * `fetch`'s own default and every release through 5.1.0. `"error"`
   * refuses the response instead, which is what closes the
   * {@link HttpReaderOptions.allowUri} bypass above.
   */
  redirects?: "follow" | "error";
  /** Per-request timeout in milliseconds. Default: no timeout. */
  timeoutMs?: number;
  /**
   * Reject a response body larger than this many bytes while the body
   * is still streaming, before parsing it. Counted as streamed response
   * bytes rather than JS string length. Default: unbounded.
   */
  maxBytes?: number;
}

/**
 * Read documents over HTTP/HTTPS. JSON only; pair with
 * `@oaverify/syntax`'s `createSmartHttpReader` for YAML (it claims all
 * `http(s)` URIs and dispatches by `Content-Type`, so it shadows this
 * reader in a compose chain; that's fine; JSON endpoints still parse
 * as JSON there).
 *
 * @returns A {@link DocumentReader}.
 *
 * @example
 * ```ts
 * const reader = createHttpReader();
 * await reader.read("https://example.com/spec.json");
 * ```
 *
 * @public
 */
export function createHttpReader(options: HttpReaderOptions = {}): DocumentReader {
  return {
    canRead(uri) {
      return /^https?:/i.test(uri);
    },
    async read(uri) {
      if (hasYamlExtension(uri)) throw new Error(`${uri}: ${YAML_HINT}`);
      if (options.allowUri?.(uri) === false) {
        throw new Error(`${uri}: refused by allowUri`);
      }
      // With no controls set, call `fetch` exactly as before: no init
      // argument at all, so the default path is indistinguishable from
      // the pre-option behavior rather than merely equivalent to it.
      const init = fetchInit(options);
      const res = init === undefined ? await fetch(uri) : await fetch(uri, init);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${uri}`);
      const text = await responseText(res, uri, options.maxBytes);
      return JSON.parse(text);
    },
  };
}

/**
 * Build the `fetch` init for the transport-level controls, or
 * `undefined` when none are set. Shared by this package's HTTP reader
 * and `@oaverify/syntax`'s.
 *
 * @internal
 */
export function fetchInit(options: HttpReaderOptions): RequestInit | undefined {
  const wantsRedirectError = options.redirects === "error";
  if (!wantsRedirectError && options.timeoutMs === undefined) return undefined;
  return {
    ...(wantsRedirectError && { redirect: "error" as const }),
    ...(options.timeoutMs !== undefined && { signal: AbortSignal.timeout(options.timeoutMs) }),
  };
}

/**
 * Read a response body, enforcing {@link HttpReaderOptions.maxBytes}
 * while bytes are still streaming in.
 *
 * @internal
 */
export async function responseText(
  res: Response,
  uri: string,
  maxBytes: number | undefined,
): Promise<string> {
  if (maxBytes === undefined) return res.text();
  const body = res.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${uri}: response exceeds maxBytes (${maxBytes})`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

/**
 * In-memory reader, keyed by string URI. Primarily used in tests.
 * String sources are parsed as JSON; pre-parsed object sources pass
 * through. YAML strings need pre-parsing via
 * `@oaverify/syntax`'s `parseYamlString` before they're added to
 * the map.
 *
 * @param sources - Map of URI → JSON string (or already-parsed value).
 * @returns A {@link DocumentReader}.
 *
 * @example
 * ```ts
 * const reader = createMemoryReader(new Map([
 *   ["main.json", '{"openapi":"3.1.0","info":{"title":"X","version":"1"}}'],
 * ]));
 * ```
 *
 * @public
 */
export function createMemoryReader(sources: Map<string, unknown>): DocumentReader {
  return {
    canRead(uri) {
      return sources.has(uri);
    },
    async read(uri) {
      const source = sources.get(uri);
      if (source === undefined) throw new Error(`memory reader: no entry for ${uri}`);
      if (typeof source !== "string") return source;
      if (hasYamlExtension(uri)) throw new Error(`${uri}: ${YAML_HINT}`);
      return JSON.parse(source);
    },
  };
}

/**
 * The URI that means standard input.
 *
 * A single `-`, matching the convention the CLI already uses for
 * `--body` and `--request`. It is not a path and never reaches the
 * filesystem, so a file literally named `-` is unreachable through
 * this reader; refer to it as `./-`.
 *
 * @public
 */
export const STDIN_URI = "-";

/**
 * Read one document from standard input. JSON only; pair with
 * `@oaverify/syntax`'s `createYamlStdinReader` via {@link composeReaders}
 * for YAML support.
 *
 * Compose it **ahead of** {@link createFileReader}, whose `canRead`
 * claims every non-HTTP, non-memory URI and would otherwise take `-`
 * and look for a file of that name.
 *
 * The stream is read once and the parsed document memoised. A stream
 * cannot be rewound, so a second read would return an empty document
 * rather than an error; `resolveSpec` caches by URI and would not ask
 * twice today, but a reader that can only be consumed once should say
 * so by construction rather than rely on its caller.
 *
 * Relative `$ref`s in a piped document resolve against the working
 * directory, since `-` has no directory of its own. Bundled specs are
 * self-contained, so this rarely comes up; when it does, pass the
 * document through a file instead.
 *
 * @param stdin - Optional stream to read. Defaults to `process.stdin`.
 * @returns A {@link DocumentReader}.
 *
 * @example
 * ```ts
 * // redocly bundle openapi.yaml | oaverify check -
 * const reader = composeReaders([createStdinReader(), createFileReader()]);
 * ```
 *
 * @public
 */
export function createStdinReader(stdin?: AsyncIterable<Uint8Array>): DocumentReader {
  let pending: Promise<unknown> | undefined;
  return {
    canRead(uri) {
      return uri === STDIN_URI;
    },
    async read(uri) {
      if (uri !== STDIN_URI) throw new Error(`stdin reader: ${uri} is not ${STDIN_URI}`);
      pending ??= (async () => {
        const text = await readStream(stdin ?? process.stdin);
        return parseJsonFromStdin(text);
      })();
      return pending;
    },
  };
}

/**
 * Strip a UTF-8 BOM and leading whitespace.
 *
 * Shared with the YAML side, which needs the same normalisation before
 * it can look at the first character.
 *
 * @internal
 */
export function trimStdinText(text: string): string {
  // 0xFEFF as a code point rather than a literal BOM character, which
  // would be invisible in this file.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body.replace(/^\s+/, "");
}

function parseJsonFromStdin(text: string): unknown {
  const trimmed = trimStdinText(text);
  if (trimmed === "") throw new Error("stdin: no input");
  if (!trimmed.startsWith("{")) {
    // The format rule is stated rather than sniffed, so a YAML document
    // arriving at the JSON-only reader gets the install hint the file
    // readers give, not a parse error about an unexpected token.
    throw new Error(`stdin: ${YAML_HINT}`);
  }
  return JSON.parse(trimmed);
}

/**
 * Collect a byte stream into a string.
 *
 * @internal
 */
export async function readStream(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

/**
 * Try each reader in order until one accepts the URI. Useful for mixing
 * file / HTTP / memory sources in a single resolver, and for layering
 * the YAML readers from `@oaverify/syntax` ahead of the
 * JSON-only ones here.
 *
 * @param readers - Ordered list of readers.
 * @returns A composite {@link DocumentReader}.
 *
 * @example
 * ```ts
 * import { createYamlFileReader } from "@oaverify/syntax";
 * const reader = composeReaders([createYamlFileReader(), createFileReader()]);
 * ```
 *
 * @public
 */
export function composeReaders(readers: DocumentReader[]): DocumentReader {
  return {
    canRead(uri) {
      return readers.some((r) => r.canRead(uri));
    },
    async read(uri) {
      for (const r of readers) {
        if (r.canRead(uri)) return r.read(uri);
      }
      throw new Error(`no reader can handle ${uri}`);
    },
  };
}

// --- Synchronous readers --------------------------------------------------
//
// The sync surface backs `loadSpecSync` (boot-time / CLI use). It is
// intentionally NOT exported from the package barrel: only `loadSpecSync`
// is public, and it defaults its reader so the common case needs no
// reader composition. These primitives are reachable via
// `@oaverify/core/spec/internals` for the rare caller who needs a
// custom sync compose order, and are not covered by semver. See the note on
// `SyncDocumentReader` for why this stays a deliberately narrow seam.

/**
 * Synchronous counterpart of {@link DocumentReader}: same `canRead`
 * predicate, but `read` returns the parsed value directly instead of a
 * `Promise`. Backs the synchronous spec loader, which exists for
 * load-once-at-boot programs and CLIs that can't await.
 *
 * The shape is deliberately the async interface with the `Promise`
 * removed from `read`, so a future decision to make custom sync readers
 * a public, supported extension point is a pure-additive `export` of
 * this type rather than a redesign. Because TypeScript is structural, a
 * caller can already satisfy it today with a `{ read, canRead }` object
 * literal passed to `loadSpecSync`'s optional `reader`, without this
 * name being exported.
 */
export interface SyncDocumentReader {
  read(uri: string): unknown;
  /** Returns true if this reader can handle the given URI. */
  canRead(uri: string): boolean;
}

/**
 * Synchronous {@link createFileReader}. Blocking `readFileSync`; JSON
 * only, with the same YAML install-hint as the async reader. For
 * boot-time / CLI loads, not per-request; use the async
 * {@link createFileReader} for non-blocking contexts.
 */
export function createFileReaderSync(
  cwd: string = process.cwd(),
  options: FileReaderOptions = {},
): SyncDocumentReader {
  const root = resolvePath(cwd);
  return {
    canRead(uri) {
      return !/^(https?|memory):/i.test(uri);
    },
    read(uri) {
      const stripped = uri.replace(/^file:\/\//, "");
      const decoded = stripped.replace(/%[0-9A-Fa-f]{2}/g, (m) => decodeURIComponent(m));
      const path = resolveReadPathSync(root, decoded, uri, options.confine === true);
      if (hasYamlExtension(path)) throw new Error(`${uri}: ${YAML_HINT}`);
      assertWithinMaxBytesSync(path, uri, options.maxBytes);
      const raw = readFileSync(path, "utf8");
      return JSON.parse(raw);
    },
  };
}

/**
 * Synchronous {@link composeReaders}: try each {@link SyncDocumentReader}
 * in order until one accepts the URI.
 */
export function composeReadersSync(readers: SyncDocumentReader[]): SyncDocumentReader {
  return {
    canRead(uri) {
      return readers.some((r) => r.canRead(uri));
    },
    read(uri) {
      for (const r of readers) {
        if (r.canRead(uri)) return r.read(uri);
      }
      throw new Error(`no reader can handle ${uri}`);
    },
  };
}

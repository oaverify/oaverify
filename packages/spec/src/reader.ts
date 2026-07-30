import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

/**
 * Resolve a decoded `$ref` path against the reader's root, enforcing
 * containment when asked.
 *
 * The `root + sep` comparison is what keeps `/a/spec` from admitting
 * `/a/spec-other`: a bare `startsWith(root)` would treat any sibling
 * directory whose name extends the root as inside it.
 */
function resolveReadPath(root: string, decoded: string, uri: string, confine: boolean): string {
  const path = resolvePath(root, decoded);
  if (confine && path !== root && !path.startsWith(root + sep)) {
    throw new Error(`${uri}: refusing to read outside ${root}`);
  }
  return path;
}

const YAML_HINT =
  "@oaverify/core does not parse YAML directly. Install @oaverify/yaml " +
  "and compose createYamlFileReader() / createSmartHttpReader() ahead of the " +
  "JSON-only readers from @oaverify/core/spec.";

/**
 * Options for {@link createFileReader} and {@link createFileReaderSync}.
 *
 * @public
 */
export interface FileReaderOptions {
  /**
   * Refuse to read any path that resolves outside the reader's base
   * directory, whether by `../` traversal or by an absolute path.
   *
   * Off by default, because the base directory has never confined
   * reads and multi-file specs legitimately `$ref` across sibling
   * directories. Turn it on whenever the spec is untrusted: a `$ref` is
   * a file read, and `resolveSpec` hoists what it reads into the
   * resolved document, where it typically reaches a response body or a
   * log.
   */
  confine?: boolean;
}

/**
 * Read files from the local filesystem. JSON only; `.yaml` / `.yml`
 * paths throw with a clear install hint. Pair with
 * `@oaverify/yaml`'s `createYamlFileReader` via
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
      const path = resolveReadPath(root, decoded, uri, options.confine === true);
      if (hasYamlExtension(path)) throw new Error(`${uri}: ${YAML_HINT}`);
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
   * Reject a response body larger than this many bytes. Counted as
   * UTF-8 bytes, so it matches what crossed the wire rather than the
   * JS string length. Default: unbounded.
   */
  maxBytes?: number;
}

/**
 * Read documents over HTTP/HTTPS. JSON only; pair with
 * `@oaverify/yaml`'s `createSmartHttpReader` for YAML (it claims all
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
      const text = await res.text();
      if (options.maxBytes !== undefined && byteLength(text) > options.maxBytes) {
        throw new Error(`${uri}: response exceeds maxBytes (${options.maxBytes})`);
      }
      return JSON.parse(text);
    },
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Build the `fetch` init for the transport-level controls, or
 * `undefined` when none are set. Shared by this package's HTTP reader
 * and `@oaverify/yaml`'s.
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
 * In-memory reader, keyed by string URI. Primarily used in tests.
 * String sources are parsed as JSON; pre-parsed object sources pass
 * through. YAML strings need pre-parsing via
 * `@oaverify/yaml`'s `parseYamlString` before they're added to
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
 * Try each reader in order until one accepts the URI. Useful for mixing
 * file / HTTP / memory sources in a single resolver, and for layering
 * the YAML readers from `@oaverify/yaml` ahead of the
 * JSON-only ones here.
 *
 * @param readers - Ordered list of readers.
 * @returns A composite {@link DocumentReader}.
 *
 * @example
 * ```ts
 * import { createYamlFileReader } from "@oaverify/yaml";
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
      const path = resolveReadPath(root, decoded, uri, options.confine === true);
      if (hasYamlExtension(path)) throw new Error(`${uri}: ${YAML_HINT}`);
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

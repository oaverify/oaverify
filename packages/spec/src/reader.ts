import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

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

const YAML_HINT =
  "@aahoughton/oav-core does not parse YAML directly. Install @aahoughton/oav-yaml " +
  "and compose createYamlFileReader() / createSmartHttpReader() ahead of the " +
  "JSON-only readers from @aahoughton/oav-core/spec.";

/**
 * Read files from the local filesystem. JSON only; `.yaml` / `.yml`
 * paths throw with a clear install hint. Pair with
 * `oav`' `createYamlFileReader` via
 * {@link composeReaders} for YAML support.
 *
 * @param cwd - Optional base directory. Defaults to `process.cwd()`.
 * @returns A {@link DocumentReader}.
 *
 * @example
 * ```ts
 * const reader = createFileReader("/abs/spec");
 * await reader.read("openapi.json");
 * ```
 *
 * @public
 */
export function createFileReader(cwd: string = process.cwd()): DocumentReader {
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
      const path = resolvePath(cwd, decoded);
      if (hasYamlExtension(path)) throw new Error(`${uri}: ${YAML_HINT}`);
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw);
    },
  };
}

/**
 * Read documents over HTTP/HTTPS. JSON only; pair with
 * `oav`'s `createSmartHttpReader` for YAML (it claims all
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
export function createHttpReader(): DocumentReader {
  return {
    canRead(uri) {
      return /^https?:/i.test(uri);
    },
    async read(uri) {
      if (hasYamlExtension(uri)) throw new Error(`${uri}: ${YAML_HINT}`);
      const res = await fetch(uri);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${uri}`);
      const text = await res.text();
      return JSON.parse(text);
    },
  };
}

/**
 * In-memory reader, keyed by string URI. Primarily used in tests.
 * String sources are parsed as JSON; pre-parsed object sources pass
 * through. YAML strings need pre-parsing via
 * `oav`' `parseYamlString` before they're added to
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
 * the YAML readers from `oav` ahead of the
 * JSON-only ones here.
 *
 * @param readers - Ordered list of readers.
 * @returns A composite {@link DocumentReader}.
 *
 * @example
 * ```ts
 * import { createYamlFileReader } from "@aahoughton/oav";
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
// `oav/spec/internals` for the rare caller who needs a custom sync
// compose order, and are not covered by semver. See the note on
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
export function createFileReaderSync(cwd: string = process.cwd()): SyncDocumentReader {
  return {
    canRead(uri) {
      return !/^(https?|memory):/i.test(uri);
    },
    read(uri) {
      const stripped = uri.replace(/^file:\/\//, "");
      const decoded = stripped.replace(/%[0-9A-Fa-f]{2}/g, (m) => decodeURIComponent(m));
      const path = resolvePath(cwd, decoded);
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

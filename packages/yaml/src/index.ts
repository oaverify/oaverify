/**
 * YAML readers for `oav-core`. Each implements
 * {@link @aahoughton/oav-core/spec!DocumentReader} and is designed to
 * be composed via
 * {@link @aahoughton/oav-core/spec!composeReaders}: order YAML readers
 * first so the JSON-only readers in `oav-core/spec` act as the
 * fallback for `.json` paths.
 *
 * `oav-core` intentionally doesn't carry YAML parsing so it can
 * advertise zero runtime dependencies; this package adds it, at the
 * cost of a dependency on `yaml`.
 *
 * @example
 * ```ts
 * import { composeReaders, createFileReader, loadSpec } from "@aahoughton/oav-core/spec";
 * import { createYamlFileReader } from "@aahoughton/oav-yaml";
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
  type DocumentReader,
  type LoadSpecSyncOptions,
  type ResolvedSpec,
} from "@oav/spec";
import {
  composeReadersSync,
  createFileReaderSync,
  type SyncDocumentReader,
} from "@oav/spec/internals";
import { parse as parseYaml } from "yaml";

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
 * import { composeReaders, createFileReader } from "@aahoughton/oav-core/spec";
 * import { createYamlFileReader } from "@aahoughton/oav-yaml";
 *
 * const reader = composeReaders([createYamlFileReader(), createFileReader()]);
 * ```
 *
 * @public
 */
export function createYamlFileReader(cwd: string = process.cwd()): DocumentReader {
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
      const path = resolvePath(cwd, decoded);
      const raw = await readFile(path, "utf8");
      return parseYaml(raw);
    },
  };
}

function isYamlMime(mime: string): boolean {
  // application/yaml, application/x-yaml, text/yaml, text/x-yaml.
  return /^(?:application|text)\/(?:x-)?yaml$/i.test(mime);
}

function isJsonMime(mime: string): boolean {
  // application/json, text/json, application/vnd.openapi+json, etc.
  return /^(?:application|text)\/(?:\w[\w-]*\+)?json$/i.test(mime);
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
 * import { composeReaders, createFileReader } from "@aahoughton/oav-core/spec";
 * import { createSmartHttpReader } from "@aahoughton/oav-yaml";
 *
 * const reader = composeReaders([createSmartHttpReader(), createFileReader()]);
 * ```
 *
 * @public
 */
export function createSmartHttpReader(): DocumentReader {
  return {
    canRead(uri) {
      return /^https?:/i.test(uri);
    },
    async read(uri) {
      const res = await fetch(uri);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${uri}`);
      const text = await res.text();
      const contentType = res.headers.get("content-type") ?? "";
      const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
      if (isYamlMime(mime)) return parseYaml(text);
      if (isJsonMime(mime)) return JSON.parse(text);
      // Ambiguous Content-Type: use URL extension as the tiebreaker,
      // defaulting to JSON for extensionless URLs. A misconfigured
      // server that returns YAML with `text/plain` and a URL like
      // `/openapi` will fail with a JSON parse error; escape hatch is
      // to supply a `.yaml` suffix or plug in a custom reader.
      if (hasYamlExtension(uri)) return parseYaml(text);
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
 * {@link OpenAPIDocument} (or your own narrower type) when feeding
 * the result to `createValidator`.
 *
 * @example
 * ```ts
 * import { createValidator, type OpenAPIDocument } from "@aahoughton/oav-core";
 * import { parseYamlString } from "@aahoughton/oav-yaml";
 *
 * const spec = parseYamlString(yamlSource) as OpenAPIDocument;
 * const validator = createValidator(spec);
 * ```
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
 * reachable via `oav-core/spec/internals` for custom compose orders; a
 * caller needing YAML in a custom sync compose can pass `loadSpecSync`
 * a `reader` built from those plus their own YAML step.)
 */
function createYamlFileReaderSync(cwd: string = process.cwd()): SyncDocumentReader {
  return {
    canRead(uri) {
      if (/^(https?|memory):/i.test(uri)) return false;
      return hasYamlExtension(uri);
    },
    read(uri) {
      const stripped = uri.replace(/^file:\/\//, "");
      const decoded = decodePercent(stripped);
      const path = resolvePath(cwd, decoded);
      return parseYaml(readFileSync(path, "utf8"));
    },
  };
}

/**
 * Synchronous spec loader with YAML support.
 * Same contract as {@link @aahoughton/oav-core/spec!loadSpecSync} from
 * `oav-core`, but its default reader reads YAML and JSON files from
 * disk (the core loader is JSON-only), so `loadSpecSync({ entry:
 * "openapi.yaml" })` works without composing readers.
 *
 * For load-once-at-boot programs and CLIs that build a validator in a
 * synchronous bootstrap and can't await {@link loadSpec}. Blocking by
 * construction (`readFileSync`); for boot-time / CLI use, not
 * per-request. For non-blocking contexts the async {@link loadSpec}
 * stays the right tool. An unreadable or malformed spec throws; a
 * caller wanting "unreadable spec disables validation rather than
 * crashing boot" wraps the call in its own `try`/`catch`.
 *
 * Pass `reader` to override the default (a `{ read, canRead }` object
 * satisfies the synchronous reader shape; the JSON-only primitives live
 * at `oav-core/spec/internals`).
 *
 * @example
 * ```ts
 * import { createValidator } from "@aahoughton/oav-core";
 * import { loadSpecSync } from "@aahoughton/oav-yaml";
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

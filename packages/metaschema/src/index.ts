/**
 * The published OpenAPI meta-schemas, pinned per version, plus the
 * dispatch that picks one for a document.
 *
 * OpenAPI publishes a JSON Schema describing conformant documents of
 * each version. Compiling it and validating a user's document against
 * it is document conformance for free: the rules come from OpenAPI
 * rather than from hand-written checks that drift from the spec.
 *
 * How much of the **Schema Object** a meta-schema covers depends on the
 * version, and it decides how this pass divides with the compiler's
 * well-formedness pass:
 *
 * - **3.1 / 3.2** stub it entirely (`type: ["object", "boolean"]`,
 *   reached through `$dynamicRef` so a dialect can be swapped in) and
 *   say so in their own `description`: they describe documents
 *   *"without schema validation"*. 3.1 aligned the Schema Object with
 *   JSON Schema 2020-12, so there was nothing left to restate. The two
 *   passes are disjoint.
 * - **3.0** describes it in full, because a 3.0 Schema Object is a
 *   bespoke subset rather than JSON Schema, so OpenAPI had to spell out
 *   all 35 fields. Here the two passes **overlap**: both have an
 *   opinion about `type: Boolean` or an array-valued `items`. A caller
 *   reporting both needs a precedence rule, or the same defect is
 *   printed twice.
 *
 * The overlap is not a defect in either pass. It follows from 3.0's
 * Schema Object not being JSON Schema, and it means 3.0 documents get
 * *more* from the meta-schema than 3.1 documents do.
 *
 * @packageDocumentation
 */

import oas30 from "./vendor/oas-3.0.json" with { type: "json" };
import oas31 from "./vendor/oas-3.1.json" with { type: "json" };
import oas32 from "./vendor/oas-3.2.json" with { type: "json" };

/**
 * The OpenAPI minor versions with a meta-schema pinned here. Patch
 * versions share one schema: the published documents constrain
 * `openapi` by pattern (`^3\.1\.\d+(-.+)?$`), so 3.1.0 and 3.1.1 are
 * the same document shape.
 *
 * @public
 */
export type MetaschemaVersion = "3.0" | "3.1" | "3.2";

/**
 * Which upstream revision each vendored schema was taken from.
 *
 * Pinned rather than fetched, deliberately. A `check` verdict that
 * changes because OpenAPI republished, with no change on our side and
 * nothing in the diff, is the kind of surprise this codebase avoids by
 * policy. Updating is a visible commit: refresh the file, re-run the
 * tests, review what moved.
 *
 * @public
 */
export const METASCHEMA_REVISIONS: Readonly<Record<MetaschemaVersion, string>> = Object.freeze({
  // Two revisions have ever been published for 3.0, and they differ only
  // by a semantically equivalent `ParameterLocation` refactor. The 3.0
  // line is closed, so this pin is expected to age well.
  "3.0": "2021-09-28",
  "3.1": "2022-10-07",
  "3.2": "2025-09-17",
});

/**
 * Source URLs for {@link METASCHEMA_REVISIONS}, so a drift check can
 * re-fetch without rebuilding the URL shape by hand.
 *
 * @public
 */
export function metaschemaUrl(version: MetaschemaVersion): string {
  return `https://spec.openapis.org/oas/${version}/schema/${METASCHEMA_REVISIONS[version]}`;
}

// `unknown` rather than a schema type: these are vendored documents, and
// typing them as SchemaObject would invite edits. They are inputs.
const BY_VERSION: Readonly<Record<MetaschemaVersion, unknown>> = Object.freeze({
  "3.0": oas30,
  "3.1": oas31,
  "3.2": oas32,
});

/**
 * The pinned meta-schema for an OpenAPI minor version.
 *
 * @public
 */
export function metaschemaFor(version: MetaschemaVersion): unknown {
  return BY_VERSION[version];
}

/**
 * Read the minor version off a document's `openapi` string.
 *
 * Returns `undefined` for anything not recognised, including Swagger
 * 2.0 and a 3.3 that does not exist yet. Callers decide what to do with
 * that; guessing a schema for an unknown version would validate the
 * document against rules it never claimed to follow, and every error
 * downstream of that guess would be noise.
 *
 * @param document - A parsed OpenAPI document.
 * @returns The matching {@link MetaschemaVersion}, or `undefined`.
 *
 * @example
 * ```ts
 * metaschemaVersionOf({ openapi: "3.1.0" }); // "3.1"
 * metaschemaVersionOf({ swagger: "2.0" });   // undefined
 * ```
 *
 * @public
 */
export function metaschemaVersionOf(document: unknown): MetaschemaVersion | undefined {
  if (typeof document !== "object" || document === null) return undefined;
  const declared = (document as { openapi?: unknown }).openapi;
  if (typeof declared !== "string") return undefined;
  // Match on the minor version only. The schema itself re-checks the
  // full string via `pattern`, so a malformed "3.1" or "3.1.x" is
  // reported by the schema with a located error rather than being
  // rejected here with a worse one.
  const m = /^(3\.[012])(?:\.|$)/.exec(declared);
  const minor = m?.[1];
  return minor === "3.0" || minor === "3.1" || minor === "3.2" ? minor : undefined;
}

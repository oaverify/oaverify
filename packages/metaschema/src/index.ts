/**
 * The published OpenAPI meta-schemas, pinned per version, plus the
 * dispatch that picks one for a document.
 *
 * OpenAPI publishes a JSON Schema describing conformant documents of
 * each version. Compiling it and validating a user's document against it
 * gives document conformance whose rules are OpenAPI's rather than
 * independently hand-written here, so they do not drift from the spec the
 * way a hand-maintained rule set does.
 *
 * With one qualification, since it is easy to read that as stronger than
 * it is. 3.1 and 3.2 are vendored byte-identical to the published
 * documents. **3.0 is derived from one**: it is published as draft-04 and
 * the compiler implements 2020-12, so `scripts/convert-oas30.mjs`
 * translates it. The translation is three mechanical edits and refuses
 * anything it does not understand, but the artifact is our output rather
 * than OpenAPI's, and a bug there would be ours.
 *
 * Nothing here compiles or validates. This package holds the documents
 * and answers which one applies; the surface that reports findings is
 * separate.
 *
 * How much of the **Schema Object** a meta-schema covers depends on the
 * version, and it decides how a caller should combine these documents
 * with the compiler's well-formedness pass:
 *
 * - **3.1 / 3.2** stub it entirely (`type: ["object", "boolean"]`,
 *   reached through `$dynamicRef` so a dialect can be swapped in) and
 *   say so in their own `description`: they describe documents
 *   *"without schema validation"*. 3.1 aligned the Schema Object with
 *   JSON Schema 2020-12, so there was nothing left to restate. The two
 *   are disjoint.
 * - **3.0** describes it in full, because a 3.0 Schema Object is a
 *   bespoke subset rather than JSON Schema, so OpenAPI had to spell out
 *   all 35 fields. Here the two **overlap**: both have an
 *   opinion about `type: Boolean` or an array-valued `items`. A caller
 *   reporting both needs a precedence rule, or the same defect is
 *   printed twice.
 *
 * The overlap is not a defect in either place. It follows from 3.0's
 * Schema Object not being JSON Schema, and it means 3.0 documents get
 * *more* from the meta-schema than 3.1 documents do.
 *
 * @packageDocumentation
 */

import { detectOpenAPIVersion, type OpenAPIVersion } from "@oaverify/internal-core";

import oas30 from "./vendor/oas-3.0.json" with { type: "json" };
import oas31 from "./vendor/oas-3.1.json" with { type: "json" };
import oas32 from "./vendor/oas-3.2.json" with { type: "json" };

/**
 * The OpenAPI minor versions with a meta-schema pinned here. Patch
 * versions share one schema: the published documents constrain
 * `openapi` by pattern (`^3\.1\.\d+(-.+)?$`), so 3.1.0 and 3.1.1 are
 * the same document shape.
 *
 * A subset of {@link OpenAPIVersion} rather than a re-spelling of it.
 * They happen to coincide today. They are different questions, though:
 * one is "can the validator handle this document", the other is "have we
 * vendored a schema for it". A version supported before its schema is
 * vendored is expressible here rather than being a contradiction.
 *
 * @public
 */
export type MetaschemaVersion = Extract<OpenAPIVersion, "3.0" | "3.1" | "3.2">;

/**
 * The versions {@link metaschemaFor} can serve, as a value, so the
 * membership test in {@link metaschemaVersionOf} cannot drift from the
 * documents actually vendored.
 */
const VENDORED: readonly MetaschemaVersion[] = ["3.0", "3.1", "3.2"];

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
  // Each is the newest revision published at the time of pinning.
  // Two revisions have ever been published for 3.0, and they differ only
  // by a semantically equivalent `ParameterLocation` refactor. The 3.0
  // line is closed, so this pin is expected to age well.
  "3.0": "2024-10-18",
  "3.1": "2025-11-23",
  "3.2": "2025-11-23",
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
//
// Deliberately NOT `Object.freeze`d, which costs 101KB. `Object.freeze`
// is a call, so a bundler has to preserve it, and preserving it retains
// every JSON import it references. Measured with esbuild: importing
// `metaschemaVersionOf` alone, which touches no schema at all, pulled
// 101,593 bytes with the freeze and 514 without it. `Readonly<>` gives
// the guarantee that matters here (nobody reassigns a slot by accident)
// at compile time and at no runtime cost.
const BY_VERSION: Readonly<Record<MetaschemaVersion, unknown>> = {
  "3.0": oas30,
  "3.1": oas31,
  "3.2": oas32,
};

/**
 * The pinned meta-schema for an OpenAPI minor version.
 *
 * @public
 */
export function metaschemaFor(version: MetaschemaVersion): unknown {
  return BY_VERSION[version];
}

/**
 * Which vendored meta-schema applies to a document, if any.
 *
 * Version detection is {@link detectOpenAPIVersion}, deliberately: a
 * second detector here would drift from the one the validator dispatches
 * on, and the two disagreeing about what a document *is* would be a
 * miserable bug to find. This adds only the question that detector
 * cannot answer, which is whether a schema is vendored for the version
 * it found.
 *
 * `undefined` covers three different situations on purpose: no
 * recognisable `major.minor` prefix (Swagger 2.0, a non-string), a 3.x
 * line we do not support, and a supported version with no vendored
 * schema. A caller wanting to tell them apart should call
 * {@link detectOpenAPIVersion} itself.
 *
 * Note that a malformed value is not automatically one of those. `3.1`
 * and `3.1.x` are not valid `openapi` strings, and both still dispatch
 * to the 3.1 schema, which reports the `pattern` failure with a located
 * error naming the offending value. Guessing a schema for an
 * unrecognised version would validate the document against rules it
 * never claimed to follow, and every error downstream of that guess
 * would be noise.
 *
 * @param document - A parsed OpenAPI document.
 * @returns The matching {@link MetaschemaVersion}, or `undefined`.
 *
 * @example
 * ```ts
 * metaschemaVersionOf({ openapi: "3.1.0" });    // "3.1"
 * metaschemaVersionOf({ openapi: "3.2.0-rc1" }); // "3.2"
 * metaschemaVersionOf({ swagger: "2.0" });      // undefined
 * ```
 *
 * @public
 */
export function metaschemaVersionOf(document: unknown): MetaschemaVersion | undefined {
  const detected = detectOpenAPIVersion(document);
  return detected !== undefined && (VENDORED as readonly string[]).includes(detected)
    ? (detected as MetaschemaVersion)
    : undefined;
}

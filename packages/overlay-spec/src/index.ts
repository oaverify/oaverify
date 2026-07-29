/**
 * Translator from OpenAPI Overlay 1.0 spec-format documents to
 * `@oaverify/core/spec`'s typed `SpecOverlay`. The runtime does not ship a
 * JSONPath engine; it matches `target` strings against a closed set
 * of shapes documented in this package's README and throws a
 * locating error on anything outside that set.
 *
 * Two entry points:
 *
 *   translateOverlay(doc): SpecOverlay
 *     // Parses doc.actions one by one and returns the aggregated
 *     // typed overlay. Pure: no document is touched.
 *
 *   applySpecOverlay(base, doc): OpenAPIDocument
 *     // Convenience: translate then delegate to `applyOverlays`.
 *
 * @packageDocumentation
 */

import type { JsonValue, OpenAPIDocument } from "@oaverify/internal-core";
import { applyOverlays, type SpecOverlay } from "@oaverify/internal-spec";
import { applyAction, type NormalizedAction } from "./translate.js";
import { UnrecognisedTargetError } from "./parse-target.js";

export { UnrecognisedTargetError } from "./parse-target.js";

/**
 * One action from an OpenAPI Overlay 1.0 document. Either `update`
 * carries an additive / merging payload, or `remove: true` zeroes the
 * target. Setting both on the same action is rejected at translate
 * time.
 *
 * @public
 */
export interface OverlayAction {
  target: string;
  update?: JsonValue;
  remove?: boolean;
}

/**
 * An OpenAPI Overlay 1.0 document. Mirrors the spec envelope
 * (https://spec.openapis.org/overlay/1.0.0). Fields outside `actions`
 * are metadata and are not consumed by the translator.
 *
 * @public
 */
export interface OverlayDocument {
  overlay: string;
  info: { title: string; version: string };
  /** Optional target hint from the spec; the translator ignores it. */
  extends?: string;
  actions: OverlayAction[];
}

/**
 * Whether `value` carries the OpenAPI Overlay 1.0 envelope
 * ({@link OverlayDocument}): an object with an `overlay` version
 * string, an `info` object, and an `actions` array. Envelope-level
 * only; per-action validation happens in {@link translateOverlay},
 * which throws a locating error on malformed actions. Pairs with
 * `@oaverify/core/spec`'s `isSpecOverlay` for callers discriminating an overlay
 * file of unknown format.
 *
 * @public
 */
export function isOverlayDocument(value: unknown): value is OverlayDocument {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d["overlay"] === "string" &&
    typeof d["info"] === "object" &&
    d["info"] !== null &&
    Array.isArray(d["actions"])
  );
}

/**
 * Translate one OpenAPI Overlay document into a typed
 * `SpecOverlay`. Pure: returns a fresh overlay; the
 * input document is not mutated.
 *
 * @throws {@link UnrecognisedTargetError} when any action's `target`
 *         JSONPath doesn't match a recognised shape.
 * @throws `Error` when an action carries both `update` and
 *         `remove: true`, or when the action's payload shape doesn't
 *         match the target (e.g. non-object where an object is
 *         expected).
 *
 * @public
 */
export function translateOverlay(doc: OverlayDocument): SpecOverlay {
  assertEnvelope(doc);
  const overlay: SpecOverlay = {};
  for (let i = 0; i < doc.actions.length; i++) {
    const action = doc.actions[i]!;
    const normalised = normaliseAction(action, i);
    try {
      applyAction(action.target, normalised, overlay);
    } catch (err) {
      // Add an action index for callers walking large overlays.
      if (err instanceof UnrecognisedTargetError) throw err;
      if (err instanceof Error) {
        throw new Error(
          `overlay action #${i} (target ${JSON.stringify(action.target)}): ${err.message}`,
          { cause: err },
        );
      }
      throw err;
    }
  }
  return overlay;
}

/**
 * Translate the overlay document and apply it to `base` in one call.
 * Equivalent to
 * `applyOverlays(base, [translateOverlay(doc)])`.
 *
 * @public
 */
export function applySpecOverlay(base: OpenAPIDocument, doc: OverlayDocument): OpenAPIDocument {
  return applyOverlays(base, [translateOverlay(doc)]);
}

function assertEnvelope(doc: unknown): asserts doc is OverlayDocument {
  if (typeof doc !== "object" || doc === null) {
    throw new Error("overlay document must be an object");
  }
  const d = doc as Record<string, unknown>;
  if (typeof d["overlay"] !== "string") {
    throw new Error('overlay document missing required string field `overlay` (e.g. "1.0.0")');
  }
  if (typeof d["info"] !== "object" || d["info"] === null) {
    throw new Error("overlay document missing required object field `info`");
  }
  if (!Array.isArray(d["actions"])) {
    throw new Error("overlay document missing required array field `actions`");
  }
}

function normaliseAction(action: OverlayAction, idx: number): NormalizedAction {
  const hasUpdate = Object.hasOwn(action, "update");
  const hasRemove = action.remove === true;
  if (hasUpdate && hasRemove) {
    throw new Error(
      `overlay action #${idx} (target ${JSON.stringify(action.target)}): cannot set both \`update\` and \`remove: true\``,
    );
  }
  if (!hasUpdate && !hasRemove) {
    throw new Error(
      `overlay action #${idx} (target ${JSON.stringify(action.target)}): must set either \`update\` or \`remove: true\``,
    );
  }
  return hasRemove ? { kind: "remove" } : { kind: "update", value: action.update };
}

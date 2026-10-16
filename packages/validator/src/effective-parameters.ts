import type { ParameterObject, ReferenceObject } from "@oaverify/internal-core";
import { isIgnoredHeaderParameter } from "./headers.js";

/** A winning parameter with its declaration retained for diagnostics. @internal */
export interface EffectiveParameter {
  readonly raw: ParameterObject | ReferenceObject;
  readonly object: ParameterObject;
  readonly source: "pathItem" | "operation";
  readonly index: number;
}

/**
 * Select parameters for one operation, after its Path Item has been selected.
 * Operation declarations override Path Item declarations with the same
 * `in` and `name`, compared as strings with no case folding.
 * An override keeps the first occurrence's position in the returned list.
 *
 * Malformed lists and non-object entries contribute no parameters; document
 * conformance reports their shape. A required parameter in a malformed list
 * is therefore not enforced; callers need `check` to report that document
 * defect. Ignored header parameters are excluded.
 * Resolution errors propagate to the caller, which owns compilation timing.
 * The original entry and its list index survive resolution and overriding so
 * callers can locate a winning declaration without changing the document.
 *
 * @internal
 */
export function effectiveParameters(
  pathParameters: unknown,
  operationParameters: unknown,
  resolveRef: <T>(value: T | ReferenceObject | undefined) => T | undefined,
): EffectiveParameter[] {
  const selected: EffectiveParameter[] = [];
  // Keyed per field, so a separator inside a name or location cannot make
  // two different pairs share a slot.
  const slots = new Map<string, Map<string, number>>();
  const collect = (parameters: unknown, source: EffectiveParameter["source"]): void => {
    if (!Array.isArray(parameters)) return;
    for (const [index, raw] of (parameters as (ParameterObject | ReferenceObject)[]).entries()) {
      const object = resolveRef<ParameterObject>(raw);
      if (object === null || typeof object !== "object") continue;
      if (isIgnoredHeaderParameter(object)) continue;
      const entry = { raw, object, source, index };
      let byName = slots.get(String(object.in));
      if (byName === undefined) slots.set(String(object.in), (byName = new Map()));
      const slot = byName.get(String(object.name));
      if (slot === undefined) {
        byName.set(String(object.name), selected.length);
        selected.push(entry);
      } else {
        selected[slot] = entry;
      }
    }
  };
  collect(pathParameters, "pathItem");
  collect(operationParameters, "operation");
  return selected;
}

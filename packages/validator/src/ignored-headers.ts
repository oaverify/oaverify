/**
 * Header declarations OpenAPI says to ignore, located for a report.
 *
 * The validator drops these declarations wherever it reads them (see
 * {@link isIgnoredHeaderParameter}). This walk lists them so a report
 * can say the declaration has no effect.
 *
 * It reaches the operations under `paths`, `webhooks` and callbacks,
 * rather than only the ones `createValidator` routes: the rule is about
 * the document, and an ignored declaration on a webhook is as inert as
 * one on a path.
 *
 * @packageDocumentation
 */

import {
  pointerFromRefFragment,
  resolveJsonPointer,
  type OpenAPIDocument,
} from "@oaverify/internal-core";
import { escapePointer, METHODS } from "./document-walk.js";
import { isIgnoredHeaderParameter } from "./headers.js";
import { REF_CHAIN_MAX_HOPS } from "./operation-cache.js";

/**
 * One ignored header declaration, located.
 *
 * @internal
 */
export interface IgnoredHeader {
  /** JSON pointer to the declaration as the reaching operation reads it. */
  readonly pointer: string;
  /**
   * JSON pointer to the shared definition, when the declaration was
   * reached through a local `$ref` (of the entry itself or of an
   * enclosing Path Item or callback). Several operations can reach it.
   */
  readonly definitionPointer?: string;
  /**
   * The reaching operation or Path Item, for the message: `GET /widgets`,
   * `path item /widgets`, `POST webhook newPet`, or a callback's
   * operation followed by `of` and the operation declaring the callback.
   */
  readonly where: string;
  /** The header name as the document spells it. */
  readonly name: string;
}

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Every header parameter OpenAPI says to ignore, in document order:
 * `paths`, then `webhooks`, with each operation's callbacks after it.
 * A declaration reached from several operations is listed once for each,
 * and a Path Item's own parameter once for that Path Item.
 *
 * @internal
 */
export function listIgnoredHeaders(document: OpenAPIDocument): IgnoredHeader[] {
  const found: IgnoredHeader[] = [];

  // The target of a possibly-`$ref`'d value, and the pointer to that
  // target when the reference is local. A reference this walk cannot
  // follow is the conformance pass's finding, not this one's.
  // The pointer is the last hop's, so a path built under it addresses
  // the target and not a Reference Object partway along a chain.
  const follow = (raw: unknown): { target?: unknown; definitionPointer?: string } => {
    let current = raw;
    let definitionPointer: string | undefined;
    for (let hops = 0; hops <= REF_CHAIN_MAX_HOPS; hops++) {
      const ref = isObj(current) ? current["$ref"] : undefined;
      if (typeof ref !== "string") {
        return definitionPointer === undefined
          ? { target: current }
          : { target: current, definitionPointer };
      }
      const pointer = ref.startsWith("#") ? pointerFromRefFragment(ref) : undefined;
      if (pointer === undefined || hops === REF_CHAIN_MAX_HOPS) return {};
      try {
        current = resolveJsonPointer(document, pointer);
      } catch {
        return {};
      }
      definitionPointer = pointer;
    }
    return {};
  };

  const collectParameters = (
    parameters: unknown,
    base: string,
    where: string,
    shared: boolean,
  ): void => {
    if (!Array.isArray(parameters)) return;
    for (const [index, raw] of (parameters as unknown[]).entries()) {
      const { target, definitionPointer } = follow(raw);
      if (!isObj(target) || !isIgnoredHeaderParameter(target)) continue;
      const pointer = `${base}/parameters/${index}`;
      found.push({
        pointer,
        ...(definitionPointer !== undefined
          ? { definitionPointer }
          : shared
            ? { definitionPointer: pointer }
            : {}),
        where,
        name: target["name"] as string,
      });
    }
  };

  // A Path Item entry is read twice when it carries a `$ref`: its own
  // keys, because the router routes a method written beside the `$ref`
  // (`methodsDeclaredOn`), and the target's. Same rule as
  // `listUnservedParameterLocations`.
  const walkPathItem = (
    raw: unknown,
    base: string,
    label: string,
    shared: boolean,
    ancestors: ReadonlySet<unknown>,
  ): void => {
    if (!isObj(raw)) return;
    walkPathItemObject(raw, base, label, shared, ancestors);
    if (typeof raw["$ref"] !== "string") return;
    const { target, definitionPointer } = follow(raw);
    if (!isObj(target) || target === raw) return;
    walkPathItemObject(target, definitionPointer ?? base, label, true, ancestors);
  };

  const walkPathItemObject = (
    item: Obj,
    at: string,
    label: string,
    viaRef: boolean,
    ancestors: ReadonlySet<unknown>,
  ): void => {
    // A callback can reach the Path Item that declares it; once per
    // chain is enough.
    if (ancestors.has(item)) return;
    const inside = new Set(ancestors).add(item);
    // A Path Item's own parameters apply only through its operations.
    // 3.2 `additionalOperations` are not read here, as the router does
    // not route them.
    const operations = METHODS.filter((method) => isObj(item[method]));
    if (operations.length > 0) {
      collectParameters(item["parameters"], at, `path item ${label}`, viaRef);
    }
    for (const method of operations) {
      const operation = item[method] as Obj;
      const where = `${method.toUpperCase()} ${label}`;
      collectParameters(operation["parameters"], `${at}/${method}`, where, viaRef);
      const callbacks = operation["callbacks"];
      if (!isObj(callbacks)) continue;
      for (const [name, rawCallback] of Object.entries(callbacks)) {
        const callback = follow(rawCallback);
        if (!isObj(callback.target)) continue;
        const callbackAt =
          callback.definitionPointer ?? `${at}/${method}/callbacks/${escapePointer(name)}`;
        for (const [expression, entry] of Object.entries(callback.target)) {
          // Naming the reaching operation keeps findings on a shared
          // callback distinct, one per operation.
          walkPathItem(
            entry,
            `${callbackAt}/${escapePointer(expression)}`,
            `callback ${name} ${expression} of ${where}`,
            viaRef || callback.definitionPointer !== undefined,
            inside,
          );
        }
      }
    }
  };

  const doc = document as unknown as Obj;
  for (const [container, prefix] of [
    ["paths", ""],
    ["webhooks", "webhook "],
  ] as const) {
    const entries = doc[container];
    if (!isObj(entries)) continue;
    for (const [name, item] of Object.entries(entries)) {
      walkPathItem(
        item,
        `/${container}/${escapePointer(name)}`,
        `${prefix}${name}`,
        false,
        new Set(),
      );
    }
  }
  return found;
}

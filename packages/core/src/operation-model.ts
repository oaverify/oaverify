/**
 * One resolved view of which operations an OpenAPI document declares.
 *
 * Every walker that iterates `paths`, follows a Path Item `$ref`, or
 * decides whether an operation is served has so far made those decisions
 * on its own, and a rule learned by one walker (3.2 `additionalOperations`,
 * fields along a Path Item reference chain, percent-encoded fragments)
 * has had to be learned again by each of the others. This module makes
 * the decisions once and hands the result out as plain data.
 *
 * The model is built over a document the resolver has already produced,
 * so every `$ref` it meets is local. It references the document's own
 * nodes by identity and copies nothing. It stops at the Operation
 * Object: nothing here reads a parameter, a body or a schema.
 *
 * Served-ness records what the engines do today. The runtime router
 * reads the raw `paths` entries and their fixed method fields; the
 * emitted validator reads the effective Path Item along a reference
 * chain. Each operation carries what each engine does with it, and the
 * reason when the engine does not serve it, so no consumer has to
 * rediscover that.
 *
 * A position the document's version does not define, such as `query`
 * before 3.2 or `webhooks` in 3.0, is modelled as written: the engines
 * and the walkers read it whatever the version. A consumer that needs
 * the distinction has `version` on the model.
 *
 * @packageDocumentation
 */

import { escapePointerSegment, pointerFromFragment, resolveJsonPointer } from "./json-pointer.js";
import { setSpecKey } from "./own-key.js";
import {
  HTTP_METHODS,
  type OpenAPIDocument,
  type OperationObject,
  type PathItem,
} from "./types.js";
import { detectOpenAPIVersion, type OpenAPIVersion } from "./version.js";

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The most nodes a reference chain may hold, the entry included. The
 * validator's `resolveOperationRef` refuses a longer chain at the same
 * length.
 */
export const REF_CHAIN_MAX_HOPS = 32;

/**
 * Where a Path Item sits. A callback's Path Items are keyed by runtime
 * expression inside a Callback Object.
 */
export type PathItemContainer = "paths" | "webhooks" | "components.pathItems" | "callback";

/** How a `$ref` chain ended. Only `complete` reached a non-reference node. */
export type ChainStatus =
  /** The chain ended at a node that is not a reference. */
  | "complete"
  /** A hop's `$ref` names another document (it does not start with `#`). */
  | "external"
  /** A hop's fragment is not a JSON Pointer, or the pointer does not resolve. */
  | "unresolved"
  /** A hop returned to a node already on the chain. */
  | "cycle"
  /** The chain reached {@link REF_CHAIN_MAX_HOPS} nodes without ending or cycling. */
  | "truncated";

/** One node on a `$ref` chain: the entry node first, each target after. */
export interface RefHop {
  /** Pointer of this node in the document; the entry's is its own position. */
  readonly pointer: string;
  readonly node: unknown;
}

/** A followed `$ref` chain. */
export interface FollowedReference {
  readonly status: ChainStatus;
  /** Every node reached, entry first. The last is the terminal under `complete`. */
  readonly hops: readonly RefHop[];
  /** The terminal node, under `complete` only. */
  readonly target: unknown;
  /** Pointer of the terminal node, under `complete` only. */
  readonly pointer: string | undefined;
  /** The `$ref` string that stopped the chain, when it did not complete. */
  readonly stoppedAt: string | undefined;
}

/** Why an engine does not serve an operation. */
export type NotServedReason =
  /** Only `paths` entries are routed. */
  | "container"
  /** `additionalOperations` entries are not routed (#396). */
  | "additional-operation"
  /** The runtime router reads the raw entry; an operation reached through a Path Item `$ref` is not on it. */
  | "behind-path-item-ref"
  /**
   * `emitSpec` resolves every `paths` entry before it emits anything and
   * throws when one reference chain does not complete, so no operation
   * of such a document is emitted.
   */
  | "emit-fails"
  /**
   * `emitSpec` skips a `paths` entry whose reference chain ends at
   * `null`, the fields written beside the reference included.
   */
  | "null-target";

/** Whether one engine routes an operation, and why not when it does not. */
export type ServedVerdict =
  | { readonly served: true }
  | { readonly served: false; readonly reason: NotServedReason };

/** Today's routing, per engine. */
export interface ServedBy {
  /** `createValidator`'s router. */
  readonly runtime: ServedVerdict;
  /** The module `compile-spec` emits, before its `--only` filter, as far as routing decides it. */
  readonly emitted: ServedVerdict;
}

/** A Path Item entry, with the fields its reference chain contributes. */
export interface ModelPathItem {
  readonly container: PathItemContainer;
  /** Path template, webhook name, `components.pathItems` key, or callback expression. */
  readonly key: string;
  /** Pointer of the entry node. */
  readonly pointer: string;
  /** The entry node, which may carry a `$ref`. */
  readonly node: Obj;
  /** The `$ref` chain from the entry; one hop when the entry has no `$ref`. */
  readonly chain: FollowedReference;
  /**
   * Fields along the chain, nearest declaration winning; arrays replace
   * as a whole. The same rule as the standalone emitter's.
   */
  readonly effective: PathItem;
  /** Field name to the pointer of the Path Item that declares it. */
  readonly origins: ReadonlyMap<string, string>;
  readonly operations: readonly ModelOperation[];
  /**
   * Whether each engine answers HEAD with the GET operation here. The
   * router does so for a `paths` entry that itself declares GET and no
   * HEAD; the emitter does so when the effective item declares GET and
   * no HEAD.
   */
  readonly impliedHead: { readonly runtime: boolean; readonly emitted: boolean };
  /** For a callback Path Item: pointer of the Callback Object it sits in. */
  readonly callbackPointer?: string;
}

/** One operation, wherever it was declared. */
export interface ModelOperation {
  readonly pathItem: ModelPathItem;
  /** Method token as written (`get`, or an `additionalOperations` key). */
  readonly method: string;
  /** A fixed Path Item field, or an `additionalOperations` entry. */
  readonly methodKind: "fixed" | "additional";
  /** Pointer of the Operation Object. */
  readonly pointer: string;
  /** Pointer of the Path Item hop that declares it. */
  readonly declaredIn: string;
  readonly node: OperationObject;
  readonly servedBy: ServedBy;
}

/** A chain the model could not follow to its end. */
export interface ModelDiagnostic {
  readonly status: Exclude<ChainStatus, "complete">;
  /** Pointer of the reference node that started the chain. */
  readonly pointer: string;
  /** The `$ref` that stopped it. */
  readonly ref: string | undefined;
}

export interface OperationModel {
  readonly version: OpenAPIVersion;
  readonly document: OpenAPIDocument;
  /**
   * Every Path Item entry. An entry under `paths`, `webhooks` or
   * `components.pathItems` is a position of its own, so a Path Item two
   * of them reference is listed at each. A callback Path Item is listed
   * once, however many operations reach its Callback Object.
   */
  readonly pathItems: readonly ModelPathItem[];
  /** The operations of every entry in {@link OperationModel.pathItems}, in the same order. */
  readonly operations: readonly ModelOperation[];
  readonly diagnostics: readonly ModelDiagnostic[];
}

/**
 * Follow a local `$ref` chain from `node`, recording every hop.
 *
 * A fragment is percent-decoded once, through `pointerFromFragment`, so
 * `#%2Fcomponents%2FpathItems%2FP` names what `#/components/pathItems/P`
 * names and the pointers reported are the grammar that walking builds.
 * A node that is not a reference is a one-hop `complete` chain.
 */
export function followReference(
  document: OpenAPIDocument,
  node: unknown,
  pointer: string,
): FollowedReference {
  const hops: RefHop[] = [{ pointer, node }];
  const seen = new Set<unknown>();
  const stopped = (status: Exclude<ChainStatus, "complete">, ref: string): FollowedReference => ({
    status,
    hops,
    target: undefined,
    pointer: undefined,
    stoppedAt: ref,
  });
  let current = node;
  for (;;) {
    if (!isObj(current) || typeof current["$ref"] !== "string") {
      return {
        status: "complete",
        hops,
        target: current,
        pointer: hops.at(-1)!.pointer,
        stoppedAt: undefined,
      };
    }
    const ref = current["$ref"];
    if (!ref.startsWith("#")) return stopped("external", ref);
    if (hops.length >= REF_CHAIN_MAX_HOPS) return stopped("truncated", ref);
    const next = pointerFromFragment(ref.slice(1));
    seen.add(current);
    let target: unknown;
    try {
      target = resolveJsonPointer(document, next);
    } catch {
      return stopped("unresolved", ref);
    }
    hops.push({ pointer: next, node: target });
    if (seen.has(target)) return stopped("cycle", ref);
    current = target;
  }
}

/**
 * Build the model for a resolved document.
 *
 * Containers are visited in order: `paths`, `webhooks`,
 * `components.pathItems`, then `components.callbacks`. The callbacks an
 * entry's operations declare follow that entry, breadth first.
 */
export function buildOperationModel(document: OpenAPIDocument): OperationModel {
  const version = detectOpenAPIVersion(document) ?? "3.1";
  const pathItems: ModelPathItem[] = [];
  const operations: ModelOperation[] = [];
  const diagnostics: ModelDiagnostic[] = [];

  const doc = document as unknown as Obj;

  // `emitSpec` resolves the reference chain of every value under `paths`,
  // an `x-` key's included (#1342), before it emits anything.
  const emitBuilds =
    !isObj(doc["paths"]) ||
    Object.entries(doc["paths"]).every(
      ([key, item]) =>
        followReference(document, item, `/paths/${escapePointerSegment(key)}`).status ===
        "complete",
    );

  const follow = (node: unknown, pointer: string): FollowedReference => {
    const chain = followReference(document, node, pointer);
    if (chain.status !== "complete") {
      diagnostics.push({ status: chain.status, pointer, ref: chain.stoppedAt });
    }
    return chain;
  };

  // Callbacks wait in a queue instead of being entered as their operation
  // is, so a long run of callbacks referencing callbacks costs no stack.
  // Each use site and each callback Path Item is taken once, by pointer:
  // a Callback Object many operations reference is modelled one time, and
  // a callback that leads back to itself ends there.
  const pendingCallbacks: { node: unknown; pointer: string }[] = [];
  const callbackUses = new Set<string>();
  const callbackItems = new Set<string>();

  const queueCallback = (node: unknown, pointer: string): void => {
    if (callbackUses.has(pointer)) return;
    callbackUses.add(pointer);
    pendingCallbacks.push({ node, pointer });
  };

  const modelPathItem = (
    container: PathItemContainer,
    key: string,
    pointer: string,
    node: unknown,
    callbackPointer?: string,
  ): void => {
    if (!isObj(node)) return;
    const chain = follow(node, pointer);
    const emitted: ServedVerdict = !emitBuilds
      ? notServed("emit-fails")
      : chain.status === "complete" && chain.target === null
        ? notServed("null-target")
        : { served: true };

    // Nearest declaration wins along the chain; `$ref` itself is not a field.
    const merged: Obj = {};
    const origins = new Map<string, string>();
    for (const hop of chain.hops) {
      if (!isObj(hop.node)) continue;
      for (const [field, value] of Object.entries(hop.node)) {
        if (field === "$ref" || Object.hasOwn(merged, field)) continue;
        setSpecKey(merged, field, value);
        origins.set(field, hop.pointer);
      }
    }

    const routed = container === "paths";
    const ops: ModelOperation[] = [];
    const item: ModelPathItem = {
      container,
      key,
      pointer,
      node,
      chain,
      effective: merged as PathItem,
      origins,
      operations: ops,
      impliedHead: {
        runtime: routed && isObj(node["get"]) && !isObj(node["head"]),
        emitted: routed && emitted.served && isObj(merged["get"]) && !isObj(merged["head"]),
      },
      ...(callbackPointer === undefined ? {} : { callbackPointer }),
    };
    pathItems.push(item);

    const pushOperation = (
      method: string,
      methodKind: "fixed" | "additional",
      opNode: unknown,
    ): void => {
      if (!isObj(opNode)) return;
      const declaredIn = origins.get(methodKind === "fixed" ? method : "additionalOperations")!;
      const op: ModelOperation = {
        pathItem: item,
        method,
        methodKind,
        pointer:
          methodKind === "fixed"
            ? `${declaredIn}/${method}`
            : `${declaredIn}/additionalOperations/${escapePointerSegment(method)}`,
        declaredIn,
        node: opNode as OperationObject,
        servedBy: servedVerdicts(container, methodKind, declaredIn === pointer, emitted),
      };
      ops.push(op);
      operations.push(op);
    };

    for (const method of HTTP_METHODS) pushOperation(method, "fixed", merged[method]);
    if (isObj(merged["additionalOperations"])) {
      for (const [method, opNode] of Object.entries(merged["additionalOperations"])) {
        pushOperation(method, "additional", opNode);
      }
    }

    for (const op of ops) {
      if (!isObj(op.node.callbacks)) continue;
      for (const [name, callback] of Object.entries(op.node.callbacks)) {
        queueCallback(callback, `${op.pointer}/callbacks/${escapePointerSegment(name)}`);
      }
    }
  };

  const modelCallback = (node: unknown, pointer: string): void => {
    const chain = follow(node, pointer);
    if (chain.status !== "complete" || !isObj(chain.target)) return;
    const callbackPointer = chain.pointer!;
    for (const [expression, item] of Object.entries(chain.target)) {
      if (expression.startsWith("x-")) continue;
      const itemPointer = `${callbackPointer}/${escapePointerSegment(expression)}`;
      if (callbackItems.has(itemPointer)) continue;
      callbackItems.add(itemPointer);
      modelPathItem("callback", expression, itemPointer, item, callbackPointer);
    }
  };

  let nextCallback = 0;
  const drainCallbacks = (): void => {
    for (; nextCallback < pendingCallbacks.length; nextCallback++) {
      const { node, pointer } = pendingCallbacks[nextCallback]!;
      modelCallback(node, pointer);
    }
  };

  const components = isObj(doc["components"]) ? doc["components"] : {};
  const containers: [PathItemContainer, unknown, string][] = [
    ["paths", doc["paths"], "/paths"],
    ["webhooks", doc["webhooks"], "/webhooks"],
    ["components.pathItems", components["pathItems"], "/components/pathItems"],
  ];
  for (const [container, entries, at] of containers) {
    if (!isObj(entries)) continue;
    for (const [key, item] of Object.entries(entries)) {
      // `webhooks` and `components.pathItems` map names, where any key is
      // an entry; under `paths` an `x-` key is a specification extension.
      if (container === "paths" && key.startsWith("x-")) continue;
      modelPathItem(container, key, `${at}/${escapePointerSegment(key)}`, item);
      drainCallbacks();
    }
  }
  if (isObj(components["callbacks"])) {
    for (const [name, callback] of Object.entries(components["callbacks"])) {
      queueCallback(callback, `/components/callbacks/${escapePointerSegment(name)}`);
      drainCallbacks();
    }
  }

  return { version, document, pathItems, operations, diagnostics };
}

/**
 * Today's routing for one operation.
 *
 * Runtime: `createRouter` reads `spec.paths` and each raw entry's fixed
 * method fields, including fields written beside a `$ref`; nothing
 * reached through the `$ref` is routed. Since the effective item takes
 * the nearest declaration, a fixed-method operation is on the raw entry
 * exactly when the entry is the hop that declares it.
 * Emitted: `emitSpec` reads `paths` and the effective Path Item along
 * the chain, fixed methods only. It builds nothing when any chain under
 * `paths` does not complete, and skips an entry whose chain ends at
 * `null`.
 */
function servedVerdicts(
  container: PathItemContainer,
  methodKind: "fixed" | "additional",
  declaredOnEntry: boolean,
  emitted: ServedVerdict,
): ServedBy {
  if (container !== "paths") {
    return { runtime: notServed("container"), emitted: notServed("container") };
  }
  if (methodKind === "additional") {
    return {
      runtime: notServed("additional-operation"),
      emitted: notServed("additional-operation"),
    };
  }
  return {
    runtime: declaredOnEntry ? { served: true } : notServed("behind-path-item-ref"),
    emitted,
  };
}

const notServed = (reason: NotServedReason): ServedVerdict => ({ served: false, reason });

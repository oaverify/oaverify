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

/** An operation as written on one Path Item object, before any reference is followed. */
export interface DeclaredOperation {
  /** Method token as written (`get`, or an `additionalOperations` key). */
  readonly method: string;
  readonly methodKind: "fixed" | "additional";
  /** Pointer of the Operation Object relative to its Path Item, without a leading slash. */
  readonly suffix: string;
  readonly node: OperationObject;
}

/** A Path Item object as written, with the pointer it was first reached at. */
export interface DeclaredPathItem {
  readonly pointer: string;
  readonly node: Obj;
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
   * Every Path Item entry, with what its reference chain contributes. An
   * entry under `paths`, `webhooks` or `components.pathItems` is a
   * position of its own, so a Path Item two of them reference is listed
   * at each. A rule about what a path serves reads this.
   */
  readonly pathItems: readonly ModelPathItem[];
  /** The operations of every entry in {@link OperationModel.pathItems}, in the same order. */
  readonly operations: readonly ModelOperation[];
  /**
   * Every Path Item object the document declares, once each by identity,
   * as written: the entries, the targets their references reach, and the
   * Path Items in the callbacks of every operation written on any of
   * them, whether or not a nearer declaration shadows that operation. A
   * rule about what a document declares reads this, with
   * {@link operationsOn} for each object's own operations.
   *
   * The order is the order of writing: each container in turn, a Path
   * Item's inline callbacks straight after it, and reference targets
   * after the containers in the order the references were met. A
   * definition the resolver inlined at several use sites is a separate
   * object at each, so it is listed at each.
   */
  readonly declared: readonly DeclaredPathItem[];
  readonly diagnostics: readonly ModelDiagnostic[];
}

/**
 * The operations one Path Item object declares itself: each fixed method
 * field holding an object, then each `additionalOperations` entry holding
 * one. Fields behind the object's own `$ref` are not read; the model's
 * `effective` item is the view that includes them.
 */
export function operationsOn(pathItem: unknown): DeclaredOperation[] {
  if (!isObj(pathItem)) return [];
  const found: DeclaredOperation[] = [];
  for (const method of HTTP_METHODS) {
    const node = pathItem[method];
    if (isObj(node)) {
      found.push({ method, methodKind: "fixed", suffix: method, node: node as OperationObject });
    }
  }
  if (isObj(pathItem["additionalOperations"])) {
    for (const [method, node] of Object.entries(pathItem["additionalOperations"])) {
      if (!isObj(node)) continue;
      found.push({
        method,
        methodKind: "additional",
        suffix: `additionalOperations/${escapePointerSegment(method)}`,
        node: node as OperationObject,
      });
    }
  }
  return found;
}

/** One step of a local reference: the node a `$ref` string names, or why there is none. */
function resolveHop(document: OpenAPIDocument, ref: string): RefHop | "external" | "unresolved" {
  if (!ref.startsWith("#")) return "external";
  const pointer = pointerFromFragment(ref.slice(1));
  try {
    return { pointer, node: resolveJsonPointer(document, pointer) };
  } catch {
    return "unresolved";
  }
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
    const hop = resolveHop(document, ref);
    if (hop === "external") return stopped("external", ref);
    if (hops.length >= REF_CHAIN_MAX_HOPS) return stopped("truncated", ref);
    if (hop === "unresolved") return stopped("unresolved", ref);
    seen.add(current);
    hops.push(hop);
    if (seen.has(hop.node)) return stopped("cycle", ref);
    current = hop.node;
  }
}

/**
 * Build the model for a resolved document.
 *
 * One pass over the document in the order it is written produces both
 * views. Containers are visited in order: `paths`, `webhooks`,
 * `components.pathItems`, then `components.callbacks`. Reference targets
 * wait in a queue and are visited after the containers, one hop at a
 * time, so a chain of any length costs no stack and a cycle ends at the
 * first object met twice.
 */
export function buildOperationModel(document: OpenAPIDocument): OperationModel {
  const version = detectOpenAPIVersion(document) ?? "3.1";
  const pathItems: ModelPathItem[] = [];
  const operations: ModelOperation[] = [];
  const declared: DeclaredPathItem[] = [];
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

  // Path Item and Callback objects already taken, by identity, and the
  // reference targets still to visit.
  const seen = new Set<unknown>();
  const pending: { kind: "item" | "callback"; pointer: string; node: unknown }[] = [];
  // Callback Path Items that have an entry. Kept apart from `seen`: a
  // reference can reach one as a target before its Callback Object is
  // entered, and it is still owed its entry then.
  const callbackEntries = new Set<unknown>();

  /** One entry: its chain, its effective fields and the operations those give it. */
  const modelEntry = (
    container: PathItemContainer,
    key: string,
    pointer: string,
    node: Obj,
    callbackPointer?: string,
  ): void => {
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

    for (const { method, methodKind, suffix, node: opNode } of operationsOn(merged)) {
      const declaredIn = origins.get(methodKind === "fixed" ? method : "additionalOperations")!;
      const op: ModelOperation = {
        pathItem: item,
        method,
        methodKind,
        pointer: `${declaredIn}/${suffix}`,
        declaredIn,
        node: opNode,
        servedBy: servedVerdicts(container, methodKind, declaredIn === pointer, emitted),
      };
      ops.push(op);
      operations.push(op);
    }
  };

  /**
   * One Path Item object as written: listed, its reference queued, and
   * the callbacks of the operations written on it entered. Those
   * operations include any a nearer declaration shadows, since a
   * shadowed operation's callback is still written in the document.
   */
  const declare = (node: Obj, pointer: string): void => {
    if (seen.has(node)) return;
    seen.add(node);
    declared.push({ pointer, node });
    if (typeof node["$ref"] === "string") {
      const hop = resolveHop(document, node["$ref"]);
      // The document is not a Path Item, whatever `$ref: "#"` says.
      if (typeof hop !== "string" && hop.node !== document) {
        pending.push({ kind: "item", ...hop });
      }
    }
    for (const { suffix, node: operation } of operationsOn(node)) {
      if (!isObj(operation.callbacks)) continue;
      for (const [name, callback] of Object.entries(operation.callbacks)) {
        enterCallback(callback, `${pointer}/${suffix}/callbacks/${escapePointerSegment(name)}`);
      }
    }
  };

  const enterPathItem = (
    container: PathItemContainer,
    key: string,
    pointer: string,
    node: unknown,
    callbackPointer?: string,
  ): void => {
    if (!isObj(node)) return;
    // A named entry is a position, modelled wherever its object has been
    // met before. A callback's Path Item is modelled once.
    if (container === "callback") {
      if (callbackEntries.has(node)) return;
      callbackEntries.add(node);
    }
    modelEntry(container, key, pointer, node, callbackPointer);
    declare(node, pointer);
  };

  const enterCallback = (node: unknown, pointer: string): void => {
    if (!isObj(node) || seen.has(node)) return;
    seen.add(node);
    if (typeof node["$ref"] === "string") {
      const chain = follow(node, pointer);
      if (chain.status === "complete") {
        pending.push({ kind: "callback", pointer: chain.pointer!, node: chain.target });
      }
      return;
    }
    for (const [expression, item] of Object.entries(node)) {
      if (expression.startsWith("x-")) continue;
      enterPathItem(
        "callback",
        expression,
        `${pointer}/${escapePointerSegment(expression)}`,
        item,
        pointer,
      );
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
      enterPathItem(container, key, `${at}/${escapePointerSegment(key)}`, item);
    }
  }
  if (isObj(components["callbacks"])) {
    for (const [name, callback] of Object.entries(components["callbacks"])) {
      enterCallback(callback, `/components/callbacks/${escapePointerSegment(name)}`);
    }
  }
  // The queue grows while it is read: a target can hold further references.
  for (let next = 0; next < pending.length; next++) {
    const { kind, pointer, node } = pending[next]!;
    if (kind === "callback") enterCallback(node, pointer);
    else if (isObj(node)) declare(node, pointer);
  }

  return { version, document, pathItems, operations, declared, diagnostics };
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

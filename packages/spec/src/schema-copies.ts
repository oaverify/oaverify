import { resolveJsonPointer } from "@oaverify/internal-core";
import { isDeepStrictEqual } from "node:util";
import { sourceOf, type SpecRegion } from "./provenance.js";

/**
 * Resolved locations built from the same source URI and JSON Pointer as
 * a hoisted schema target. This records source identity, without promising
 * equal values or equivalent evaluation under different schema scopes.
 *
 * Only successfully hoisted targets with retained copies are included.
 * All addresses are RFC 6901 JSON Pointers in the resolved document.
 *
 * @public
 */
export interface HoistedSchemaCopies {
  /** The hoisted schema's resolved address. */
  readonly target: string;
  /** Exact retained locations, excluding `target`, with no duplicates. */
  readonly copies: readonly string[];
}

/** A successfully mounted schema, while its original address is still known. */
export interface HoistedSchemaTarget {
  readonly uri: string;
  readonly pointer: string;
  readonly target: string;
}

type MountedRegion = Extract<SpecRegion, { kind: "mounted" }>;

/** Source mounts bound the search; no scan of every resolved schema is needed. */
export function collectHoistedSchemaCopies(
  document: unknown,
  regions: readonly SpecRegion[],
  targets: readonly HoistedSchemaTarget[],
): HoistedSchemaCopies[] {
  if (targets.length === 0) return [];
  const bySource = new Map<string, Map<string, MountedRegion[]>>();
  const byPosition = new Map<string, SpecRegion>();
  for (const region of regions) {
    // Later mounts at the same address shadow earlier ones, as in sourceOf.
    byPosition.set(region.at, region);
    if (region.kind !== "mounted") continue;
    let pointers = bySource.get(region.uri);
    if (pointers === undefined) {
      pointers = new Map();
      bySource.set(region.uri, pointers);
    }
    const mounted = pointers.get(region.pointer);
    if (mounted === undefined) pointers.set(region.pointer, [region]);
    else mounted.push(region);
  }

  const result: HoistedSchemaCopies[] = [];
  for (const { uri, pointer, target } of targets) {
    const pointers = bySource.get(uri);
    if (pointers === undefined) continue;
    const copies = new Set<string>();
    for (const prefix of ancestors(pointer)) {
      for (const region of pointers.get(prefix) ?? []) {
        const copy = region.at + pointer.slice(prefix.length);
        if (copy === target || copies.has(copy)) continue;
        // A deeper mount or sibling override may have replaced this source.
        const covering = coveringRegion(byPosition, copy);
        const source = covering === undefined ? undefined : sourceOf([covering], copy);
        if (source?.uri !== uri || source.pointer !== pointer) continue;
        try {
          resolveJsonPointer(document, copy);
          copies.add(copy);
        } catch {
          // A bound component slot can have been removed after a failed read.
        }
      }
    }
    if (copies.size > 0) result.push({ target, copies: [...copies] });
  }
  return result;
}

function* ancestors(pointer: string): Generator<string> {
  let at = pointer;
  while (true) {
    yield at;
    if (at === "") return;
    at = at.slice(0, at.lastIndexOf("/"));
  }
}

function coveringRegion(
  regions: ReadonlyMap<string, SpecRegion>,
  pointer: string,
): SpecRegion | undefined {
  for (const at of ancestors(pointer)) {
    const region = regions.get(at);
    if (region !== undefined) return region;
  }
  return undefined;
}

/** Preserve known connections only while both endpoints survive unchanged. */
export function retainHoistedSchemaCopies(
  groups: readonly HoistedSchemaCopies[],
  before: unknown,
  after: unknown,
): HoistedSchemaCopies[] {
  const unchanged = new Map<string, boolean>();
  const survives = (pointer: string): boolean => {
    const known = unchanged.get(pointer);
    if (known !== undefined) return known;
    let same = false;
    try {
      same = isDeepStrictEqual(
        resolveJsonPointer(before, pointer),
        resolveJsonPointer(after, pointer),
      );
    } catch {
      // An overlay removed or moved this endpoint.
    }
    unchanged.set(pointer, same);
    return same;
  };
  const result: HoistedSchemaCopies[] = [];
  for (const { target, copies } of groups) {
    if (!survives(target)) continue;
    const kept = copies.filter(survives);
    if (kept.length > 0) result.push({ target, copies: kept });
  }
  return result;
}

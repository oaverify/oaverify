import { type PathSegment } from "@oaverify/internal-core";
import {
  forEachSubschema,
  pathForRef,
  positionFields,
  stepPosition,
  type SubschemaPosition,
} from "../subschema-positions.js";
import { refSiblingIsDiscarded } from "../ref-siblings.js";
import type { SchemaLintIssue } from "./compiler.js";
import { deepEqual } from "./runtime.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const MAX_DEPTH = 40;
const MAX_WORK = 20_000;
const MAX_VALUE_WORK = 200_000;

/** Resource resolution, active keywords and physical addressing for finite conjunctions. */
interface Options {
  known: (keyword: string) => boolean;
  refSuppressesSiblings: boolean;
  resolve?: (ref: string, from: object) => unknown;
  dynamicTargets?: (ref: string, from: object) => readonly unknown[];
  pointerOf?: (node: object) => string | undefined;
  refPointer?: (ref: string, from: object) => string | undefined;
  pointer?: string;
  anchor?: "node" | "definition";
}

interface Entry {
  node: unknown;
  path: string;
  at: SubschemaPosition;
  fresh: boolean;
}
interface Finite {
  keyword: "enum" | "const";
  values: unknown[];
  sizes: number[];
  entry: Entry;
}
interface Frame {
  seeds: Entry[];
  anchor: Entry;
  instance: readonly PathSegment[];
  incomplete: boolean;
  required?: boolean;
  property?: string;
  expanded: ReadonlySet<object>;
}

function child(entry: Entry, node: unknown, key: string, index?: string | number): Entry {
  const rendered =
    index === undefined ? key : typeof index === "number" ? `${key}[${index}]` : `${key}.${index}`;
  return {
    node,
    fresh: entry.fresh,
    path: entry.path === "" ? rendered : `${entry.path}.${rendered}`,
    at:
      index === undefined
        ? stepPosition(entry.at, key)
        : stepPosition(stepPosition(entry.at, key), index),
  };
}

/** Analyze each joint instance position once, retaining its composition's physical anchor. */
export function collectComposedEnumIssues(root: unknown, options: Options): SchemaLintIssue[] {
  const issues: SchemaLintIssue[] = [];
  let work = MAX_WORK;
  let valueWork = MAX_VALUE_WORK;
  const ids = new WeakMap<object, number>();
  const active = new Set<string>();
  let nextId = 0;
  const keyOf = (entries: Entry[]): string =>
    entries
      .map(({ node }) => {
        if (!isObj(node)) return String(node);
        let value = ids.get(node);
        if (value === undefined) {
          value = nextId++;
          ids.set(node, value);
        }
        return String(value);
      })
      .sort()
      .join(",");
  const live = (node: Obj, key: string): boolean =>
    options.known(key) && !refSiblingIsDiscarded(node, key, options.refSuppressesSiblings);

  // Preflight bounds deepEqual's work and excludes cyclic or non-JSON values.
  const sizeOf = (value: unknown, ancestors = new Set<object>(), depth = 0): number | undefined => {
    if (--valueWork < 0 || depth > MAX_DEPTH) return undefined;
    if (value === null || typeof value === "boolean") return 1;
    if (typeof value === "string") {
      valueWork -= value.length;
      return valueWork < 0 ? undefined : 1 + value.length;
    }
    if (typeof value === "number") return Number.isFinite(value) ? 1 : undefined;
    if (typeof value !== "object" || ancestors.has(value)) return undefined;
    // Generated enum/const literals do not preserve this authored own key.
    if (Object.hasOwn(value, "__proto__")) return undefined;
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      return undefined;
    if (Array.isArray(value) && Object.keys(value).length !== value.length) return undefined;
    ancestors.add(value);
    let size = 1;
    for (const v of Object.values(value)) {
      const n = sizeOf(v, ancestors, depth + 1);
      if (n === undefined) {
        ancestors.delete(value);
        return undefined;
      }
      size += n;
    }
    ancestors.delete(value);
    return size;
  };
  const equal = (a: unknown, aSize: number, b: unknown, bSize: number): boolean | undefined => {
    valueWork -= aSize + bSize;
    return valueWork < 0 ? undefined : deepEqual(a, b);
  };
  const display = (values: unknown[]): string => {
    const text = JSON.stringify(values.slice(0, 5));
    return `${text.length > 500 ? `${text.slice(0, 497)}...` : text}${values.length > 5 ? ` (+${values.length - 5} more)` : ""}`;
  };

  const walk = (frame: Frame, depth: number): void => {
    if (depth > MAX_DEPTH || work <= 0) return;
    const frameKey = keyOf(frame.seeds);
    if (active.has(frameKey)) return;
    active.add(frameKey);
    let incomplete = frame.incomplete;
    let malformed = false;
    const entries: Entry[] = [];
    const pendingGroups = new Set<string>();
    const seen = new Set<object>();
    const visiting = new Set<object>();
    const add = (entry: Entry, level: number): void => {
      if (--work < 0 || level > MAX_DEPTH) {
        incomplete = true;
        return;
      }
      const node = entry.node;
      if (typeof node === "boolean") return;
      if (!isObj(node)) {
        malformed = true;
        return;
      }
      if (visiting.has(node)) {
        incomplete = true;
        return;
      }
      if (seen.has(node)) return;
      seen.add(node);
      visiting.add(node);
      entries.push(entry);
      for (const key of ["$ref", "$dynamicRef"]) {
        if (!live(node, key) || typeof node[key] !== "string") continue;
        const ref = node[key];
        let targets: readonly unknown[];
        try {
          targets =
            key === "$ref"
              ? [options.resolve?.(ref, node)]
              : (options.dynamicTargets?.(ref, node) ?? []);
        } catch {
          targets = [];
        }
        if (targets.length !== 1 || targets[0] === undefined) {
          incomplete = true;
          continue;
        }
        const target = targets[0];
        add(
          {
            node: target,
            fresh: entry.fresh,
            path: pathForRef(ref),
            at: {
              pointer:
                entry.at.pointer === undefined
                  ? undefined
                  : options.pointerOf !== undefined && isObj(target)
                    ? options.pointerOf(target)
                    : options.refPointer?.(ref, node),
              anchor: "definition",
            },
          },
          level + 1,
        );
      }
      forEachSubschema(node, (value, key, _family, index) => {
        if (work <= 0) {
          incomplete = true;
          return false;
        }
        if (key === "allOf" && live(node, key)) add(child(entry, value, key, index), level + 1);
        if ((key === "anyOf" || key === "oneOf") && live(node, key) && !frame.expanded.has(node))
          pendingGroups.add(`${keyOf([entry])}/${key}`);
      });
      visiting.delete(node);
    };
    for (const seed of frame.seeds) {
      if (work <= 0) {
        incomplete = true;
        break;
      }
      add(seed, 0);
    }

    const finite: Finite[] = [];
    for (const entry of entries) {
      const node = entry.node as Obj;
      for (const keyword of ["enum", "const"] as const) {
        if (!live(node, keyword) || !Object.hasOwn(node, keyword)) continue;
        const values = keyword === "const" ? [node[keyword]] : node[keyword];
        if (!Array.isArray(values)) {
          malformed = true;
          continue;
        }
        if (values.length > MAX_VALUE_WORK) {
          incomplete = true;
          continue;
        }
        const sizes = Array.from(values, (v) => sizeOf(v));
        if (sizes.some((s) => s === undefined)) {
          incomplete = true;
          continue;
        }
        finite.push({
          keyword,
          values,
          sizes: sizes as number[],
          entry: child(entry, values, keyword),
        });
      }
    }
    if (!malformed && finite.length >= 2 && finite.some((f) => f.entry.fresh)) {
      const first = finite[0]!;
      const intersection: unknown[] = [];
      const intersectionSizes: number[] = [];
      let compared = true;
      for (let i = 0; i < first.values.length; i++) {
        const value = first.values[i];
        const size = first.sizes[i]!;
        let duplicate = false;
        for (let j = 0; j < intersection.length; j++) {
          const same = equal(value, size, intersection[j], intersectionSizes[j]!);
          if (same === undefined) {
            compared = false;
            break;
          }
          if (same) {
            duplicate = true;
            break;
          }
        }
        if (!compared) break;
        if (duplicate) continue;
        let included = true;
        for (const constraint of finite.slice(1)) {
          let found = false;
          for (let j = 0; j < constraint.values.length; j++) {
            const same = equal(value, size, constraint.values[j], constraint.sizes[j]!);
            if (same === undefined) {
              compared = false;
              break;
            }
            if (same) {
              found = true;
              break;
            }
          }
          if (!found) {
            included = false;
            break;
          }
        }
        if (!compared) break;
        if (included) {
          intersection.push(value);
          intersectionSizes.push(size);
        }
      }
      let explicit = false;
      if (compared && intersection.length > 0 && !incomplete && pendingGroups.size === 0) {
        for (const constraint of finite) {
          let subset = true;
          for (let i = 0; i < constraint.values.length; i++) {
            let found = false;
            for (let j = 0; j < intersection.length; j++) {
              const same = equal(
                constraint.values[i],
                constraint.sizes[i]!,
                intersection[j],
                intersectionSizes[j]!,
              );
              if (same === undefined) {
                compared = false;
                break;
              }
              if (same) {
                found = true;
                break;
              }
            }
            if (!found) {
              subset = false;
              break;
            }
          }
          if (subset) {
            explicit = true;
            break;
          }
        }
      }
      if (
        compared &&
        (intersection.length === 0 || (!incomplete && pendingGroups.size === 0 && !explicit))
      ) {
        const empty = intersection.length === 0;
        const excluded: unknown[] = [];
        const excludedSizes: number[] = [];
        let evidenceComplete = true;
        for (const constraint of finite) {
          for (let i = 0; i < constraint.values.length; i++) {
            const value = constraint.values[i];
            const size = constraint.sizes[i]!;
            let found = false;
            for (const [values, sizes] of [
              [intersection, intersectionSizes],
              [excluded, excludedSizes],
            ] as const) {
              for (let j = 0; j < values.length; j++) {
                const same = equal(value, size, values[j], sizes[j]!);
                if (same === undefined) {
                  evidenceComplete = false;
                  break;
                }
                if (same) {
                  found = true;
                  break;
                }
              }
              if (found || !evidenceComplete) break;
            }
            if (!evidenceComplete) break;
            if (!found) {
              excluded.push(value);
              excludedSizes.push(size);
            }
          }
          if (!evidenceComplete) break;
        }
        const where =
          frame.instance.length === 0
            ? "this instance position"
            : `instance path ${JSON.stringify(frame.instance)}`;
        const parentWhere =
          frame.instance.length <= 1
            ? "this instance position"
            : `instance path ${JSON.stringify(frame.instance.slice(0, -1))}`;
        const scope =
          frame.property === undefined
            ? `No value at ${where} satisfies the collected finite constraints`
            : `Property ${JSON.stringify(frame.property)} cannot be present in an object at ${parentWhere}${frame.required === true ? "; it is required, so no object at that position validates" : ""}`;
        const at = positionFields(frame.anchor.at);
        if (evidenceComplete)
          issues.push({
            code: empty
              ? "unsatisfiable/composed-enum-empty"
              : "unsatisfiable/composed-enum-members",
            keyword: finite.some((f) => f.keyword === "enum") ? "enum" : "const",
            path: frame.anchor.path,
            ...at,
            ...(at.anchor === "definition" ? { anchor: "scoped-definition" as const } : {}),
            contributors: finite.map(({ entry: contributor }) => ({
              path: contributor.path,
              ...positionFields(contributor.at),
            })),
            message: empty
              ? `${scope}; finite intersection: []. Excluded values: ${display(excluded)}.`
              : `At ${where}, composed finite constraints exclude ${display(excluded)}; finite intersection: ${display(intersection)}.`,
          });
      }
    }

    const properties = new Map<string, Entry[]>();
    const independent: Entry[] = [];
    const alternatives: Entry[] = [];
    const expanded = new Set(frame.expanded);
    let prefixLength = 0;
    let hasItems = false;
    for (const entry of entries) {
      const node = entry.node as Obj;
      forEachSubschema(node, (value, key, _family, index) => {
        if (--work < 0) {
          incomplete = true;
          return false;
        }
        if (!live(node, key)) return;
        if (key === "properties" && typeof index === "string") {
          const list = properties.get(index) ?? [];
          list.push(child(entry, value, key, index));
          properties.set(index, list);
        } else if ((key === "oneOf" || key === "anyOf") && !frame.expanded.has(node)) {
          alternatives.push(child(entry, value, key, index));
          expanded.add(node);
        } else if (key === "$defs" || key === "definitions") {
          independent.push(child(entry, value, key, index));
        } else if (key === "prefixItems" && typeof index === "number") {
          prefixLength = Math.max(prefixLength, index + 1);
        } else if (key === "items") {
          hasItems = true;
        }
      });
    }
    const descend = (
      seeds: Entry[],
      instance: readonly PathSegment[],
      unknown: boolean,
      property?: string,
      required?: boolean,
    ): void => {
      if (seeds.length === 0) return;
      const single = seeds.length === 1 ? seeds[0] : undefined;
      walk(
        {
          seeds,
          anchor: single?.at.schemaPath !== undefined ? single : frame.anchor,
          instance,
          incomplete: unknown,
          property,
          required,
          expanded: new Set(),
        },
        depth + 1,
      );
    };
    for (const [name, seeds] of properties) {
      if (work <= 0) break;
      let unknown = incomplete || pendingGroups.size > 0;
      let required = false;
      for (const entry of entries) {
        if (--work < 0) {
          unknown = true;
          break;
        }
        const node = entry.node as Obj;
        const patterns =
          !refSiblingIsDiscarded(node, "patternProperties", options.refSuppressesSiblings) &&
          isObj(node.patternProperties) &&
          Object.keys(node.patternProperties).length > 0;
        if (patterns || (live(node, "unevaluatedProperties") && isObj(node.unevaluatedProperties)))
          unknown = true;
        const covered = isObj(node.properties) && Object.hasOwn(node.properties, name);
        if (
          !covered &&
          !patterns &&
          live(node, "additionalProperties") &&
          isObj(node.additionalProperties)
        )
          seeds.push(child(entry, node.additionalProperties, "additionalProperties"));
        if (live(node, "required") && Array.isArray(node.required) && node.required.includes(name))
          required = true;
      }
      descend(seeds, [...frame.instance, name], unknown, name, required);
    }
    for (let index = 0; work > 0 && index < prefixLength + (hasItems ? 1 : 0); index++) {
      const seeds: Entry[] = [];
      let unknown = incomplete || pendingGroups.size > 0;
      for (const entry of entries) {
        if (--work < 0) {
          unknown = true;
          break;
        }
        const node = entry.node as Obj;
        const prefix =
          live(node, "prefixItems") && Array.isArray(node.prefixItems) ? node.prefixItems : [];
        if (index < prefix.length) seeds.push(child(entry, prefix[index], "prefixItems", index));
        else if (live(node, "items") && node.items !== undefined)
          seeds.push(child(entry, node.items, "items"));
        if (
          (live(node, "contains") && node.contains !== undefined) ||
          (live(node, "unevaluatedItems") && isObj(node.unevaluatedItems))
        )
          unknown = true;
      }
      descend(seeds, [...frame.instance, index < prefixLength ? index : "*"], unknown);
    }
    for (const entry of alternatives) {
      if (work <= 0) break;
      walk(
        {
          ...frame,
          seeds: [...entries.map((e) => ({ ...e, fresh: false })), { ...entry, fresh: true }],
          anchor: entry,
          incomplete: incomplete || pendingGroups.size > 1,
          expanded,
        },
        depth + 1,
      );
    }
    for (const entry of independent) {
      if (work <= 0) break;
      walk(
        { seeds: [entry], anchor: entry, instance: [], incomplete: false, expanded: new Set() },
        depth + 1,
      );
    }
    active.delete(frameKey);
  };
  const entry: Entry = {
    node: root,
    fresh: true,
    path: "",
    at: { pointer: options.pointer, schemaPath: [], anchor: options.anchor ?? "node" },
  };
  walk({ seeds: [entry], anchor: entry, instance: [], incomplete: false, expanded: new Set() }, 0);
  return issues;
}

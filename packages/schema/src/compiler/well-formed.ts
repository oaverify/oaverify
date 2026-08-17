import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import type { KeywordDefinition } from "../keywords/types.js";
import type { RefResolver } from "../resolve/index.js";
import {
  pathForRef,
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_MIXED_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
} from "../subschema-positions.js";

/**
 * Sibling keys explicitly permitted alongside `$ref` under OAS 3.0
 * (Schema Object §4.7.24.2): metadata-only, no validation effect.
 * Anything else is silently dropped under `refSuppressesSiblings: true`.
 *
 * Lives here rather than in the compiler because both places need it and
 * `compiler.ts` already imports from this module: the lint pass reports
 * a discarded sibling, and this pass must not judge the value of one.
 *
 * @internal
 */
export const OAS30_REF_SIBLINGS_ALLOWED: ReadonlySet<string> = new Set([
  "$ref",
  "description",
  "summary",
]);

/**
 * Options for {@link assertWellFormedSchema}.
 *
 * @internal
 */
export interface AssertWellFormedOptions {
  /**
   * Prefix for the thrown message, e.g. an external schema's name. Omit
   * for the schema being compiled.
   */
  label?: string;
  /** Resolver, so the walk follows `$ref` into targets it can reach. */
  refResolver?: RefResolver;
  /**
   * Whether the active dialect discards `$ref` siblings (OAS 3.0).
   *
   * When set, a keyword sitting beside `$ref` is skipped rather than
   * checked. The compiler will not emit it (`refOnly` in
   * `compileSchemaInto`) and the lint pass already reports it as
   * silently dropped, so judging its *value* here would make an ignored
   * keyword fatal: `{$ref, type: "application/json"}` failed to compile
   * with exit 4, while `{$ref, type: "string"}` warned and exited 0.
   * Same slot, same discard, two verdicts.
   */
  refSuppressesSiblings?: boolean;
}

/**
 * Human-readable name for a value that turned up where a schema was
 * expected. Deliberately not `typeof`: "object" would be the answer for
 * both `null` and an array, which are the two shapes that actually
 * occur.
 */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "string":
      return `a string (${JSON.stringify(value)})`;
    case "number":
    case "bigint":
      return `a number (${String(value)})`;
    case "function":
      return "a function";
    default:
      return `a ${typeof value}`;
  }
}

/** `<root>` for the walk root, `"a.b[0]"` otherwise. Matches the strict-lint style. */
function at(path: string): string {
  return path === "" ? "<root>" : `"${path}"`;
}

function isSchemaNode(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extra nudge for the one malformed shape that is a genuine mistake
 * rather than a typo. An array-valued `items` is the draft-04 /
 * Swagger 2.0 tuple form; 2020-12 spells it `prefixItems`. Naming the
 * replacement turns "this is wrong" into "do this instead".
 */
function hintFor(key: string, value: unknown): string {
  if (key === "items" && Array.isArray(value)) {
    return ' In JSON Schema 2020-12 the tuple form is "prefixItems"; an array-valued "items" is the draft-04 / Swagger 2.0 spelling.';
  }
  if (value === undefined) {
    return " Remove the key to omit it; a present key with an undefined value still declares the keyword.";
  }
  return "";
}

/**
 * Reject anything in a schema-valued position that is not a schema,
 * before compilation descends into it.
 *
 * Without this, a malformed slot fails in one of two ways, both bad. A
 * shape the compiler can index into but not interpret is dropped
 * silently: an array-valued `items` compiles as a keyword-free schema,
 * so the array's elements go entirely unvalidated and no schema-lint mode
 * reports it. A shape it cannot index into throws a raw `TypeError`
 * from deep inside codegen (`Cannot read properties of null (reading
 * '$id')`), naming no schema, path, or file.
 *
 * Both are the same defect, so both get the same treatment here: throw,
 * name the offending value, and give the dotted path to it.
 *
 * This runs in every mode, including `schemaLint: "off"`. Well-formedness is
 * a precondition rather than a lint level -- `strict` grades schemas
 * that *are* schemas, and there is nothing to grade here. The `"off"`
 * path already threw on these inputs, just without saying where.
 *
 * Mirrors {@link walkSubschemas} but cannot reuse it: that walker
 * guards array positions with `Array.isArray` and map positions with a
 * typeof-object check, so it skips exactly the malformed values this
 * needs to see. It shares the `SUBSCHEMA_*_POSITIONS` constants, so the
 * two cannot drift apart on which keys hold schemas.
 *
 * Keyword values are checked in the same pass, through each
 * {@link KeywordDefinition.validateKeywordValue}. One traversal rather
 * than two: the walk is O(nodes) and doubling it buys nothing. Because
 * it covers the whole graph, a keyword in a subschema no `$ref` reaches
 * is checked too, which the per-keyword `compile` guards cannot do.
 *
 * @param root - Schema to check, walked in full before compiling.
 * @param byKeyword - Active dialect's keyword map, for the value hooks.
 * @param options - See {@link AssertWellFormedOptions}.
 *
 * @internal
 */
export function assertWellFormedSchema(
  root: SchemaOrBoolean,
  byKeyword: ReadonlyMap<string, KeywordDefinition>,
  options: AssertWellFormedOptions = {},
): void {
  const { label, refResolver, refSuppressesSiblings = false } = options;
  const prefix = label === undefined ? "" : `${label}: `;
  // Object graphs are normally acyclic here (circular references
  // survive as `$ref` strings, which are never descended), but a
  // hand-built schema can share or cycle. Revisiting a node would only
  // re-prove what is already proven, so skipping is both safe and the
  // cycle guard.
  const seen = new WeakSet<object>();

  const fail = (message: string): never => {
    throw new Error(prefix + message);
  };

  const go = (node: unknown, path: string): void => {
    if (!isSchemaNode(node)) {
      fail(`schema at ${at(path)} must be an object or boolean; got ${describe(node)}`);
    }
    if (typeof node === "boolean") return; // `true` / `false` are complete schemas
    const obj = node as Record<string, unknown>;
    if (seen.has(obj)) return;
    seen.add(obj);

    // Follow `$ref`. Without this the guard covers only the schema
    // literally handed to `compileSchema`, and in the HTTP pipeline that
    // is one operation's inline schema: components arrive through the
    // resolver, so every `$ref` below the root compiled unchecked. The
    // structural checks below exist nowhere else, so a bad `items`
    // inside a component was not merely unlocated, it was accepted, and
    // the constraint was dropped at runtime (#512).
    //
    // `seen` makes this linear: well-formedness does not depend on where
    // a schema is used, so each object is checked once however many
    // references reach it.
    const ref = obj["$ref"];
    if (typeof ref === "string" && refResolver !== undefined) {
      let target: SchemaOrBoolean | undefined;
      try {
        target = refResolver.resolve(ref);
      } catch {
        // An unresolvable `$ref` is its own error, raised by the
        // compiler with its own message. Not this pass's business.
      }
      // Reset to the target's document path: well-formedness is a
      // property of the schema itself, so it is one edit at one
      // definition however many references reach it. See the addressing
      // rule on `pathForRef` for why the required lint does the
      // opposite.
      if (target !== undefined) go(target, pathForRef(ref));
    }

    // Keyword values, before descending. `Object.keys` matches what
    // keyword dispatch itself iterates, so a key present with an
    // undefined value is checked rather than skipped.
    //
    // Under OAS 3.0 a sibling of `$ref` is skipped, because the compiler
    // will not emit it. Checking a value nothing reads turned a
    // discarded keyword into a fatal, and only for some values of it.
    //
    // `"$ref" in obj`, not `typeof obj.$ref === "string"`, because that
    // is how `compileSchemaInto` decides the same thing. A present but
    // non-string `$ref` would otherwise have codegen dropping the
    // siblings while this pass still judged them, which is the split
    // being removed.
    //
    // The skip covers the keyword-value checks only. The structural
    // walks below stay, discarded sibling or not, because this pass is
    // what stops the *resolver* meeting a malformed node: with
    // `{$ref, properties: null}` gated out of them, `resolve` reaches
    // `Object.keys(null)` and dies with a raw TypeError, trading a
    // located message for exactly the kind #794 removed.
    //
    // So two cases stay fatal that the compiler would have discarded:
    // a discarded sibling whose own shape is wrong (`items: [...]`, the
    // draft-04 tuple form converted Swagger emits), and a bad keyword
    // inside one. Closing those means hardening the resolver's walk
    // first; filed separately rather than widened into this change.
    const refOnly = refSuppressesSiblings && "$ref" in obj;
    const discarded = (key: string): boolean => refOnly && !OAS30_REF_SIBLINGS_ALLOWED.has(key);
    for (const key of Object.keys(obj)) {
      if (discarded(key)) continue;
      const reason = byKeyword.get(key)?.validateKeywordValue?.(obj[key], {
        keyword: key,
        path: path === "" ? key : `${path}.${key}`,
        parentSchema: obj as SchemaObject,
      });
      if (reason !== undefined) {
        // At the root the path *is* the keyword name, so `at "type"`
        // would just repeat what the sentence already said.
        const where = path === "" ? "" : ` at ${at(`${path}.${key}`)}`;
        fail(`keyword "${key}"${where} ${reason}`);
      }
    }

    // Presence is `hasOwn`, not `!== undefined`. Keyword dispatch walks
    // `Object.keys`, which reports a key whose value is `undefined`, so
    // `{ items: undefined }` reaches codegen as a declared `items` and
    // crashes there. Treating it as absent here would reopen exactly the
    // gap this pass exists to close.
    for (const key of SUBSCHEMA_SINGLE_POSITIONS) {
      if (!Object.hasOwn(obj, key)) continue;
      const v = obj[key];
      if (!isSchemaNode(v)) {
        fail(
          `"${key}" at ${at(path)} must be an object or boolean; got ${describe(v)}.${hintFor(key, v)}`,
        );
      }
      go(v, path === "" ? key : `${path}.${key}`);
    }

    for (const key of SUBSCHEMA_ARRAY_POSITIONS) {
      if (!Object.hasOwn(obj, key)) continue;
      const v = obj[key];
      if (!Array.isArray(v)) {
        fail(
          `"${key}" at ${at(path)} must be an array of schemas; got ${describe(v)}.${hintFor(key, v)}`,
        );
      }
      const arr = v as unknown[];
      for (let i = 0; i < arr.length; i += 1) {
        go(arr[i], path === "" ? `${key}[${i}]` : `${path}.${key}[${i}]`);
      }
    }

    for (const key of SUBSCHEMA_MAP_POSITIONS) {
      if (!Object.hasOwn(obj, key)) continue;
      const v = obj[key];
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        fail(
          `"${key}" at ${at(path)} must be an object mapping names to schemas; got ${describe(v)}.${hintFor(key, v)}`,
        );
      }
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
        go(sub, path === "" ? `${key}.${name}` : `${path}.${key}.${name}`);
      }
    }

    for (const key of SUBSCHEMA_MIXED_MAP_POSITIONS) {
      if (!Object.hasOwn(obj, key)) continue;
      const v = obj[key];
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        fail(
          `"${key}" at ${at(path)} must be an object mapping names to schemas or to arrays of property names; got ${describe(v)}.`,
        );
      }
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
        // An array entry names required properties rather than holding a
        // schema, so there is nothing here to check as one.
        if (Array.isArray(sub)) continue;
        go(sub, path === "" ? `${key}.${name}` : `${path}.${key}.${name}`);
      }
    }
  };

  go(root, "");
}

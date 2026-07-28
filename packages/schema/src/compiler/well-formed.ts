import type { SchemaObject, SchemaOrBoolean } from "@oaverify/internal-core";
import type { KeywordDefinition } from "../keywords/types.js";
import type { RefResolver } from "../resolve/index.js";
import {
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
} from "../subschema-positions.js";

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
 * Display path for a schema reached through `$ref`. A local pointer
 * becomes the dotted document path it names, so
 * `#/components/schemas/Email` reads as `components.schemas.Email` and
 * joins with the path below it in the same style. Anything else (an
 * anchor, an external URI) is shown as written, since there is no
 * document path to give.
 */
function pathForRef(ref: string): string {
  if (!ref.startsWith("#/")) return ref;
  return ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
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
 * so the array's elements go entirely unvalidated and no strict mode
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
 * @param label - Prefix for the thrown message, e.g. an external
 *   schema's name. Omit for the schema being compiled.
 *
 * @internal
 */
export function assertWellFormedSchema(
  root: SchemaOrBoolean,
  byKeyword: ReadonlyMap<string, KeywordDefinition>,
  label?: string,
  refResolver?: RefResolver,
): void {
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
      if (target !== undefined) go(target, pathForRef(ref));
    }

    // Keyword values, before descending. `Object.keys` matches what
    // keyword dispatch itself iterates, so a key present with an
    // undefined value is checked rather than skipped.
    for (const key of Object.keys(obj)) {
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
  };

  go(root, "");
}

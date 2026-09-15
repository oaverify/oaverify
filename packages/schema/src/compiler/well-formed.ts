import {
  escapePointerSegment,
  type SchemaObject,
  type SchemaOrBoolean,
} from "@oaverify/internal-core";
import type { KeywordDefinition } from "../keywords/types.js";
import type { RefResolver } from "../resolve/index.js";
import {
  pathForRef,
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_MIXED_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
} from "../subschema-positions.js";
import { refSiblingIsDiscarded } from "../ref-siblings.js";

/**
 * Options for {@link assertWellFormedSchema}.
 *
 * @internal
 */
export interface AssertWellFormedOptions {
  /** Document positions and resource bases, when supplied by document tooling. */
  pointer?: string;
  pointerOf?: (schema: object) => string | undefined;
  baseUriOf?: (schema: object) => string | undefined;
  refPointer?: (ref: string, from: object) => string | undefined;
  additionalRoots?: readonly SchemaOrBoolean[];

  /** Pattern policy shared with code generation; omit for shape checks only. */
  compilePattern?: (pattern: string) => unknown;
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

const errorPointers = new WeakMap<object, string>();

/**
 * Structured location of a document compiler failure. The weak side table preserves
 * native error classes (including SyntaxError), identity and causes for callers.
 */
export function schemaErrorPointer(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? errorPointers.get(error) : undefined;
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
 * Reject anything in an active schema-valued position that is not a
 * schema, before compilation descends into it.
 *
 * Without this, a malformed slot fails in one of two ways, both bad. A
 * shape the compiler can index into but not interpret is dropped
 * silently: an array-valued `items` compiles as a keyword-free schema,
 * so the array's elements go entirely unvalidated and no schema-lint mode
 * reports it. A shape it cannot index into throws a raw `TypeError`
 * from deep inside codegen (`Cannot read properties of null (reading
 * '$id')`), naming no schema, path, or file.
 *
 * Both are the same defect, so both get the same treatment here:
 * throw, name the offending value, and give the dotted path to it.
 * The exception is OAS 3.0 `$ref` siblings that the dialect discards.
 * Those slots are not compiled, so their own shape and subtree are not
 * active schema content.
 *
 * This runs in every mode, including `schemaLint: "off"`. Well-formedness is
 * a precondition, not a lint level: `strict` grades schemas
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

  const go = (node: unknown, path: string, pointer?: string): void => {
    let atPointer =
      typeof node === "object" && node !== null ? (options.pointerOf?.(node) ?? pointer) : pointer;
    try {
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
      for (const key of options.baseUriOf === undefined ? ["$ref"] : ["$ref", "$dynamicRef"]) {
        if (refSiblingIsDiscarded(obj, key, refSuppressesSiblings)) continue;
        const ref = obj[key];
        if (typeof ref !== "string" || refResolver === undefined) continue;
        let target: SchemaOrBoolean | undefined;
        try {
          target = refResolver.resolve(ref, options.baseUriOf?.(obj));
        } catch {
          // Code generation reports unresolved references.
        }
        if (target !== undefined) go(target, pathForRef(ref), options.refPointer?.(ref, obj));
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
      // The structural walks below read the same predicate. A discarded
      // sibling is not compiled, so its own shape and subtree are not part
      // of the schema being checked.
      const discarded = (key: string): boolean =>
        refSiblingIsDiscarded(obj, key, refSuppressesSiblings);
      const nodePointer = atPointer;
      const childPointer = (key: string): string | undefined =>
        nodePointer === undefined ? undefined : `${nodePointer}/${escapePointerSegment(key)}`;
      for (const key of Object.keys(obj)) {
        if (discarded(key)) continue;
        atPointer = childPointer(key);
        // At the root the keyword name already locates its value.
        const where = path === "" ? "" : ` at ${at(`${path}.${key}`)}`;
        let reason: string | undefined;
        try {
          reason = byKeyword.get(key)?.validateKeywordValue?.(obj[key], {
            compilePattern: options.compilePattern,
            keyword: key,
            path: path === "" ? key : `${path}.${key}`,
            parentSchema: obj as SchemaObject,
          });
        } catch (err) {
          const message = `${prefix}keyword "${key}"${where}: ${err instanceof Error ? err.message : String(err)}`;
          // Native regex syntax errors keep their established error class.
          if (err instanceof SyntaxError) throw new SyntaxError(message, { cause: err });
          throw new Error(message, { cause: err });
        }
        if (reason !== undefined) {
          fail(`keyword "${key}"${where} ${reason}`);
        }
      }

      // Presence is `hasOwn`, not `!== undefined`. Keyword dispatch walks
      // `Object.keys`, which reports a key whose value is `undefined`, so
      // `{ items: undefined }` reaches codegen as a declared `items` and
      // crashes there. Treating it as absent here would reopen exactly the
      // gap this pass exists to close.
      for (const key of SUBSCHEMA_SINGLE_POSITIONS) {
        if (discarded(key)) continue;
        atPointer = childPointer(key);
        if (!Object.hasOwn(obj, key)) continue;
        const v = obj[key];
        if (!isSchemaNode(v)) {
          fail(
            `"${key}" at ${at(path)} must be an object or boolean; got ${describe(v)}.${hintFor(key, v)}`,
          );
        }
        go(v, path === "" ? key : `${path}.${key}`, childPointer(key));
      }

      for (const key of SUBSCHEMA_ARRAY_POSITIONS) {
        if (discarded(key)) continue;
        atPointer = childPointer(key);
        if (!Object.hasOwn(obj, key)) continue;
        const v = obj[key];
        if (!Array.isArray(v)) {
          fail(
            `"${key}" at ${at(path)} must be an array of schemas; got ${describe(v)}.${hintFor(key, v)}`,
          );
        }
        const arr = v as unknown[];
        for (let i = 0; i < arr.length; i += 1) {
          go(
            arr[i],
            path === "" ? `${key}[${i}]` : `${path}.${key}[${i}]`,
            atPointer === undefined ? undefined : `${atPointer}/${i}`,
          );
        }
      }

      for (const key of SUBSCHEMA_MAP_POSITIONS) {
        if (discarded(key)) continue;
        atPointer = childPointer(key);
        if (!Object.hasOwn(obj, key)) continue;
        const v = obj[key];
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          fail(
            `"${key}" at ${at(path)} must be an object mapping names to schemas; got ${describe(v)}.${hintFor(key, v)}`,
          );
        }
        for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
          go(
            sub,
            path === "" ? `${key}.${name}` : `${path}.${key}.${name}`,
            atPointer === undefined ? undefined : `${atPointer}/${escapePointerSegment(name)}`,
          );
        }
      }

      for (const key of SUBSCHEMA_MIXED_MAP_POSITIONS) {
        if (discarded(key)) continue;
        atPointer = childPointer(key);
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
          go(
            sub,
            path === "" ? `${key}.${name}` : `${path}.${key}.${name}`,
            atPointer === undefined ? undefined : `${atPointer}/${escapePointerSegment(name)}`,
          );
        }
      }
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        atPointer !== undefined &&
        !errorPointers.has(err)
      ) {
        errorPointers.set(err, atPointer);
      }
      throw err;
    }
  };

  go(root, "", options.pointer);
  for (const node of options.additionalRoots ?? []) {
    const pointer =
      typeof node === "object" && node !== null ? options.pointerOf?.(node) : undefined;
    go(node, pointer === undefined ? "<dynamic candidate>" : pathForRef(`#${pointer}`), pointer);
  }
}

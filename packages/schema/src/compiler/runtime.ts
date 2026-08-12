import {
  createBranchError,
  createError,
  createLeafError,
  type NormalizedFormat,
  type ValidationError,
} from "@oaverify/internal-core";
import type { CustomKeywordValidator } from "../keywords/custom.js";

/**
 * Runtime helpers exposed to every generated validator through the `deps`
 * closure. Keyword authors invoke these from generated source.
 *
 * @public
 */
export interface ValidatorDeps {
  createError: typeof createError;
  createLeafError: typeof createLeafError;
  createBranchError: typeof createBranchError;
  typeOf: (value: unknown) => string;
  deepEqual: (a: unknown, b: unknown) => boolean;
  wrapErrors: (
    code: string,
    path: readonly (string | number)[],
    errs: ValidationError[],
  ) => ValidationError | null;
  /**
   * Flat-mode error merge. Appends every error in `src` onto `dest` and
   * returns `dest`; when `dest` is `null` it adopts `src` directly (no
   * copy) and when `src` is `null` it returns `dest` unchanged. The
   * leaves in `src` were already counted against the budget where they
   * were created, so this never touches `errorsRemaining` (it is the
   * flat-mode analogue of a tree-mode "lift"). Loop-based rather than
   * `dest.push(...src)` so a million-element `src` cannot overflow the
   * call stack. See {@link appendErrors}.
   */
  appendErrors: (
    dest: ValidationError[] | null,
    src: ValidationError[] | null,
  ) => ValidationError[] | null;
  patterns: Map<string, CompiledRegex>;
  /**
   * Compile a user-supplied regex. By default tries the `u` (Unicode)
   * flag first (JSON Schema 2020-12 recommends it) and falls back to
   * no-flag when the pattern trips strict `u`-mode rules (stray `\-`,
   * `\:` etc., common in real-world OpenAPI specs). When a custom
   * {@link RegexCompiler} is passed to {@link createDeps}, this routes
   * through it instead, and the fallback logic doesn't apply (the
   * compiler is the authority on what's accepted). Results are memoized
   * in `patterns`. The default path throws `SyntaxError` only when the
   * pattern is malformed under both modes; a custom compiler may throw
   * whatever it likes.
   */
  compilePattern: (pattern: string) => CompiledRegex;
  /**
   * Count the Unicode code points in `s` without allocating an
   * intermediate array. Used by `minLength` / `maxLength`, which the
   * JSON Schema 2020-12 spec requires to count code points (surrogate
   * pairs count as one).
   *
   * The obvious `[...s].length` expression builds a one-string-per-code-point
   * array just to read its length; on a 10 MB payload that allocates far
   * more than the `maxLength` check can refuse. This helper walks the
   * string's iterator and counts; O(1) memory.
   */
  countCodePoints: (s: string) => number;
  /**
   * Length-bounded `maxLength` check. Returns `true` iff `s` has more
   * than `limit` code points, short-circuiting on `s.length` so valid
   * strings inside their bound skip the O(n) code-point walk and the
   * worst case walks at most `limit + 1` code points. See
   * {@link exceedsMaxCodePoints}.
   */
  exceedsMaxCodePoints: (s: string, limit: number) => boolean;
  /**
   * Length-bounded `minLength` check. Returns `true` iff `s` has fewer
   * than `limit` code points, short-circuiting on `s.length`. See
   * {@link belowMinCodePoints}.
   */
  belowMinCodePoints: (s: string, limit: number) => boolean;
  /**
   * Find the first duplicate in an array. Returns `{ a, b }` where
   * `arr[a]` and `arr[b]` are structurally equal (JSON deep equality,
   * except that `NaN` matches itself on the primitive path: the `Map`
   * uses SameValueZero, so `[NaN, NaN]` counts as a duplicate) and
   * `a < b`, or `null` when every item is unique. Backs `uniqueItems`.
   *
   * Primitives use a `Map<value, firstIndex>` (O(N) total); objects and
   * arrays fall back to pairwise `deepEqual` against the running list
   * of seen non-primitive items (O(k²) in the object-count tail, which
   * is unavoidable without canonicalisation). Mixed inputs get the
   * primitive fast path for every primitive and the object fallback
   * only for the object subset.
   */
  findDuplicate: (arr: readonly unknown[]) => { a: number; b: number } | null;
  /**
   * Format validators, normalized. `null` means registered and
   * asserting nothing; `undefined` means not registered.
   */
  formats: Map<string, NormalizedFormat | null>;
  refs: Map<string, Validator>;
  /** User-registered keyword validators, keyed by keyword name. */
  customKeywords: Map<string, CustomKeywordValidator>;
  /**
   * The configured maximum number of leaf errors to collect, or
   * `Number.POSITIVE_INFINITY` when uncapped. Baked in at compile time;
   * not mutated after construction.
   */
  maxErrors: number;
  /**
   * Runtime counter, reset to `maxErrors` at the top of each top-level
   * `validate()` call. Every push decrements by one; when it reaches 0
   * further pushes are skipped and {@link ValidatorDeps.truncated} is set.
   */
  errorsRemaining: number;
  /**
   * Set to `true` by the runtime when the `maxErrors` budget was
   * exhausted (nothing need have been dropped: the default cap of 1
   * with exactly one error sets it). Cleared at the top of each
   * top-level `validate()` call.
   */
  truncated: boolean;
  /**
   * The configured maximum recursion depth, or `Number.POSITIVE_INFINITY`
   * when uncapped. Baked in at compile time; not mutated after
   * construction. Compared against {@link ValidatorDeps.depth} at each
   * recursive `$ref` boundary.
   */
  maxDepth: number;
  /**
   * Runtime recursion-depth counter, reset to `0` at the top of each
   * top-level `validate()` call. Incremented before descending through a
   * recursive (`$ref` back-edge) call and decremented after it returns,
   * so it tracks the current nesting depth rather than a cumulative
   * count. Only emitted when a finite {@link ValidatorDeps.maxDepth} was
   * configured.
   */
  depth: number;
}

/**
 * Function signature of a compiled validator.
 *
 * @public
 */
export type Validator = (data: unknown, path: (string | number)[]) => ValidationError | null;

/**
 * The minimal interface required of a value returned by a
 * {@link RegexCompiler}. The runtime only ever calls `.test()` on
 * the result; nothing else is read. JavaScript's built-in `RegExp`
 * already satisfies this shape.
 *
 * @public
 */
export interface CompiledRegex {
  test(s: string): boolean;
}

/**
 * Custom compiler for schema `pattern` keywords and the `format:
 * "regex"` assertion. Defaults to `new RegExp(pattern, "u")` (the
 * `pattern` path adds a non-`u` fallback for patterns that trip strict
 * `u`-mode rules; `format: "regex"` stays `u`-only with no fallback).
 *
 * Override to plug in `re2`, wrap with a complexity check, or reject
 * patterns that fail a safe-regex analysis. JavaScript's built-in
 * `RegExp` has no execution timeout, which makes catastrophic
 * patterns (e.g. `(a+)+$`) a denial-of-service vector against any
 * string the validator checks.
 *
 * Invocation cadence:
 * - For `pattern` keywords, the runtime memoizes by pattern string;
 *   the compiler runs once per unique schema-authored pattern for
 *   the lifetime of the validator (bounded by spec size).
 * - For `format: "regex"`, the runtime bypasses the cache; the
 *   compiler runs per validate() call against the candidate string.
 *   Caching there would retain runtime values indefinitely, which is
 *   the opposite of what hardening callers want.
 *
 * @public
 *
 * @example
 * ```ts
 * import RE2 from "re2";
 *
 * createValidator(spec, {
 *   regexCompiler: (pattern) => new RE2(pattern),
 * });
 * ```
 */
export type RegexCompiler = (pattern: string) => CompiledRegex;

/**
 * Options bag accepted by {@link createDeps}. Prefer this form when
 * passing a {@link RegexCompiler}; the legacy `createDeps(maxErrors)`
 * positional form is preserved for back-compat with AOT-emitted
 * modules built before the option existed.
 *
 * @public
 */
export interface CreateDepsOptions {
  /** Cap on leaf errors collected per `validate()` call. */
  maxErrors?: number;
  /** Cap on recursion depth through `$ref` cycles per `validate()` call. */
  maxDepth?: number;
  /** Custom compiler for `pattern` keywords and `format: "regex"`. */
  regexCompiler?: RegexCompiler;
}

/**
 * The JSON-Schema-flavored typeof function: distinguishes `integer`,
 * `number`, `null`, `array`, `object`, etc. (everything that JSON Schema
 * 2020-12's `type` keyword recognizes).
 *
 * @param value - Any value.
 * @returns The JSON Schema type name.
 *
 * @example
 * ```ts
 * typeOf(null);      // "null"
 * typeOf([]);        // "array"
 * typeOf(1);         // "integer"
 * typeOf(1.5);       // "number"
 * ```
 *
 * @public
 */
export function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "object") return "object";
  if (t === "string") return "string";
  if (t === "boolean") return "boolean";
  if (t === "number") return Number.isInteger(value) ? "integer" : "number";
  return t;
}

/**
 * Find the first pair of structurally-equal elements in `arr`. Backs
 * the `uniqueItems` keyword: primitives hit a `Map` fast path (O(N)),
 * while objects/arrays fall back to pairwise `deepEqual` against the
 * running list of seen non-primitives (O(k²) in the object-count
 * tail, unavoidable without hashing). One seam between the paths:
 * the `Map` compares by SameValueZero, so a bare `NaN` duplicates
 * itself, while `deepEqual` (like `===`) treats `NaN` as unequal, so
 * objects containing `NaN` never match.
 *
 * @param arr - The array to scan.
 * @returns `{ a, b }` with `a < b` for the first duplicate pair, or
 *          `null` when every element is unique.
 *
 * @public
 */
export function findDuplicate(arr: readonly unknown[]): { a: number; b: number } | null {
  const primitives = new Map<unknown, number>();
  const objects: Array<{ val: unknown; idx: number }> = [];
  for (let i = 0; i < arr.length; i += 1) {
    const v = arr[i];
    if (v !== null && typeof v === "object") {
      for (const o of objects) {
        if (deepEqual(v, o.val)) return { a: o.idx, b: i };
      }
      objects.push({ val: v, idx: i });
    } else {
      const first = primitives.get(v);
      if (first !== undefined) return { a: first, b: i };
      primitives.set(v, i);
    }
  }
  return null;
}

/**
 * Count the Unicode code points in `s` without allocating. Replaces
 * `[...s].length`, whose intermediate array blows up on large strings
 * before the `maxLength` check can reject them.
 *
 * @param s - The string to measure.
 * @returns The number of Unicode code points.
 *
 * @example
 * ```ts
 * countCodePoints("hi");     // 2
 * countCodePoints("🎉");     // 1 (a single astral code point)
 * ```
 *
 * @public
 */
export function countCodePoints(s: string): number {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- iterator drives the counter
  for (const _ of s) n++;
  return n;
}

/**
 * True iff `s` has strictly more than `limit` Unicode code points,
 * deciding from `s.length` (UTF-16 code units) without walking the
 * string whenever possible. Backs `maxLength`.
 *
 * A string of U code units holds between `ceil(U/2)` and `U` code
 * points (each code point is one or two units). So:
 *   - `U <= limit`     => count <= limit, cannot exceed. No walk.
 *   - `U > 2 * limit`  => count >= ceil(U/2) > limit, must exceed. No walk.
 *   - otherwise walk, stopping as soon as the count passes `limit`.
 *
 * The common case (ASCII / BMP strings inside their bound) is decided
 * by the first check, so valid data never pays the O(n) scan, and even
 * the worst case walks at most `limit + 1` code points.
 *
 * @param s - The string to measure.
 * @param limit - The `maxLength` bound (a non-negative integer).
 * @returns `true` when `s` exceeds the bound.
 *
 * @public
 */
export function exceedsMaxCodePoints(s: string, limit: number): boolean {
  const u = s.length;
  if (u <= limit) return false;
  if (u > 2 * limit) return true;
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- iterator drives the counter
  for (const _ of s) {
    n += 1;
    if (n > limit) return true;
  }
  return false;
}

/**
 * True iff `s` has strictly fewer than `limit` Unicode code points,
 * deciding from `s.length` (UTF-16 code units) without walking the
 * string whenever possible. Backs `minLength`.
 *
 * With `count` in `[ceil(U/2), U]` for `U = s.length`:
 *   - `U < limit`         => count <= U < limit, must be below. No walk.
 *   - `U >= 2 * limit - 1` => count >= ceil(U/2) >= limit, cannot be below. No walk.
 *   - otherwise walk, stopping as soon as the count reaches `limit`.
 *
 * @param s - The string to measure.
 * @param limit - The `minLength` bound (a non-negative integer).
 * @returns `true` when `s` is shorter than the bound.
 *
 * @public
 */
export function belowMinCodePoints(s: string, limit: number): boolean {
  const u = s.length;
  if (u < limit) return true;
  if (u >= 2 * limit - 1) return false;
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- iterator drives the counter
  for (const _ of s) {
    n += 1;
    if (n >= limit) return false;
  }
  return true;
}

/**
 * Structural equality for JSON values: honors array ordering, object key
 * sets (not ordering), and NaN-as-not-equal. Used by `enum`, `const`, and
 * `uniqueItems`.
 *
 * Iterative, over an explicit work stack of pairs left to compare, so a
 * deeply nested payload cannot overflow the native call stack. A recursive
 * walk would throw `RangeError: Maximum call stack size exceeded` on the
 * same small-but-deep input the validator is meant to reject.
 *
 * @param a - First value.
 * @param b - Second value.
 * @returns `true` when both values are structurally equal.
 *
 * @example
 * ```ts
 * deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }); // true
 * deepEqual([1, 2], [2, 1]);                 // false
 * ```
 *
 * @public
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  const stack: Array<[unknown, unknown]> = [[a, b]];
  while (stack.length > 0) {
    const [x, y] = stack.pop()!;
    if (x === y) continue;
    if (typeof x !== typeof y) return false;
    if (x === null || y === null) return false;
    if (Array.isArray(x)) {
      if (!Array.isArray(y) || x.length !== y.length) return false;
      for (let i = 0; i < x.length; i += 1) stack.push([x[i], y[i]]);
      continue;
    }
    if (typeof x === "object") {
      if (typeof y !== "object" || Array.isArray(y)) return false;
      const xObj = x as Record<string, unknown>;
      const yObj = y as Record<string, unknown>;
      const xKeys = Object.keys(xObj);
      if (xKeys.length !== Object.keys(yObj).length) return false;
      for (const key of xKeys) {
        if (!Object.prototype.hasOwnProperty.call(yObj, key)) return false;
        stack.push([xObj[key], yObj[key]]);
      }
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Combine an error accumulator into a single ValidationError, collapsing the
 * trivial cases: empty → null, single → the one error, otherwise wrap.
 *
 * @param code - Wrapping error's code when multiple errors are present.
 * @param path - Path for the wrapping error.
 * @param errors - The accumulated errors.
 * @returns `null` when there are no errors, else the (possibly wrapped) error.
 *
 * @example
 * ```ts
 * wrapErrors("schema", [], []);          // null
 * wrapErrors("schema", [], [onlyError]); // onlyError
 * wrapErrors("schema", [], [a, b]);      // { code: "schema", children: [a, b], ... }
 * ```
 *
 * @public
 */
export function wrapErrors(
  code: string,
  path: readonly (string | number)[],
  errors: ValidationError[],
): ValidationError | null {
  if (errors.length === 0) return null;
  if (errors.length === 1 && errors[0] !== undefined) return errors[0];
  return createBranchError(code, [...path], "schema validation failed", errors);
}

/**
 * Flat-mode error merge: append every error in `src` onto `dest` and
 * return the combined list. The runtime backing for every flat-mode
 * lift site (see {@link ValidatorDeps.appendErrors}).
 *
 * Adopts `src` directly when `dest` is `null` (the common first-lift
 * case allocates nothing); returns `dest` unchanged when `src` is
 * `null`. Iterates rather than spreading (`dest.push(...src)` overflows
 * the call stack for large `src`).
 *
 * @example
 * ```ts
 * appendErrors(null, [a]);     // [a]   (adopts src)
 * appendErrors([a], null);     // [a]   (dest unchanged)
 * appendErrors([a], [b, c]);   // [a, b, c]
 * ```
 *
 * @public
 */
export function appendErrors(
  dest: ValidationError[] | null,
  src: ValidationError[] | null,
): ValidationError[] | null {
  if (src === null) return dest;
  if (dest === null) return src;
  for (const e of src) dest.push(e);
  return dest;
}

/**
 * Build a {@link ValidatorDeps} bundle with fresh mutable caches.
 *
 * Accepts either a positional `maxErrors` (legacy) or an options
 * bag with `maxErrors`, `maxDepth` and `regexCompiler`. The positional form is
 * kept for back-compat with AOT-emitted modules built before the
 * options bag existed.
 *
 * @returns A new deps object wired with the default runtime helpers
 *          and a built-in `regex` format that shares the
 *          {@link RegexCompiler} hook with the `pattern` keyword but
 *          bypasses the {@link ValidatorDeps.patterns} cache so
 *          runtime values aren't retained.
 *
 * @public
 */
export function createDeps(maxErrors?: number): ValidatorDeps;
export function createDeps(options?: CreateDepsOptions): ValidatorDeps;
export function createDeps(arg?: number | CreateDepsOptions): ValidatorDeps {
  const options: CreateDepsOptions = typeof arg === "number" ? { maxErrors: arg } : (arg ?? {});
  const maxErrors = options.maxErrors ?? Number.POSITIVE_INFINITY;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const regexCompiler = options.regexCompiler;
  const patterns = new Map<string, CompiledRegex>();

  // The `pattern` keyword's compile path: `u`-mode, falling back to
  // no-flag. The fallback is deliberate and load-bearing. Real specs
  // carry patterns that are legal ECMA-262 only outside `u` mode (Annex
  // B identity escapes are the common case), and a pattern is *spec
  // input*: refusing it means the document cannot be opened at all,
  // rather than one value failing validation.
  const compilePatternRegex = (pattern: string): CompiledRegex => {
    if (regexCompiler !== undefined) return regexCompiler(pattern);
    try {
      return new RegExp(pattern, "u");
    } catch (errU) {
      try {
        return new RegExp(pattern);
      } catch {
        // Surface the stricter (`u`-mode) error; it's more informative
        // when both modes reject the pattern.
        throw errU;
      }
    }
  };

  // The `regex` format's compile path: `u`-mode only, no fallback.
  //
  // This asks a different question from the keyword. `format: regex` is
  // an assertion *about a data value* ("is this string a valid ECMA-262
  // regular expression?"), and a string that compiles only outside `u`
  // mode is not one. The suite is explicit about it: `\a` is not an
  // ECMA 262 control escape. Sharing the keyword's fallback made the
  // format inherit lenience meant for spec input and quietly accept it.
  //
  // Deliberately asymmetric, in other words, and the asymmetry is the
  // correct reading of two different contracts rather than an oversight.
  // A caller who wants one policy for both supplies `regexCompiler`,
  // which still wins here.
  const compileFormatRegex = (value: string): CompiledRegex => {
    if (regexCompiler !== undefined) return regexCompiler(value);
    return new RegExp(value, "u");
  };

  const compilePattern = (pattern: string): CompiledRegex => {
    const cached = patterns.get(pattern);
    if (cached !== undefined) return cached;
    const re = compilePatternRegex(pattern);
    patterns.set(pattern, re);
    return re;
  };

  // Auto-register the `regex` format. It shares the `regexCompiler`
  // hook with the `pattern` keyword but not the `u`-mode fallback (see
  // above), and skips the memoization to keep memory bounded: runtime
  // values aren't bounded by spec size.
  const formats = new Map<string, NormalizedFormat | null>();
  formats.set("regex", {
    type: "string",
    validate: ((value: string) => {
      try {
        compileFormatRegex(value);
        return true;
      } catch {
        return false;
      }
    }) as (value: never) => boolean,
  });

  return {
    createError,
    createLeafError,
    createBranchError,
    typeOf,
    deepEqual,
    countCodePoints,
    exceedsMaxCodePoints,
    belowMinCodePoints,
    findDuplicate,
    wrapErrors,
    appendErrors,
    patterns,
    compilePattern,
    formats,
    refs: new Map<string, Validator>(),
    customKeywords: new Map<string, CustomKeywordValidator>(),
    maxErrors,
    errorsRemaining: maxErrors,
    truncated: false,
    maxDepth,
    depth: 0,
  };
}

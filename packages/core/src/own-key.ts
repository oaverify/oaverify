/**
 * Own-property writes for keys that come from untrusted input: spec
 * content, overlay content, or an inbound request.
 *
 * @packageDocumentation
 */

/**
 * Assign a key onto a freshly built object without traversing the
 * prototype chain.
 *
 * A plain `target[key] = value` invokes the inherited `__proto__` setter
 * when `key` is `"__proto__"`: no own property is created, the object's
 * prototype is replaced instead, and the value is silently lost. In a
 * resolver or a schema transform that means a constraint the spec author
 * wrote disappears from the document before the compiler ever sees it.
 * `defineProperty` always creates an own enumerable data property.
 *
 * Use this at every rebuild site whose key comes from spec, overlay, or
 * request content. Keys drawn from a fixed vocabulary the code owns
 * (HTTP method names, the subschema-position constants) do not need it.
 *
 * The `key` check keeps the common path a plain assignment, so the cost
 * on a large document is one string comparison per key rather than a
 * `defineProperty` call per key.
 *
 * @internal
 */
export function setSpecKey<T>(target: Record<string, T>, key: string, value: NoInfer<T>): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
}

/**
 * Own-property read from a record whose keys come from untrusted input.
 * The mirror of {@link setSpecKey}: an inherited member must never be
 * mistaken for a value that is present.
 *
 * @internal
 */
export function getOwn<T>(bag: Record<string, T> | undefined, name: string): T | undefined {
  if (bag === undefined) return undefined;
  return Object.hasOwn(bag, name) ? bag[name] : undefined;
}

/**
 * Marker for a header record whose keys are already lowercase.
 *
 * `Symbol.for`, not a module-local symbol: the adapters that set the
 * mark and the validator that reads it can arrive from different
 * installs of this package (npm dedup is not guaranteed), and a
 * registered symbol keeps its identity across them.
 */
const LOWERCASE_KEYS = Symbol.for("oaverify.lowercaseKeys");

/**
 * Promise that every key of `record` is lowercase, so header lookups
 * can skip their case-insensitive fallback.
 *
 * `getHeaderValue` gives a hand-built record HTTP's case-insensitive
 * semantics by scanning every entry when the direct lowercase lookup
 * misses. A declared-but-absent header takes that scan on every
 * request, and for an adapter-built record (keys lowercased at the
 * framework boundary) the scan can never find anything: measured at 24
 * request headers, an absent optional header cost ~175x a present one.
 * The mark tells the lookup the miss is final.
 *
 * The mark is a non-enumerable registered symbol, invisible to
 * `Object.entries`, `JSON.stringify`, and deep-equality assertions.
 * Setting it on a record that carries a mixed-case key makes that key
 * unreachable by header lookups; every adapter lowercases as it
 * builds, which is what earns the mark.
 *
 * @public
 */
export function markLowercaseKeys<T extends object>(record: T): T {
  Object.defineProperty(record, LOWERCASE_KEYS, { value: true });
  return record;
}

/**
 * True when {@link markLowercaseKeys} promised this record's keys are
 * lowercase.
 *
 * @public
 */
export function hasLowercaseKeys(record: object): boolean {
  return (record as Record<symbol, unknown>)[LOWERCASE_KEYS] === true;
}

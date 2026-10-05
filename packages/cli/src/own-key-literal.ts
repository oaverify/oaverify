/**
 * JSON-shaped JavaScript source that keeps an own `__proto__` key.
 *
 * A JSON document can hold an own `__proto__` key: `JSON.parse` creates
 * one, and a spec may name a header or a scheme that way. Written into a
 * module as an object literal, `"__proto__": value` sets the object's
 * prototype instead of creating a property, so the emitted table loses
 * the entry. The computed form `["__proto__"]: value` creates the
 * property.
 *
 * @packageDocumentation
 */

/**
 * `value` as source text in the layout `JSON.stringify(value, null, space)`
 * produces, with any own `__proto__` key written in computed form. A
 * value with no such key is returned exactly as `JSON.stringify` writes
 * it, so the change reaches only modules that need it.
 *
 * The value is read as JSON reads it: `undefined` and function members
 * are dropped, `toJSON` is honoured, a non-finite number is `null`.
 *
 * @internal
 */
export function ownKeyLiteral(value: unknown, space: 0 | 2 = 2): string {
  const text = JSON.stringify(value, null, space);
  // `JSON.parse` keeps an own `__proto__` key as an own property, so the
  // round trip normalizes the value without losing one.
  if (text === undefined || !text.includes('"__proto__"')) return text;
  return write(JSON.parse(text) as unknown, space === 2 ? "\n" : undefined);
}

/** `newline` carries the current indentation; `undefined` writes compact text. */
function write(value: unknown, newline: string | undefined): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inner = newline === undefined ? undefined : `${newline}  `;
  const open = inner ?? "";
  const close = newline ?? "";
  const colon = newline === undefined ? ":" : ": ";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${open}${write(item, inner)}`);
    return `[${items.join(",")}${close}]`;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  const members = keys.map((key) => {
    const name = key === "__proto__" ? '["__proto__"]' : JSON.stringify(key);
    return `${open}${name}${colon}${write((value as Record<string, unknown>)[key], inner)}`;
  });
  return `{${members.join(",")}${close}}`;
}

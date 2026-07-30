export const OBJECT_PROTOTYPE_PROPERTY_NAMES = [
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
] as const;

const OBJECT_PROTOTYPE_PROPERTY_NAME_SET = new Set<string>(OBJECT_PROTOTYPE_PROPERTY_NAMES);

/**
 * True when a string key can be satisfied by an inherited
 * `Object.prototype` member on a plain object.
 *
 * @internal
 */
export function isObjectPrototypePropertyName(name: string): boolean {
  return OBJECT_PROTOTYPE_PROPERTY_NAME_SET.has(name);
}

/**
 * Header records are keyed by lowercase names. Classify the actual
 * lookup key, not the spec casing.
 *
 * @internal
 */
export function isHeaderObjectPrototypePropertyName(name: string): boolean {
  return isObjectPrototypePropertyName(name.toLowerCase());
}

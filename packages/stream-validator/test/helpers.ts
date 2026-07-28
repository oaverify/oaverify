/**
 * Shared narrowing helpers for the stream-validator test suite.
 */

/** Narrow a settled stream result to its error branch. */
export function asError(value: unknown): Error {
  if (!(value instanceof Error)) throw new Error(`expected an Error, got ${typeof value}`);
  return value;
}

/**
 * First element, asserted present. Indexed access is
 * possibly-undefined under `noUncheckedIndexedAccess`, and these tests
 * mean "there is one and this is it" -- so say that, and fail loudly if
 * the stream produced nothing.
 */
export function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("expected at least one item, got none");
  return item;
}

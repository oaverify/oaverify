/**
 * The key half of the `--severity` grammar, on its own.
 *
 * "Which findings does this name" is asked by more than one option:
 * `--severity` grades what a key selects, `--skip` suppresses it. The
 * key space is the same in both, and so is the refusal a typo earns, so
 * it lives here rather than inside either caller.
 *
 * @packageDocumentation
 */

import { CHECK_CODES, CHECK_FAMILIES } from "./codes.js";
import { CHECK_CLASSES } from "./finding.js";

/**
 * What a key names, once resolved against what `check` can emit.
 *
 * Three kinds rather than one string because the lookup differs: a
 * class matches a finding's `class`, a family matches a `/`-prefix of
 * its `code`, and a code matches exactly.
 *
 * @public
 */
export type FindingKey =
  | { readonly kind: "code"; readonly value: string }
  | { readonly kind: "family"; readonly value: string }
  | { readonly kind: "class"; readonly value: string };

/**
 * Either the resolved key, or why it was refused.
 *
 * A result rather than a thrown error so each caller keeps its own
 * error type and its own sentence around the reason: `--severity`
 * refuses a key it cannot grade, `--skip` refuses one it cannot
 * suppress, and the two say so in their own words.
 *
 * @public
 */
export type FindingKeyResult =
  | { readonly ok: true; readonly key: FindingKey }
  | { readonly ok: false; readonly reason: string };

/**
 * A hint for a rejected code key, as a trailing clause. Dozens of codes
 * across six classes is too many to print, and a mistyped code is nearly
 * always the wrong member of a family the caller had right.
 */
function nearestCode(key: string): string {
  const family = key.slice(0, key.indexOf("/"));
  const siblings = [...CHECK_CODES].filter((code) => code.startsWith(`${family}/`)).sort();
  if (siblings.length > 0) return `; "${family}/" holds ${siblings.join(", ")}`;
  return `; known families are ${[...CHECK_FAMILIES].sort().join(", ")}`;
}

/**
 * Resolve one key against {@link CHECK_CODES}, {@link CHECK_FAMILIES}
 * and {@link CHECK_CLASSES}.
 *
 * A key is an exact code (`unsatisfiable/pattern-length`), a family
 * (`unsatisfiable/*`), or a class (`redos`). A key matching nothing is
 * refused, not returned: a typo in a CI flag that silently selects
 * nothing is the failure this validation exists to prevent.
 *
 * The key spaces are taken from this package rather than passed in, for
 * the reason on {@link parseSeverityMap}: injecting them would let a
 * caller accept a class `checkSpec` will never emit, or refuse one it
 * does.
 *
 * `malformed` is not special here. It is refused as "not a class",
 * which is true, and a caller that owes the reader a better sentence
 * (both of today's do) checks for it before calling.
 *
 * @param key - The key text, already trimmed.
 *
 * @public
 */
export function parseFindingKey(key: string): FindingKeyResult {
  const knownClasses: readonly string[] = CHECK_CLASSES;

  if (key === "") return { ok: false, reason: "no key" };

  if (key.endsWith("/*")) {
    const family = key.slice(0, -2);
    if (!CHECK_FAMILIES.has(family)) {
      return {
        ok: false,
        reason: `"${family}" is not a code family (${[...CHECK_FAMILIES].sort().join(", ")})`,
      };
    }
    return { ok: true, key: { kind: "family", value: family } };
  }
  if (key.includes("*")) {
    return { ok: false, reason: `"*" is only allowed as a trailing "/*"` };
  }
  if (knownClasses.includes(key)) {
    // A class wins over a code of the same spelling; none collide today.
    return { ok: true, key: { kind: "class", value: key } };
  }
  if (CHECK_CODES.has(key)) {
    return { ok: true, key: { kind: "code", value: key } };
  }
  if (key.includes("/")) {
    return { ok: false, reason: `"${key}" is not a code oaverify emits${nearestCode(key)}` };
  }
  return {
    ok: false,
    reason: `"${key}" is not a class (${knownClasses.join(", ")}) or a code oaverify emits`,
  };
}

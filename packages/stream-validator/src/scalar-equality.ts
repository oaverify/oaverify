/**
 * The retention bound for a string that only scalar `enum` / `const` need.
 * Shared by the spine, which stops holding the text past it, and the
 * analyzer, which reports it; a module of its own so the analyzer stays
 * engine-free.
 *
 * @packageDocumentation
 */

import type { SchemaObject } from "@oaverify/internal-core";

/**
 * The longest string among the `enum` and `const` candidates of `schemas`,
 * in UTF-16 units, or -1 when none is a string. A string longer than this
 * equals no candidate.
 *
 * @internal
 */
export function longestStringCandidate(schemas: readonly SchemaObject[]): number {
  let longest = -1;
  for (const s of schemas) {
    if (Array.isArray(s.enum)) {
      for (const e of s.enum) if (typeof e === "string" && e.length > longest) longest = e.length;
    }
    const c = (s as { const?: unknown }).const;
    if ("const" in s && typeof c === "string" && c.length > longest) {
      longest = c.length;
    }
  }
  return longest;
}

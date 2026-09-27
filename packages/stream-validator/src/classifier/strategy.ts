/**
 * The four streaming strategies and their join lattice.
 *
 * @packageDocumentation
 */

/**
 * How a subschema node is handled by the engine:
 *
 *   - `stream`: validated forward on the spine in one pass, no buffering.
 *   - `tee`: the event stream is fanned out to sub-state-machines and
 *     combined at scope-close (forward composition); no buffering.
 *   - `buffer`: the subtree is materialized and handed to the in-memory
 *     validator (an island).
 *   - `reject`: cannot be soundly streamed; a compile-time error.
 *
 * @public
 */
export type Strategy = "stream" | "tee" | "buffer" | "reject";

const RANK: Record<Strategy, number> = { stream: 0, tee: 1, buffer: 2, reject: 3 };
const BY_RANK: Strategy[] = ["stream", "tee", "buffer", "reject"];

/**
 * Join two strategies on the lattice `stream < tee < buffer < reject`.
 * The dominant one wins: a scope is no more streamable than its least
 * streamable coupled part.
 *
 * @public
 */
export function joinStrategy(a: Strategy, b: Strategy): Strategy {
  return BY_RANK[Math.max(RANK[a], RANK[b])] as Strategy;
}

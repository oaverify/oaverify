/**
 * Source provenance for a resolved document: which file each part of it
 * came from, where in that file, and the references that reached it.
 *
 * `resolveSpec` rebuilds every node, so identity between a source node
 * and a resolved node is gone by the time anything grades the document.
 * What survives is coarser and cheaper: the resolver knows that the
 * subtree at one resolved pointer was built from one source document at
 * one pointer within it. That is a {@link SpecRegion}, and a whole
 * resolution produces a number of them proportional to the external
 * references followed rather than to the nodes walked.
 *
 * An address for any single node is then recovered by subtraction:
 * find the region covering the node's resolved pointer, and append
 * whatever the pointer has below the region's mount point.
 * {@link sourceOf} is that operation and is the only place the rule
 * lives, so a consumer never re-derives it.
 *
 * @packageDocumentation
 */

/**
 * One reference that was followed on the way to a source document.
 *
 * `pointer` addresses the `$ref` node itself, in the document named by
 * `uri`, so following a hop lands on the reference rather than on the
 * file that holds it. That is finer than the file-granular referrer
 * trail the resolver keeps for read errors, and is what a "show me the
 * reference that pulled this in" reader needs.
 *
 * @public
 */
export interface SourceHop {
  /** The document the reference was written in. */
  readonly uri: string;
  /** RFC 6901 pointer to the `$ref` node, within that document. */
  readonly pointer: string;
}

/**
 * Where a node in the resolved document came from.
 *
 * Present or absent as a unit: `uri` and `pointer` are known together
 * or not at all, and `via` is always present when the address is. A
 * partially-known address would be a guess, and #593's precedent is
 * that a wrong address is worse than none because absence is checkable.
 *
 * The claim this makes is about **address, not value**: the resolved
 * node was built from the node at this address. It does not claim the
 * two hold the same value. The resolver rewrites external `$ref`
 * strings into internal ones on the way through, and a merged non-schema
 * node takes some of its keys from the referring document, so a
 * value-equality contract would have to abstain on the most common node
 * shape in a resolved multi-file spec.
 *
 * A line/column range is the field this shape is designed to gain: it
 * refines an address that `uri` and `pointer` already fix, so adding it
 * cannot change what any field here means.
 *
 * @public
 */
export interface SourceAddress {
  /** The document this node was built from. */
  readonly uri: string;
  /** RFC 6901 pointer to the node, within that document. */
  readonly pointer: string;
  /**
   * The references the resolver followed to reach `uri`, outermost
   * first. Empty means the node was reached in the entry document
   * without crossing a reference.
   *
   * This is how the **resolver** first reached the document, not the
   * route by which any particular finding reached the node. An external
   * schema is hoisted once and shared by every use site, so where a
   * finding's anchor is `definition` or `scoped-definition` the two are
   * different walks. That caveat is the same one `anchor` already
   * carries for the resolved pointer.
   */
  readonly via: readonly SourceHop[];
}

/**
 * A stretch of the resolved document's pointer space with one answer
 * about where it came from.
 *
 * `at` is an RFC 6901 pointer into the **resolved** document and covers
 * itself plus everything below it. Regions overlap freely; the deepest
 * one covering a node wins, and among equally deep ones the last in the
 * list wins. Both rules are load-bearing:
 *
 * - Depth is how a hoisted component, a sibling key that came from the
 *   referring document, or a stitched external overrides the broader
 *   region it sits inside.
 * - Order is how a later pass invalidates an earlier claim at the same
 *   depth, which is what an overlay rewriting a node in place does.
 *
 * @public
 */
export type SpecRegion =
  /** Built from `uri` at `pointer`, reached by `via`. */
  | {
      readonly kind: "mounted";
      readonly at: string;
      readonly uri: string;
      readonly pointer: string;
      readonly via: readonly SourceHop[];
    }
  /**
   * Exists only in the resolved document. The container the resolver
   * invented to hold hoisted schemas, the root extension stitched
   * externals live under, and anything an overlay rewrote or added.
   * Covered nodes have no source address, which is a fact about them
   * rather than a gap in what was recorded.
   */
  | { readonly kind: "synthetic"; readonly at: string };

/**
 * Does `at` cover `pointer`, treating both as RFC 6901?
 *
 * Segment-wise, not string-wise: `/foo` covers `/foo/bar` and does not
 * cover `/foobar`. The root pointer `""` covers everything.
 */
function covers(at: string, pointer: string): boolean {
  if (at === "") return true;
  if (!pointer.startsWith(at)) return false;
  return pointer.length === at.length || pointer.charCodeAt(at.length) === 0x2f; /* "/" */
}

/**
 * Where the node at a resolved pointer came from, or `undefined` if no
 * source node corresponds to it.
 *
 * `undefined` covers two cases that are one answer to a caller: the
 * node is synthetic, or nothing was recorded about it. Callers that
 * need to tell "provenance was never tracked" apart from "tracked, and
 * this node has no source" do it by whether they were handed regions at
 * all, not by inspecting a result.
 *
 * @param regions - Regions from the resolution that produced the document.
 * @param pointer - RFC 6901 pointer into the resolved document.
 *
 * @public
 */
export function sourceOf(
  regions: readonly SpecRegion[],
  pointer: string,
): SourceAddress | undefined {
  let best: SpecRegion | undefined;
  for (const region of regions) {
    if (!covers(region.at, pointer)) continue;
    // Deepest wins; equal depth resolves to the later region, so a pass
    // that runs after the walk can invalidate what the walk claimed.
    if (best !== undefined && region.at.length < best.at.length) continue;
    best = region;
  }
  if (best === undefined || best.kind === "synthetic") return undefined;
  return {
    uri: best.uri,
    pointer: best.pointer + pointer.slice(best.at.length),
    via: best.via,
  };
}

/**
 * Mark a subtree of the resolved document as having no source, and drop
 * every region underneath it.
 *
 * Dropping the descendants is the whole point. A synthetic region alone
 * suppresses only what it is at least as deep as, so a mount below the
 * marked pointer would keep answering with an address that no longer
 * describes the node there. This is the shape an overlay produces: it
 * rewrites an ancestor and everything below it becomes unattributable
 * in one step.
 *
 * Returns a new list; the input is not modified.
 *
 * @param regions - Regions recorded so far.
 * @param at - RFC 6901 pointer into the resolved document.
 *
 * @public
 */
export function withSynthetic(regions: readonly SpecRegion[], at: string): SpecRegion[] {
  const kept = regions.filter((region) => !(region.at.length > at.length && covers(at, region.at)));
  kept.push({ kind: "synthetic", at });
  return kept;
}

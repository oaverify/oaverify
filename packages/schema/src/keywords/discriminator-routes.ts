/**
 * Resolving a `discriminator` to the branch each value selects.
 *
 * Shared by {@link discriminatorKeyword}'s codegen and the
 * `silent-rewrite/discriminator-unroutable` lint so the two cannot
 * disagree about whether a mapping routes: the lint would otherwise
 * report a dead mapping the compiler was happily using, or stay quiet
 * about one the compiler had given up on.
 *
 * @packageDocumentation
 */

/** What a discriminator's values resolve to, and what failed to resolve. */
export interface DiscriminatorRoutes {
  /** Discriminator value -> index into the branch array. */
  routes: Map<string, number>;
  /**
   * Keys of `mapping` whose value named no branch. An author wrote these
   * down, so they are a defect rather than an absent case.
   */
  deadMappingKeys: string[];
  /**
   * Whether the discriminator can route at all.
   *
   * `false` when there is nothing to route with (no branch carries a
   * `$ref` and no mapping value matched) or when the routing table is
   * only partly usable. A partial table is treated as unusable
   * deliberately: routing the values that resolve and rejecting the ones
   * that do not would reject payloads the author documented as valid,
   * and the composition beside the discriminator is the normative
   * constraint either way. The cost is the sharper single-branch error
   * message, which is worth less than a correct verdict.
   */
  usable: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Work out which branch each discriminator value selects.
 *
 * Matching is by `$ref` string, in two steps per the OpenAPI spec's
 * implicit and explicit forms: a branch's `$ref` contributes its last
 * path segment as an implicit value, and a `mapping` entry overrides
 * that by naming either a whole `$ref` or its last segment.
 *
 * @param discriminator - The Discriminator Object.
 * @param branches - The sibling `oneOf` / `anyOf` array.
 *
 * @internal
 */
export function computeDiscriminatorRoutes(
  discriminator: unknown,
  branches: readonly unknown[],
): DiscriminatorRoutes {
  const mapping =
    isObj(discriminator) && isObj(discriminator["mapping"]) ? discriminator["mapping"] : {};

  const routes = new Map<string, number>();
  const byLastSegment = new Map<string, number>();
  for (const [index, branch] of branches.entries()) {
    if (!isObj(branch)) continue;
    const ref = branch["$ref"];
    if (typeof ref !== "string") continue;
    const last = ref.split("/").pop();
    if (last !== undefined) {
      byLastSegment.set(last, index);
      // The implicit form: a branch named `Cat` accepts the value `cat`
      // spelled exactly as the component is.
      routes.set(last, index);
    }
  }

  const deadMappingKeys: string[] = [];
  for (const [value, target] of Object.entries(mapping)) {
    if (typeof target !== "string") {
      deadMappingKeys.push(value);
      continue;
    }
    const direct = branches.findIndex(
      (b) => isObj(b) && typeof b["$ref"] === "string" && b["$ref"] === target,
    );
    if (direct >= 0) {
      routes.set(value, direct);
      continue;
    }
    const last = target.split("/").pop();
    const viaSegment = last === undefined ? undefined : byLastSegment.get(last);
    if (viaSegment !== undefined) {
      routes.set(value, viaSegment);
      continue;
    }
    deadMappingKeys.push(value);
  }

  return {
    routes,
    deadMappingKeys,
    usable: routes.size > 0 && deadMappingKeys.length === 0,
  };
}

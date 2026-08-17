import { describe, expect, it } from "vitest";
import {
  SUBSCHEMA_ARRAY_POSITIONS,
  SUBSCHEMA_MAP_POSITIONS,
  SUBSCHEMA_MIXED_MAP_POSITIONS,
  SUBSCHEMA_SINGLE_POSITIONS,
} from "@oaverify/internal-core/subschema-positions";
import { jsonSchemaDialect, oas30Dialect, openapi31Dialect } from "../src/keywords/vocabulary.js";
import type { Dialect } from "../src/keywords/types.js";

/**
 * Pins `core`'s subschema-position table against the keyword table the
 * compiler dispatches on.
 *
 * Two descriptions of "where subschemas live" exist, and both are
 * load-bearing. The positions are pure data, consumed by walkers in
 * four packages that have no compiler (the spec resolver, the stream
 * analyzer, the validator's document walk). `KeywordDefinition.applicator`
 * is a codegen fact, consumed only by the subschema inliner. Neither
 * subsumes the other, so they cannot be merged, and nothing checked
 * them against each other: `dependencies` carried `applicator: true`
 * for its schema-valued entries while being absent from the positions,
 * which cost `unevaluated*` a correct verdict in both directions.
 *
 * This test is what stops the two drifting again. A keyword gaining or
 * losing `applicator` fails here unless the positions move with it, or
 * unless it is named below with the reason it is exempt.
 */

/**
 * Positions that hold subschemas but are not applicators.
 *
 * A container holds schemas without ever applying them to an instance,
 * so a walker must descend and the compiler must not. `$defs` is
 * declared `annotation: true` with an empty `compile()`, which is the
 * same statement from the other side.
 *
 * `then` / `else` are subschema positions with no keyword of their own:
 * the `if` keyword compiles all three.
 */
const POSITIONS_WITHOUT_A_KEYWORD: ReadonlySet<string> = new Set([
  "$defs",
  "definitions",
  "then",
  "else",
]);

/**
 * Applicators with no subschema position of their own.
 *
 * `discriminator` descends, but into schemas reached through its
 * sibling `oneOf` / `anyOf` and through `$ref`s named in its `mapping`.
 * It owns no key that holds a subschema, so a positional walker has
 * nothing to visit and must not invent one.
 */
const KEYWORDS_WITHOUT_A_POSITION: ReadonlySet<string> = new Set(["discriminator"]);

const ALL_POSITIONS: ReadonlySet<string> = new Set<string>([
  ...SUBSCHEMA_SINGLE_POSITIONS,
  ...SUBSCHEMA_ARRAY_POSITIONS,
  ...SUBSCHEMA_MAP_POSITIONS,
  ...SUBSCHEMA_MIXED_MAP_POSITIONS,
]);

function applicatorKeywords(...dialects: Dialect[]): Set<string> {
  const out = new Set<string>();
  for (const dialect of dialects) {
    for (const vocab of dialect.vocabularies) {
      for (const kw of vocab.keywords) {
        if (kw.applicator === true) out.add(kw.keyword);
      }
    }
  }
  return out;
}

describe("core's subschema positions against the compiler's keyword table", () => {
  const applicators = applicatorKeywords(jsonSchemaDialect, openapi31Dialect, oas30Dialect);

  it("every applicator holds its subschemas at a known position", () => {
    const missing = [...applicators]
      .filter((kw) => !ALL_POSITIONS.has(kw) && !KEYWORDS_WITHOUT_A_POSITION.has(kw))
      .sort();
    // A keyword here descends into subschemas that no walker can find:
    // anchors under it do not resolve, `unevaluated*` does not see
    // through it, and the spec resolver will not hoist an external
    // `$ref` written inside it.
    expect(missing).toEqual([]);
  });

  it("every position is an applicator, or is a container with a stated reason", () => {
    const unexplained = [...ALL_POSITIONS]
      .filter((key) => !applicators.has(key) && !POSITIONS_WITHOUT_A_KEYWORD.has(key))
      .sort();
    expect(unexplained).toEqual([]);
  });

  it("the exemptions are still real, so a stale one cannot sit here unnoticed", () => {
    // If `discriminator` ever gains a subschema key, or `$defs` becomes
    // an applicator, the exemption is wrong rather than merely unused.
    for (const kw of KEYWORDS_WITHOUT_A_POSITION) {
      expect(ALL_POSITIONS.has(kw)).toBe(false);
    }
    for (const key of POSITIONS_WITHOUT_A_KEYWORD) {
      expect(applicators.has(key)).toBe(false);
      // `then` / `else` have no keyword at all; `$defs` / `definitions`
      // are positions. Either way none of them may be an applicator.
    }
  });

  it("the mixed positions are not also claimed as uniform ones", () => {
    for (const key of SUBSCHEMA_MIXED_MAP_POSITIONS) {
      expect(SUBSCHEMA_MAP_POSITIONS as readonly string[]).not.toContain(key);
    }
  });
});

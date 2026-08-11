/**
 * The compile context's three groups are a claim about the code (#349).
 *
 * `KeywordCompileContext`'s TSDoc and `docs/extending.md` both tell a
 * keyword author that the mode flags are not theirs: they exist for the
 * keywords that inspect a sub-validator's return value, and both name
 * the files that read one so the reader can check the claim against
 * something.
 *
 * A named set goes stale silently, which is the failure this file
 * exists to make loud. If a sixth file starts reading a mode flag, the
 * signal the issue was about is quietly wrong and nothing else says so.
 * The same reasoning `span-target.test.ts` gives for pinning its own
 * table: the failure has no other symptom.
 *
 * This asserts what is true today. It is not a rule that a new keyword
 * may not read a flag; it is a prompt to update the two places that
 * describe the surface when one does.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const keywordsDir = fileURLToPath(new URL("../src/keywords/", import.meta.url));

/** The flags the docs group together as "not for a leaf keyword". */
const MODE_FLAGS = ["predicate", "flat", "gated", "depthGated", "unevaluatedTracking"] as const;

/**
 * Files the two docs name as reading a mode flag, sorted.
 *
 * Every one of them inspects a sub-validator's return value, whose type
 * changes with the mode, which is the reason the group exists at all.
 */
const READERS = [
  "composition.ts",
  "discriminator.ts",
  "items.ts",
  "object-validation.ts",
  "ref.ts",
] as const;

function filesReadingAModeFlag(): string[] {
  // `ctx.` qualified, so a local variable that happens to be called
  // `flat` is not mistaken for the context member.
  const pattern = new RegExp(`\\bctx\\.(?:${MODE_FLAGS.join("|")})\\b`);
  return readdirSync(keywordsDir)
    .filter((name) => name.endsWith(".ts") && name !== "types.ts" && name !== "index.ts")
    .filter((name) => pattern.test(readFileSync(`${keywordsDir}${name}`, "utf8")))
    .sort();
}

describe("the mode flags belong to the keywords that read a sub-validator", () => {
  it("is read by exactly the files the docs name", () => {
    expect(
      filesReadingAModeFlag(),
      "a keyword started or stopped reading a mode flag; update the group " +
        "roadmap on KeywordCompileContext and the same list in docs/extending.md",
    ).toEqual([...READERS]);
  });

  it("is read by no leaf keyword, which is the claim that matters", () => {
    // The useful half for someone writing their first keyword. Named
    // separately from the list above so a failure says which claim
    // broke: a new compound keyword joining the set is ordinary, a leaf
    // keyword reaching for a flag is the thing worth looking at.
    const leaves = ["string.ts", "number.ts", "equality.ts", "type.ts"];
    const present = new Set(readdirSync(keywordsDir));
    for (const leaf of leaves) {
      // A renamed file would make the assertion below vacuous, which is
      // how this test would stop testing without failing.
      expect(present.has(leaf), `${leaf} no longer exists; pick another leaf keyword`).toBe(true);
      expect(filesReadingAModeFlag()).not.toContain(leaf);
    }
  });
});

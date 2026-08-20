/**
 * A migration guide that opens with "N breaking changes" is making a
 * claim about its own headings, and nothing checked it: `migration-v7.md`
 * said seven and carried nine, because two sections were added without
 * the intro being touched (#874).
 *
 * Applies to whichever guides state a count. One does today; a guide
 * that states none is not required to start.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const docs = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs");

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
};

/** The count a guide claims, or undefined where it claims none. */
function claimedCount(src: string): number | undefined {
  const m = /^(\w+) breaking changes\b/im.exec(src);
  if (!m) return undefined;
  const word = m[1]!.toLowerCase();
  return NUMBER_WORDS[word] ?? (/^\d+$/.test(word) ? Number(word) : undefined);
}

const guides = readdirSync(docs)
  .filter((f) => /^migration-v\d+\.md$/.test(f))
  .sort();

describe("migration guides count their own breaking changes correctly", () => {
  it("finds the guides", () => {
    // Guard against the glob silently matching nothing after a rename.
    expect(guides.length).toBeGreaterThan(0);
  });

  for (const file of guides) {
    const src = readFileSync(join(docs, file), "utf8");
    const claimed = claimedCount(src);
    const actual = (src.match(/^## Breaking:/gm) ?? []).length;

    it(`${file} states ${claimed ?? "no"} count against ${actual} sections`, () => {
      if (claimed === undefined) return;
      expect(claimed).toBe(actual);
    });
  }

  it("recognises a stated count at all, so the check cannot pass by finding none", () => {
    expect(claimedCount("Nine breaking changes, and most callers meet one:")).toBe(9);
    expect(claimedCount("12 breaking changes follow.")).toBe(12);
    expect(claimedCount("This release is mostly a naming pass.")).toBeUndefined();
  });
});

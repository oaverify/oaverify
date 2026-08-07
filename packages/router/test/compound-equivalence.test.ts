import { expect, it } from "vitest";
import type { PathItem } from "@oaverify/internal-core";
import { createRouter, parseTemplate, type Segment } from "../src/matcher.js";

/**
 * Compound segments were matched by an anchored regex with one lazy
 * capture per parameter until #730, when the backtracking turned out to
 * be polynomial in the token length: four parameters against a
 * 3200-character token took 38 seconds.
 *
 * The scan that replaced it is linear, and this pins that it answers
 * identically. The regex is rebuilt here from the same parsed pieces and
 * both are run over every token up to five characters, which is where a
 * separator can appear in every position a capture could stop at.
 */
function lazyRegex(seg: Extract<Segment, { kind: "compound" }>): RegExp {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let src = `^${esc(seg.literals[0]!)}`;
  for (let i = 0; i < seg.names.length; i += 1) {
    src += `([\\s\\S]+?)${esc(seg.literals[i + 1]!)}`;
  }
  return new RegExp(`${src}$`);
}

const TEMPLATES = [
  "{a}-{b}",
  "{a}.{b}",
  "{a}-{b}-{c}",
  "{a}--{b}",
  "x{a}",
  "{a}x",
  "x{a}y",
  "{a}.tar.gz",
  "pre-{a}-{b}.json",
  "{a}{b}",
  "{a}{b}{c}",
  // Separators that overlap themselves, or that prefix the suffix. A
  // lazy quantifier and an indexOf scan are easiest to tell apart here,
  // and an alphabet without a repeated separator cannot reach them.
  "{a}aa{b}",
  "{a}aa{b}aa",
  "aa{a}aa",
  "{a}aa{b}a",
  "{a}a{b}aa",
  "{a}xx{b}x",
];
const ALPHA = ["a", "-", ".", "x", "y"];

function allTokens(max: number): string[] {
  const build = (prefix: string, depth: number): string[] => {
    if (depth === 0) return [prefix];
    const out = [prefix];
    for (const c of ALPHA) out.push(...build(prefix + c, depth - 1));
    return out;
  };
  return build("", max).filter((t) => t !== "");
}

const op = { operationId: "o", responses: { "200": { description: "ok" } } };

it("the compound scan answers identically to the lazy regex it replaced", () => {
  const mismatches: string[] = [];
  let compared = 0;
  for (const template of TEMPLATES) {
    const seg = parseTemplate(`/${template}`)[0];
    if (seg?.kind !== "compound") throw new Error(`${template} did not parse as compound`);
    const regex = lazyRegex(seg);
    const router = createRouter({ [`/${template}`]: { get: op } } as Record<string, PathItem>);
    for (const token of allTokens(5)) {
      compared += 1;
      const m = regex.exec(token);
      const expected = m === null ? null : seg.names.map((_, i) => m[i + 1]!);
      const hit = router.match("get", `/${token}`);
      const actual =
        hit?.kind === "match"
          ? seg.names.map((n) => (hit.pathParams as Record<string, string>)[n]!)
          : null;
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        mismatches.push(
          `${template} vs ${JSON.stringify(token)}: regex=${JSON.stringify(expected)} scan=${JSON.stringify(actual)}`,
        );
      }
    }
  }
  // Guards against the loop silently comparing nothing.
  expect(compared).toBeGreaterThan(60_000);
  expect(mismatches.slice(0, 10)).toEqual([]);
});

it("agrees on tokens long enough for the templates with long literals", () => {
  // Depth-5 tokens cannot match a template whose fixed literals are
  // longer than that, so `{a}.tar.gz` and its neighbours were exercised
  // for rejection only. These are the matching halves.
  const cases: Array<[string, string]> = [
    ["{a}.tar.gz", "release-1.2.tar.gz"],
    ["pre-{a}-{b}.json", "pre-alpha-beta.json"],
    ["{a}aa{b}aa", "xaayaa"],
    ["{a}--{b}", "x--y--z"],
  ];
  for (const [template, token] of cases) {
    const seg = parseTemplate(`/${template}`)[0];
    if (seg?.kind !== "compound") throw new Error(`${template} did not parse as compound`);
    const m = lazyRegex(seg).exec(token);
    expect(m).not.toBeNull();
    const router = createRouter({ [`/${template}`]: { get: op } } as Record<string, PathItem>);
    const hit = router.match("get", `/${token}`);
    expect(hit?.kind).toBe("match");
    const captures =
      hit?.kind === "match"
        ? seg.names.map((n) => (hit.pathParams as Record<string, string>)[n]!)
        : [];
    expect(captures).toEqual(seg.names.map((_, i) => m![i + 1]!));
  }
});

it("rejects a token shorter than the fixed literals without a negative slice", () => {
  // `end` goes negative when the suffix outruns the token, so the
  // non-empty check has to run before the slice that uses it.
  const router = createRouter({
    "/x{a}x": { get: op },
    "/{a}.tar.gz": { get: op },
  } as Record<string, PathItem>);
  for (const token of ["x", "xx", "a", ".tar.gz"]) {
    expect(router.match("get", `/${token}`)).toBeUndefined();
  }
  expect(router.match("get", "/xax")?.kind).toBe("match");
});

it("matches a pathological token in linear time", () => {
  // The regex this replaced took ~38s on this input: four lazy captures
  // backtracking over an attacker-controlled token. The bound is loose
  // by four orders of magnitude, so it catches a return to backtracking
  // while staying well clear of anything CI load could disturb.
  const router = createRouter({ "/{a}-{b}-{c}-{d}.json": { get: op } } as Record<string, PathItem>);
  const token = "a-".repeat(1600); // 3200 characters, and never matches
  const started = process.hrtime.bigint();
  expect(router.match("get", `/${token}`)).toBeUndefined();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  expect(ms).toBeLessThan(1000);
});

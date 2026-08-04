import { describe, expect, it } from "vitest";
import type { CheckCode } from "../src/codes.js";
import {
  CHECK_CODES,
  CHECK_FAMILIES,
  CODES_BY_CLASS,
  EXAMPLES_CODES,
  MALFORMED_CODES,
} from "../src/codes.js";
import { CHECK_CLASSES } from "../src/finding.js";

// The union-pinned slices fail the typecheck on drift. The rest are
// hand-written against a literal at an emit site, so they need a test.
// The redos slice is asserted against its emit site in
// `redos-check.test.ts`, which is where that pass lives.
describe("the hand-written slices still match their emit sites", () => {
  // Both need a compiled validator to produce, which `check` owns.
  it("lists the codes each of examples and malformed emits", () => {
    expect([...EXAMPLES_CODES]).toEqual(["example-invalid", "example-uncheckable"]);
    expect([...MALFORMED_CODES]).toEqual(["malformed-schema"]);
  });
});

describe("the registry covers the classes it claims to", () => {
  // `custom` is the one class with no entry, and that is the closed
  // registry holding rather than leaking: its codes are declared by the
  // `--rules` modules a run loads, so they are known at load time and
  // unioned into the code space then. A static entry here would have to
  // be either empty (and false) or open (and unable to reject a typo).
  it("has an entry for every statically-known class, plus malformed", () => {
    expect(Object.keys(CODES_BY_CLASS).sort()).toEqual(
      [...CHECK_CLASSES.filter((c) => c !== "custom"), "malformed"].sort(),
    );
  });

  it("holds no duplicate code across classes", () => {
    const all = Object.values(CODES_BY_CLASS).flatMap((codes) => [...codes]);
    expect(all.length).toBe(CHECK_CODES.size);
  });

  it("derives families from the codes that have one", () => {
    expect([...CHECK_FAMILIES].sort()).toEqual(["silent-rewrite", "unsatisfiable"]);
    for (const family of CHECK_FAMILIES) {
      expect([...CHECK_CODES].some((code) => code.startsWith(`${family}/`))).toBe(true);
    }
  });
});

// `CheckCode` is derived from `CODES_BY_CLASS`, and the derivation is
// the kind that degrades quietly: widen one array's type and the union
// collapses to `string`, which still compiles everywhere and silently
// stops autocompleting. `CheckFinding.code` then means nothing, because
// its `string` half was only ever there to keep unknown codes
// assignable. These two lines fail the typecheck if that happens.
describe("CheckCode stays a literal union", () => {
  it("accepts a code the registry lists and rejects one it does not", () => {
    const known: CheckCode = "unused-component";
    // @ts-expect-error "nonsense" is not a code oaverify emits. If this
    // stops erroring, CheckCode has widened to `string`.
    const unknown: CheckCode = "nonsense";
    expect(CHECK_CODES.has(known)).toBe(true);
    expect(CHECK_CODES.has(unknown)).toBe(false);
  });
});

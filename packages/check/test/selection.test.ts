import { describe, expect, it } from "vitest";
import {
  FindingTermError,
  parseFindingTerms,
  resolveFindingSelection,
  SELECTABLE_CODES,
  type FindingSelection,
} from "../src/selection.js";
import { CODES_BY_CLASS } from "../src/codes.js";

/** Parse and resolve in one step, the way the CLI will. */
function select(value: string): FindingSelection {
  return resolveFindingSelection(parseFindingTerms(value));
}

/** The no-op reason per term, in written order; `null` where live. */
function noops(selection: FindingSelection): (string | null)[] {
  return selection.terms.map((t) => t.noop ?? null);
}

describe("parseFindingTerms", () => {
  it("reads a sign, a kind and a value per term", () => {
    expect(parseFindingTerms("schema,-redos,unsatisfiable/*")).toEqual([
      { text: "schema", exclude: false, key: { kind: "class", value: "schema" } },
      { text: "-redos", exclude: true, key: { kind: "class", value: "redos" } },
      {
        text: "unsatisfiable/*",
        exclude: false,
        key: { kind: "family", value: "unsatisfiable" },
      },
    ]);
  });

  it("refuses an empty value rather than reading it as everything", () => {
    // A CI variable that expanded to nothing must not silently widen the
    // selection; that is the failure the unknown-key refusal prevents.
    expect(() => parseFindingTerms("")).toThrow(FindingTermError);
    expect(() => parseFindingTerms("   ")).toThrow(FindingTermError);
    expect(() => parseFindingTerms(",,")).toThrow(FindingTermError);
  });

  it("refuses an unknown key, with the family's real members", () => {
    expect(() => parseFindingTerms("schemaa")).toThrow(/not a class/);
    expect(() => parseFindingTerms("unsatisfiable/nope")).toThrow(/"unsatisfiable\/" holds/);
  });

  it("refuses malformed in either polarity", () => {
    for (const value of ["malformed", "-malformed", "malformed-schema", "-malformed-schema"]) {
      expect(() => parseFindingTerms(value)).toThrow(/cannot be selected or excluded/);
    }
  });

  it("has no `all` term, since a selection with no inclusion already means everything", () => {
    expect(() => parseFindingTerms("all")).toThrow(FindingTermError);
    expect(select("-redos").base).toEqual(new Set(SELECTABLE_CODES));
  });
});

describe("the six worked cases (#661 brief, §3e)", () => {
  const code = "unsatisfiable/pattern-length";

  it("1. schema,redos,<code> selects schema + redos; the code is redundant", () => {
    const s = select(`schema,redos,${code}`);
    expect(s.classes).toEqual(new Set(["schema", "redos"]));
    expect(noops(s)).toEqual([null, null, "already selected by another term"]);
  });

  it("2. schema,-redos,<code> selects schema; both other terms are no-ops", () => {
    const s = select(`schema,-redos,${code}`);
    expect(s.classes).toEqual(new Set(["schema"]));
    expect(noops(s)).toEqual([
      null,
      "outside the selected findings",
      "already selected by another term",
    ]);
    expect(s.excludeKeys).toEqual([]);
  });

  it("3. schema,-redos,-<code> selects schema minus the code; -redos is a no-op", () => {
    const s = select(`schema,-redos,-${code}`);
    expect(s.classes).toEqual(new Set(["schema"]));
    expect(noops(s)).toEqual([null, "outside the selected findings", null]);
    expect(s.excludeKeys).toEqual([{ kind: "code", value: code }]);
  });

  it("4. -redos selects everything except redos, with no no-op", () => {
    const s = select("-redos");
    expect(noops(s)).toEqual([null]);
    expect(s.excludeKeys).toEqual([{ kind: "class", value: "redos" }]);
    // Every pass still runs: an exclusion never changes what runs.
    expect(s.classes.has("redos")).toBe(true);
  });

  it("5. -<code>,schema reads the same as schema,-<code>: order never matters", () => {
    const forward = select(`schema,-${code}`);
    const reversed = select(`-${code},schema`);
    expect(reversed.base).toEqual(forward.base);
    expect(reversed.classes).toEqual(forward.classes);
    expect(reversed.excludeKeys).toEqual(forward.excludeKeys);
    expect(noops(reversed)).toEqual([null, null]);
  });

  it("6. -format-not-validated,-schema excludes schema; the code is redundant", () => {
    const s = select("-format-not-validated,-schema");
    expect(noops(s)).toEqual(["already excluded by another term", null]);
    expect(s.excludeKeys).toEqual([{ kind: "class", value: "schema" }]);
  });
});

describe("a mutually covering pair", () => {
  // `redos` expands to exactly `ambiguous-pattern`, so neither term is
  // the narrower by expansion and only the spelling separates them.
  // Exactly one must be reported: deleting both would change the
  // selection, so neither is redundant on its own.
  it("reports the code, whichever order it is written in", () => {
    for (const input of ["-redos,-ambiguous-pattern", "-ambiguous-pattern,-redos"]) {
      const s = select(input);
      const reported = s.terms.filter((t) => t.noop !== undefined).map((t) => t.term);
      expect(reported).toEqual(["-ambiguous-pattern"]);
      expect(s.excludeKeys).toEqual([{ kind: "class", value: "redos" }]);
    }
  });

  it("selects the same findings either way", () => {
    const forward = select("-redos,-ambiguous-pattern");
    const reversed = select("-ambiguous-pattern,-redos");
    expect(reversed.base).toEqual(forward.base);
    expect(reversed.classes).toEqual(forward.classes);
  });

  it("keeps skipped[] in the order the terms were written", () => {
    // Evaluation is most-specific-first; the report is not.
    expect(select("-schema,-unused-component").excludeKeys.map((k) => k.value)).toEqual([
      "schema",
      "unused-component",
    ]);
    expect(select("-unused-component,-schema").excludeKeys.map((k) => k.value)).toEqual([
      "unused-component",
      "schema",
    ]);
  });
});

describe("resolveFindingSelection", () => {
  it("runs everything with no terms at all", () => {
    const s = resolveFindingSelection([]);
    expect(s.base).toEqual(new Set(SELECTABLE_CODES));
    expect(s.classes.size).toBe(5);
    expect(s.compileSchemas).toBe(true);
    expect(s.excludeKeys).toEqual([]);
  });

  it("never puts malformed-schema in the selectable universe", () => {
    // The one non-uniformity in the vocabulary, kept in one place: it is
    // absent from the base, so no term can name it and no exclusion can
    // reach it.
    expect(SELECTABLE_CODES.has("malformed-schema")).toBe(false);
    expect(select("-schema").base.has("malformed-schema")).toBe(false);
  });

  it("keeps the compile prepass off for a selection naming only the format walk", () => {
    // The measured seam: `format-not-validated` is a document walk, and
    // every other schema code costs the whole-document compile.
    const walk = select("format-not-validated");
    expect(walk.classes).toEqual(new Set(["schema"]));
    expect(walk.compileSchemas).toBe(false);

    const lint = select("unsatisfiable/pattern-length");
    expect(lint.classes).toEqual(new Set(["schema"]));
    expect(lint.compileSchemas).toBe(true);
  });

  it("keeps the compile prepass on for an exclusion, since exclusions never change what runs", () => {
    // `-schema` is post-run suppression, so the compile still happens and
    // a malformed schema is still found. This is what keeps a malformed
    // finding unsuppressable through the exclusion path.
    const s = select("-schema");
    expect(s.compileSchemas).toBe(true);
    expect(s.classes.has("schema")).toBe(true);
  });

  it("expands a family to its members and a class to its codes", () => {
    const family = select("unsatisfiable/*");
    expect([...family.base].sort()).toEqual([
      "unsatisfiable/enum-member-type",
      "unsatisfiable/pattern-length",
    ]);
    expect(select("redos").base).toEqual(new Set(CODES_BY_CLASS.redos));
  });

  it("reports a term repeated verbatim as redundant, keeping the first live", () => {
    expect(noops(select("redos,redos"))).toEqual([null, "repeats an earlier term"]);
    expect(select("redos,redos").classes).toEqual(new Set(["redos"]));
  });

  it("does not call a lone inclusion redundant", () => {
    // Deleting it would widen the base to everything, so it is doing
    // work even though no other term covers it.
    expect(noops(select("redos"))).toEqual([null]);
  });

  it("keeps a live exclusion that drops nothing, so a stale suppression still reports", () => {
    // A live `-redos` with an empty run reports `x0`, which is the signal
    // `skip.ts` exists for. A no-op term must not be able to imitate it,
    // which is why the two states are separate.
    const s = select("-redos");
    expect(s.excludeKeys).toHaveLength(1);
    expect(s.terms[0]?.noop).toBeUndefined();
  });
});

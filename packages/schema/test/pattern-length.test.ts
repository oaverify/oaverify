import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { compileSchema } from "../src/compiler/compiler.js";
import { stringLengthRange } from "../src/compiler/pattern-length.js";
import { countCodePoints } from "../src/compiler/runtime.js";
import { jsonSchemaDialect } from "../src/keywords/vocabulary.js";

describe("stringLengthRange", () => {
  it("reads a fully anchored fixed-length pattern exactly", () => {
    expect(stringLengthRange("^abc$")).toEqual({ min: 3, max: 3 });
    expect(stringLengthRange("^[a-z][0-9]$")).toEqual({ min: 2, max: 2 });
  });

  it("multiplies a counted quantifier through", () => {
    expect(stringLengthRange("^[0-9]{9}$")).toEqual({ min: 9, max: 9 });
    expect(stringLengthRange("^a{2,4}$")).toEqual({ min: 2, max: 4 });
    expect(stringLengthRange("^a{2,}$")).toEqual({ min: 2, max: Infinity });
    expect(stringLengthRange("^(ab){3}$")).toEqual({ min: 6, max: 6 });
  });

  it("handles the unbounded quantifiers", () => {
    expect(stringLengthRange("^a*$")).toEqual({ min: 0, max: Infinity });
    expect(stringLengthRange("^a+$")).toEqual({ min: 1, max: Infinity });
    expect(stringLengthRange("^ab?$")).toEqual({ min: 1, max: 2 });
    expect(stringLengthRange("^a+?$")).toEqual({ min: 1, max: Infinity });
  });

  it("spans every branch of an alternation", () => {
    expect(stringLengthRange("^(a|bbb)$")).toEqual({ min: 1, max: 3 });
    expect(stringLengthRange("^ab$|^cdef$")).toEqual({ min: 2, max: 4 });
  });

  it("treats anchors, boundaries and lookaround as zero-width", () => {
    expect(stringLengthRange("^\\bab\\b$")).toEqual({ min: 2, max: 2 });
    expect(stringLengthRange("^(?=[a-z])ab$")).toEqual({ min: 2, max: 2 });
    expect(stringLengthRange("^(?!x)ab$")).toEqual({ min: 2, max: 2 });
    expect(stringLengthRange("^(?<=x)ab$")).toEqual({ min: 2, max: 2 });
  });

  it("counts each escape as one code point", () => {
    expect(stringLengthRange("^\\d\\w\\s$")).toEqual({ min: 3, max: 3 });
    expect(stringLengthRange("^\\.\\\\$")).toEqual({ min: 2, max: 2 });
    expect(stringLengthRange("^\\u0041\\x41$")).toEqual({ min: 2, max: 2 });
    expect(stringLengthRange("^\\u{1F600}$")).toEqual({ min: 1, max: 1 });
    expect(stringLengthRange("^[\\]]$")).toEqual({ min: 1, max: 1 });
  });

  it("counts a literal astral character as one code point, matching minLength", () => {
    // `minLength` counts code points (JSON Schema 2020-12 6.3), so the
    // two UTF-16 units this occupies in the pattern source are one.
    expect(stringLengthRange("^\u{1F600}$")).toEqual({ min: 1, max: 1 });
  });

  it("leaves the subject unbounded above when the pattern is not anchored at both ends", () => {
    // `pattern` is a search: "abc" accepts any string containing it.
    expect(stringLengthRange("abc")).toEqual({ min: 3, max: Infinity });
    expect(stringLengthRange("^abc")).toEqual({ min: 3, max: Infinity });
    expect(stringLengthRange("abc$")).toEqual({ min: 3, max: Infinity });
    // One loose branch is enough.
    expect(stringLengthRange("^ab$|cd")).toEqual({ min: 2, max: Infinity });
  });

  it("finds an anchor nested inside a group", () => {
    // The shape from the wild: the anchors sit inside a wrapping group.
    expect(stringLengthRange("(^[a-zA-Z0-9](9)$)")).toEqual({ min: 2, max: 2 });
  });

  it("drops the anchor under a quantifier that can skip it", () => {
    // `(^)*` may match zero times, leaving the pattern unanchored at the
    // start, so the subject is unbounded above: this accepts "a" and
    // "xa" alike. Keeping the anchor flag here would bound it, which is
    // the one direction that invents findings.
    expect(stringLengthRange("(^)*a$")).toEqual({ min: 1, max: Infinity });
    // `^*a$` is what #542 suggested for this; it is not a legal regex in
    // either mode, so the precheck declines it before the parser runs.
    expect(stringLengthRange("^*a$")).toBeUndefined();
  });

  describe("returns unknown rather than guessing", () => {
    const unanalysable = [
      ["a backreference", "^(a)\\1$"],
      ["a named backreference", "^(?<x>a)\\k<x>$"],
      ["a unicode property escape", "^\\p{L}+$"],
      ["a property escape in a class", "^[\\p{L}]$"],
      ["an unbalanced group", "^(ab$"],
      ["a stray close paren", "^ab)$"],
      ["an unterminated class", "^[a-z$"],
      ["an empty class", "^[]$"],
      ["a trailing backslash", "^ab\\"],
      ["a malformed escape payload", "^\\u12$"],
      ["a dangling quantifier", "*abc"],
      ["a modifier group", "^(?i:ab)$"],
      // The runtime falls back to a no-flag RegExp when the `u` compile
      // throws, and these read differently under that fallback: `\01`
      // is one octal escape, `\u{ZZ}` is a literal `u` plus a
      // quantifier. Reading them as `u`-mode syntax over-counts, which
      // is what manufactures a false finding.
      ["a legacy octal escape", "^\\01$"],
      ["a malformed code point escape", "^\\u{ZZ}$"],
      ["an out-of-range code point escape", "^\\u{FFFFFF}$"],
      ["an identity escape that only the fallback accepts", "^\\d{3}\\-\\d{4}$"],
    ] as const;

    for (const [what, pattern] of unanalysable) {
      it(what, () => {
        expect(stringLengthRange(pattern)).toBeUndefined();
      });
    }

    it("declines every pattern the fallback would reinterpret", () => {
      // The general statement behind the four cases above: whenever the
      // `u` compile throws, the runtime uses different source-length
      // semantics than this parser reads, so there is nothing safe to
      // say.
      for (const pattern of ["^\\01$", "^\\u{ZZ}$", "^\\-$", "^[a-z]\\p$"]) {
        expect(() => new RegExp(pattern, "u"), pattern).toThrow();
        expect(new RegExp(pattern), pattern).toBeInstanceOf(RegExp); // fallback accepts it
        expect(stringLengthRange(pattern), pattern).toBeUndefined();
      }
    });
  });

  it("never reports a span narrower than a string the pattern actually matches", () => {
    // The property the rule depends on, checked against the regex
    // engine rather than against the parser's own reasoning.
    const cases: Array<[string, string[]]> = [
      ["^[a-z]{2,4}$", ["ab", "abc", "abcd"]],
      ["^(a|bbb)$", ["a", "bbb"]],
      ["^a*$", ["", "aaaaa"]],
      ["^\\d{3}-\\d{4}$", ["555-1234"]],
      ["^(?=.*[0-9])[a-z0-9]{4}$", ["ab1c"]],
      ["abc", ["abc", "xxabcxx"]],
      ["^\\w+@\\w+\\.[a-z]{2,3}$", ["a@b.io", "user@example.com"]],
    ];

    for (const [pattern, samples] of cases) {
      const span = stringLengthRange(pattern);
      expect(span, pattern).toBeDefined();
      for (const s of samples) {
        expect(new RegExp(pattern, "u").test(s), `${pattern} vs ${s}`).toBe(true);
        // The same helper `minLength` compiles to, so the assertion
        // measures with the ruler the validator uses.
        const length = countCodePoints(s);
        expect(length, `${pattern} vs ${s}`).toBeGreaterThanOrEqual((span as { min: number }).min);
        expect(length, `${pattern} vs ${s}`).toBeLessThanOrEqual((span as { max: number }).max);
      }
    }
  });
});

describe("differential fuzz against the regex engine", () => {
  // The invariant the rule rests on, checked against the engine rather
  // than against the parser's own reasoning: every string the pattern
  // actually accepts must fall inside the reported span. A string
  // outside it is exactly the shape of a false positive.
  const ALPHABET = ["a", "b", "1"];

  const strings = ((maxLen: number): string[] => {
    let all = [""];
    let level = [""];
    for (let n = 0; n < maxLen; n += 1) {
      const next: string[] = [];
      for (const s of level) for (const c of ALPHABET) next.push(s + c);
      all = all.concat(next);
      level = next;
    }
    return all;
  })(5);

  /** Seeded so a failure is reproducible; this is a guard, not a lottery. */
  function seededRandom(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d_2b_79_f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  function randomPattern(rand: () => number, depth = 0): string {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    // Includes constructs only the no-flag fallback accepts (`\01`,
    // `\-`, `\u{ZZ}`), so the generator reaches the case that produced
    // the false positive this guard exists for.
    const atoms = [
      "a",
      "b",
      "1",
      ".",
      "[ab]",
      "[^a]",
      "\\d",
      "\\w",
      "(?=a)",
      "\\b",
      "\\01",
      "\\-",
      "\\u{ZZ}",
      "\\u0061",
    ];
    const quants = ["", "", "", "*", "+", "?", "{2}", "{1,3}", "{0,2}"];

    const parts: string[] = [];
    const terms = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < terms; i += 1) {
      const atom = depth < 2 && rand() < 0.3 ? `(${randomPattern(rand, depth + 1)})` : pick(atoms);
      parts.push(atom + pick(quants));
    }
    let body = parts.join("");
    if (depth === 0) {
      if (rand() < 0.6) body = `^${body}`;
      if (rand() < 0.6) body = `${body}$`;
      if (rand() < 0.25) body = `${body}|${randomPattern(rand, 1)}`;
    } else if (rand() < 0.3) {
      body = `${body}|${pick(atoms)}`;
    }
    return body;
  }

  it("never reports a span that excludes a string the engine accepts", () => {
    const rand = seededRandom(20_260_729);
    const violations: string[] = [];
    let analysed = 0;

    for (let i = 0; i < 3000; i += 1) {
      const pattern = randomPattern(rand);
      const span = stringLengthRange(pattern);
      if (span === undefined) continue;

      // Mirrors `compileRegex` in runtime.ts: `u` first, no-flag
      // fallback second, so the fuzz tests the semantics the validator
      // will actually run.
      let re: RegExp;
      try {
        re = new RegExp(pattern, "u");
      } catch {
        try {
          re = new RegExp(pattern);
        } catch {
          continue; // not a legal regex either way
        }
      }
      analysed += 1;

      for (const s of strings) {
        if (!re.test(s)) continue;
        const length = countCodePoints(s);
        if (length < span.min || length > span.max) {
          violations.push(
            `${pattern} accepts ${JSON.stringify(s)} (length ${length}), span ${span.min}..${span.max}`,
          );
        }
      }
    }

    expect(violations.slice(0, 5)).toEqual([]);
    // Guards the guard: a generator that stopped producing analysable
    // patterns would pass silently.
    expect(analysed).toBeGreaterThan(500);
  });
});

describe("unsatisfiable/pattern-length", () => {
  const lint = (schema: SchemaOrBoolean, mode?: "off" | "warn" | "strict") =>
    compileSchema(schema, { dialect: jsonSchemaDialect, schemaLint: mode }).stats.schemaLintIssues;

  it("reports a pattern that cannot reach minLength", () => {
    // `(9)` is a group matching the literal "9"; `{9}` was meant.
    const issues = lint({
      type: "object",
      properties: {
        cusip: {
          type: "string",
          minLength: 9,
          maxLength: 9,
          pattern: "(^[a-zA-Z0-9](9)$)",
        },
      },
    } as SchemaOrBoolean);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "unsatisfiable/pattern-length",
      keyword: "pattern",
      path: "properties.cusip",
    });
    expect(issues[0]?.message).toContain('"minLength": 9');
    expect(issues[0]?.message).toContain("length 2");
  });

  it("reports a pattern that cannot fit under maxLength", () => {
    const issues = lint({
      type: "string",
      maxLength: 4,
      pattern: "^[a-z]{8}$",
    } as SchemaOrBoolean);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "unsatisfiable/pattern-length", path: "" });
    expect(issues[0]?.message).toContain("<root>");
    expect(issues[0]?.message).toContain('"maxLength": 4');
  });

  it("runs in the default warn mode, like the other always-on rules", () => {
    const schema = { type: "string", minLength: 9, pattern: "^ab$" } as SchemaOrBoolean;
    expect(
      compileSchema(schema, { dialect: jsonSchemaDialect }).stats.schemaLintIssues,
    ).toHaveLength(1);
    expect(lint(schema, "off")).toEqual([]);
  });

  describe("stays silent", () => {
    const quiet: Array<[string, unknown]> = [
      ["the bounds are satisfiable", { type: "string", minLength: 2, pattern: "^[a-z]{2,8}$" }],
      [
        "the pattern is unanchored, so the string can grow",
        { type: "string", maxLength: 4, pattern: "[a-z]{2}" },
      ],
      ["the pattern is unanalysable", { type: "string", minLength: 9, pattern: "^\\p{L}{2}$" }],
      ["there are no length bounds", { type: "string", pattern: "^ab$" }],
      ["type is absent", { minLength: 9, pattern: "^ab$" }],
      ["type admits a non-string", { type: ["string", "number"], minLength: 9, pattern: "^ab$" }],
    ];

    for (const [what, schema] of quiet) {
      it(what, () => {
        const issues = lint(schema as SchemaOrBoolean).filter(
          (i) => i.code === "unsatisfiable/pattern-length",
        );
        expect(issues).toEqual([]);
      });
    }
  });

  it("never sees a wrong-typed pattern or bound: the keyword guards reject those first", () => {
    // The rule's own typeof guards are for direct callers; through
    // `compileSchema` these never reach lint, and the earlier pass is
    // right to own them.
    for (const schema of [
      { type: "string", minLength: "9", pattern: "^ab$" },
      { type: "string", minLength: 9, pattern: 9 },
    ]) {
      expect(() =>
        compileSchema(schema as unknown as SchemaOrBoolean, { dialect: jsonSchemaDialect }),
      ).toThrow();
    }
  });

  it("is advisory: the validator still compiles and still rejects", () => {
    const compiled = compileSchema(
      {
        type: "string",
        minLength: 9,
        pattern: "^ab$",
      } as SchemaOrBoolean,
      { dialect: jsonSchemaDialect },
    );

    expect(compiled.stats.schemaLintIssues).toHaveLength(1);
    expect(compiled.validate("ab").valid).toBe(false);
    expect(compiled.validate("abcdefghi").valid).toBe(false);
  });
});

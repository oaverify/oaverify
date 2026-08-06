/**
 * Reporting a spec `pattern` that can backtrack catastrophically.
 *
 * A `pattern` is compiled with `new RegExp(p, "u")` and run against
 * request payloads, so an ambiguous one lets a crafted value hang the
 * validator. `^(a+)+$` is the textbook case; `^(a+){2,3}$` is the one
 * that catches people out, because the outer quantifier looks bounded
 * and the blowup is merely polynomial rather than exponential (measured:
 * 23ms at 200 characters, 1.1s at 1200, no return at 2000).
 *
 * ## Why this lives here and not in `@oaverify/core`
 *
 * The analysis comes from `redos-detector`, and that dependency belongs
 * in this package rather than in the validator. `@oaverify/core`
 * carries no runtime dependencies, the whole HTTP validator is around
 * 31 KB gzipped, and `redos-detector` plus `regjsparser` is roughly
 * 1 MB unpacked. Paying that on every `createValidator` import, to
 * report something a running server cannot act on, is the wrong trade:
 * a server cannot rewrite its author's pattern, and its remedy is the
 * `regexCompiler` option, which is already documented.
 *
 * A `check` run is where a spec author reads output, so this is where
 * the cost belongs, alongside the other passes that exist to grade a
 * document rather than to serve traffic. It is also the single largest
 * reason `@oaverify/check` is a package rather than a
 * `@oaverify/core/check` subpath: npm installs a dependency whichever
 * entry imports it, so a subpath would have moved this 1 MB onto every
 * `@oaverify/core` consumer regardless.
 *
 * ## Why not hand-rolled
 *
 * It was, briefly. Measured against a corpus of dangerous and safe
 * patterns, the hand-written analysis missed the bounded-outer
 * polynomial case above while asserting in its own tests that the case
 * was safe. `safe-regex`, the other obvious candidate, uses star height
 * and flags `^[a-z0-9]+(-[a-z0-9]+)*$` (a slug, common in real specs)
 * along with a fully bounded `^(a{2}){3}$`: six false positives on
 * sixteen safe patterns. `redos-detector` reported every dangerous
 * pattern and no safe one.
 *
 * @packageDocumentation
 */

import type { OpenAPIDocument } from "@oaverify/internal-core";
import { escapePointer, walkDocumentSchemas } from "@oaverify/internal-validator/internals";
// `isSafe` is exposed as a named export; the package is CJS, and some of
// its other exports are not reachable that way from ESM.
import { isSafe } from "redos-detector";

/** One pattern with a proven ambiguity. */
export interface RedosIssue {
  code: "ambiguous-pattern";
  /** RFC 6901 pointer to the `pattern` keyword. */
  pointer: string;
  message: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Long patterns are quoted only up to this, to keep findings readable. */
const PATTERN_ECHO_LIMIT = 60;

/**
 * Is this pattern provably vulnerable?
 *
 * `redos-detector` reports `safe: false` for two different reasons, and
 * only one of them is a finding:
 *
 * - `hitMaxScore`: the analysis completed and the backtracking score
 *   exceeded its budget. A real result.
 * - `hitMaxSteps`: the analysis ran out of steps and does not know. On a
 *   safe pattern with a low step budget it returns exactly this,
 *   `safe: false` included, so treating it as a finding would report
 *   patterns that are fine.
 *
 * A pattern the runtime would compile under the no-flag fallback rather
 * than `u` is skipped for the same reason the other pattern rules skip
 * it: the two readings disagree about what some constructs mean.
 */
export function ambiguityWitness(pattern: string): string | undefined {
  let regexp: RegExp;
  try {
    regexp = new RegExp(pattern, "u");
  } catch {
    return undefined;
  }

  let result: ReturnType<typeof isSafe>;
  try {
    result = isSafe(regexp);
  } catch {
    // Syntax the analyser does not model. Declining is the only safe
    // answer; a guess here sends an author rewriting a working pattern.
    return undefined;
  }
  if (result.safe || result.error !== "hitMaxScore") return undefined;

  // Each trail is a pair of paths that consume the same input by
  // different routes. Concatenating one side gives the shape of the
  // input that is matched more than one way, in pattern-source terms
  // (a class appears as `[a-z]`, not as a chosen member), which is
  // enough for an author to see the ambiguity for themselves.
  const shapes = result.trails
    .map((t) => t.trail.map((step) => step.a.node.source).join(""))
    .filter((shape) => shape.length > 0)
    .sort((a, b) => b.length - a.length);
  return shapes[0] ?? "";
}

/**
 * Walk a resolved document and report every `pattern` that can be made
 * to backtrack catastrophically.
 *
 * Reported regardless of whether the caller has configured a
 * linear-time engine through `regexCompiler`: the finding is about the
 * document, which every other consumer of it also runs, not about one
 * caller's hardening.
 *
 * @param document - A resolved OpenAPI document.
 *
 * @public
 */
export function checkDocumentRedos(document: OpenAPIDocument): RedosIssue[] {
  const issues: RedosIssue[] = [];
  // Identity-keyed by the walk, so a schema shared by many operations is
  // analysed once. The analysis is the expensive part of this check.
  // `null` records "analysed, not ambiguous"; a string is the witness.
  const verdicts = new Map<string, string | null>();

  const report = (pattern: string, pointer: string, crafted: string): void => {
    let witness = verdicts.get(pattern);
    if (witness === undefined) {
      witness = ambiguityWitness(pattern) ?? null;
      verdicts.set(pattern, witness);
    }
    if (witness === null) return;

    const echoed =
      pattern.length <= PATTERN_ECHO_LIMIT ? pattern : `${pattern.slice(0, PATTERN_ECHO_LIMIT)}...`;
    const shape =
      witness === "" ? "" : ` An input of the form \`${witness}\` matches more than one way.`;
    issues.push({
      code: "ambiguous-pattern",
      pointer,
      message:
        `"${echoed}" is ambiguous.${shape} A backtracking engine can be made to ` +
        `explore every way of matching, so a crafted ${crafted} may cost superlinear ` +
        `time; whether it does depends on the engine running the pattern. Rewrite ` +
        `to remove the ambiguity, or compile patterns with a linear-time engine ` +
        `(the regexCompiler option).`,
    });
  };

  walkDocumentSchemas(document, {
    onSchemaNode: (schema, pointer) => {
      const pattern = schema["pattern"];
      if (typeof pattern === "string") report(pattern, `${pointer}/pattern`, "value");

      // `patternProperties` keys are regexes too, compiled through the
      // same `compilePattern` and run against every property name of
      // every object validated here. Checking only `pattern` left that
      // surface silent, which review caught: a crafted property name
      // reaches the engine exactly as a crafted value does.
      const patternProperties = schema["patternProperties"];
      if (!isPlainObject(patternProperties)) return;
      for (const key of Object.keys(patternProperties)) {
        report(key, `${pointer}/patternProperties/${escapePointer(key)}`, "property name");
      }
    },
  });

  return issues;
}

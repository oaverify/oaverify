/**
 * Who decides what a `check` finding means.
 *
 * oaverify grades every finding, and that grading is a judgement about
 * consequence which a consumer may reasonably disagree with. The
 * defaults below are what oaverify believes; a {@link SeverityMap} is
 * how a caller that believes otherwise says so, without post-processing
 * the findings.
 *
 * The grading is not cosmetic: it is what a gate reads. The CLI's
 * `--fail-on` compares against `severity`, so a remapping changes exit
 * codes, which is the point. A team that treats `unsatisfiable/*` as a
 * release blocker can gate on it.
 *
 * Publishing {@link DEFAULT_SEVERITY} makes oaverify's judgement part
 * of the contract, so changing an entry is a breaking change. That cost
 * is taken deliberately, because the alternative is worse: leaving the
 * table unexported means every consumer reimplements the composition
 * and the four gradings drift apart.
 *
 * @packageDocumentation
 */

import { CHECK_CODES, CHECK_FAMILIES } from "./codes.js";
import { CHECK_CLASSES, CHECK_SEVERITIES, type CheckClass, type CheckSeverity } from "./finding.js";

/**
 * What oaverify grades each class as, before any `--severity` mapping.
 *
 * Stated here rather than at each of the six places a finding is built,
 * so the answer to "what does oaverify think of this" is one table
 * rather than a code read. `hygiene` is the one class that differs by
 * code, through {@link HYGIENE_ERRORS}.
 *
 * `malformed` is absent on purpose: it is `fatal` and not remappable,
 * for the reason on {@link parseSeverityMap}.
 */
export const DEFAULT_SEVERITY: Readonly<Record<CheckClass, CheckSeverity>> = {
  // A specification violation, not a matter of taste.
  conformance: "error",
  // Legal documents whose behaviour will surprise the author. Flat
  // today, which is the gap `--severity` exists to let a consumer close
  // for themselves.
  schema: "warning",
  examples: "warning",
  redos: "warning",
  // Split by code: two hygiene codes are spec violations, the rest name
  // things that are legal and merely dead.
  hygiene: "warning",
  // Never consulted: a custom finding is graded by the rule that
  // produced it, or by the rule's own default, before it reaches here.
  // Present because the table is exhaustive over CheckClass, which is
  // what makes a new class impossible to forget.
  custom: "warning",
};

/**
 * Hygiene codes that are specification violations rather than
 * housekeeping. OpenAPI requires every path-template placeholder to have
 * a matching parameter declaration, so these are not a matter of taste;
 * the rest of the hygiene codes (unused components, tags, `$defs`) name
 * things that are legal and merely dead.
 */
export const HYGIENE_ERRORS = new Set(["path-param-undeclared", "path-param-unused"]);

/**
 * A regrading, keyed three ways.
 *
 * What {@link parseSeverityMap} produces, and what a caller can also
 * build by hand: the map is the semantics, the string grammar is one
 * serialization of it.
 *
 * Three key spaces, most specific first when a finding is graded. Kept
 * apart rather than merged into one map so precedence is a property of
 * the lookup rather than of insertion order.
 */
export interface SeverityMap {
  /** Keyed on the finding's `code`, exactly. */
  readonly byCode: ReadonlyMap<string, CheckSeverity>;
  /** Keyed on a `family/` prefix written as `family/*`, without the star. */
  readonly byFamily: ReadonlyMap<string, CheckSeverity>;
  /** Keyed on the finding's `class`. */
  readonly byClass: ReadonlyMap<string, CheckSeverity>;
}

export const EMPTY_SEVERITY_MAP: SeverityMap = {
  byCode: new Map(),
  byFamily: new Map(),
  byClass: new Map(),
};

/**
 * The severity a finding carries, after any mapping.
 *
 * Most specific wins: an exact code beats the family it sits in, which
 * beats its class. So a map promoting the `unsatisfiable` family to
 * `error` while demoting `unsatisfiable/pattern-length` to `warning`
 * does both, and which was written first does not matter.
 *
 * @public
 */
export function severityFor(
  map: SeverityMap,
  finding: { class: string; code: string },
  fallback: CheckSeverity,
): CheckSeverity {
  const exact = map.byCode.get(finding.code);
  if (exact !== undefined) return exact;
  const slash = finding.code.indexOf("/");
  if (slash !== -1) {
    const family = map.byFamily.get(finding.code.slice(0, slash));
    if (family !== undefined) return family;
  }
  return map.byClass.get(finding.class) ?? fallback;
}

/** What oaverify grades a finding as, before the caller's mapping. */
export function defaultSeverityFor(cls: CheckClass, code: string): CheckSeverity {
  if (cls === "hygiene") return HYGIENE_ERRORS.has(code) ? "error" : "warning";
  return DEFAULT_SEVERITY[cls];
}

/**
 * Thrown by {@link parseSeverityMap} for input it will not accept.
 *
 * The message names the offending text and is written to be shown to
 * whoever typed it; the CLI prints it as a usage error. A caller
 * parsing a config file can do the same.
 */
export class SeverityMapError extends Error {}

/**
 * Flatten `--severity` occurrences into one entry per `key=level`.
 *
 * Exported so a caller can validate a subset of the entries before the
 * rest are knowable. `check` parses every built-in key with it before a
 * `--rules` module is imported, which is what keeps "a typo in a CI flag
 * fails before any side effect" true now that some keys are defined by
 * a module the flags cause to execute.
 */
export function splitSeverityEntries(entries: readonly string[]): string[] {
  return entries
    .flatMap((e) => e.split(","))
    .map((e) => e.trim())
    .filter((e) => e !== "");
}

/** The key half of one entry, unvalidated. The whole entry when it has no `=`. */
export function severityKeyOf(entry: string): string {
  const eq = entry.indexOf("=");
  return eq === -1 ? entry.trim() : entry.slice(0, eq).trim();
}

const EMPTY_CODES: ReadonlySet<string> = new Set<string>();

/**
 * Options for {@link parseSeverityMap}.
 *
 * @remarks
 * The built-in key spaces are taken from this package rather than passed
 * in, so this widens what is accepted and never replaces it.
 *
 * @public
 */
export interface ParseSeverityMapOptions {
  /**
   * Codes to accept in addition to {@link CHECK_CODES}, for findings this
   * package does not itself emit. A code containing `/` also contributes
   * its prefix as an accepted family.
   *
   * `check --rules` supplies the codes its rule modules declare, which is
   * what lets `--severity x-acme//rule=error` validate against a code
   * space that only exists once a module has been imported.
   */
  readonly customCodes?: ReadonlySet<string>;
}

/**
 * A hint for a rejected code key, as a trailing clause. Dozens of codes
 * across six classes is too many to print, and a mistyped code is nearly
 * always the wrong member of a family the caller had right.
 */
function nearestCode(
  key: string,
  codes: ReadonlySet<string>,
  families: ReadonlySet<string>,
): string {
  const family = key.slice(0, key.indexOf("/"));
  const siblings = [...codes].filter((code) => code.startsWith(`${family}/`)).sort();
  if (siblings.length > 0) return `; "${family}/" holds ${siblings.join(", ")}`;
  return `; known families are ${[...families].sort().join(", ")}`;
}

/**
 * Parse the string grammar into a {@link SeverityMap}.
 *
 * The grammar is one comma-separated list of `key=level`. It exists
 * because a regrading usually has one or two entries and typing them
 * beats authoring a file; the CLI exposes it as `--severity`, and a
 * caller reading a config value in the same shape can reuse it rather
 * than reimplementing the key spaces.
 *
 * ```
 * parseSeverityMap(["unsatisfiable/*=error,redos=error"])
 * ```
 *
 * A key is an exact code (`unsatisfiable/pattern-length`), a family
 * (`unsatisfiable/*`), or a class (`redos`). A level is one of
 * `warning`, `error`, `fatal`.
 *
 * All three key spaces are checked against what `check` can emit
 * ({@link CHECK_CODES}, {@link CHECK_FAMILIES}, {@link CHECK_CLASSES}).
 * A key matching nothing is refused, not stored.
 *
 * The key spaces are taken from this package rather than passed in.
 * Injecting them would let a caller accept a class `checkSpec` will
 * never emit, or refuse one it does, which is the drift moving the
 * parser here was meant to end. If a future class needs declaring (#634
 * proposes `custom`), that arrives as an optional options argument and
 * widens this additively.
 *
 * `customCodes` widens the code space with the codes a `--rules` module
 * declared, so the space stays *closed* rather than becoming open: it
 * closes later, once the rule set is known, and a typo in an
 * `x-acme/...` key is still refused. The caller is responsible for
 * parsing the built-in keys before it loads any module, which is what
 * keeps that refusal ahead of the side effect; see
 * {@link splitSeverityEntries}.
 *
 * **`malformed` cannot be mapped, and saying so is the point.** Its
 * findings are `fatal` and its exit code is 4, which outranks
 * a gate threshold, because a document that cannot be compiled is not
 * a gate result. A mapping that changed the printed severity while leaving the
 * exit code alone would look like it worked and would not, so
 * `malformed` and `malformed-schema` are refused rather than
 * half-applied.
 *
 * Every other input error is refused too, rather than skipped: a typo
 * in a CI flag that silently grades nothing is the failure this option
 * exists to prevent.
 *
 * @throws SeverityMapError with the offending text.
 *
 * @public
 */
export function parseSeverityMap(
  entries: readonly string[],
  options: ParseSeverityMapOptions = {},
): SeverityMap {
  const knownClasses: readonly string[] = CHECK_CLASSES;
  const severities: readonly CheckSeverity[] = CHECK_SEVERITIES;
  const customCodes = options.customCodes ?? EMPTY_CODES;
  const byCode = new Map<string, CheckSeverity>();
  const byFamily = new Map<string, CheckSeverity>();
  const byClass = new Map<string, CheckSeverity>();

  const codes = customCodes.size === 0 ? CHECK_CODES : new Set([...CHECK_CODES, ...customCodes]);
  const families =
    customCodes.size === 0
      ? CHECK_FAMILIES
      : new Set([
          ...CHECK_FAMILIES,
          ...[...customCodes].flatMap((code) => {
            const slash = code.indexOf("/");
            return slash === -1 ? [] : [code.slice(0, slash)];
          }),
        ]);

  for (const text of splitSeverityEntries(entries)) {
    const eq = text.indexOf("=");
    if (eq === -1) {
      throw new SeverityMapError(`"${text}" is not <key>=<level>`);
    }
    const key = text.slice(0, eq).trim();
    const level = text.slice(eq + 1).trim();

    if (!severities.includes(level as CheckSeverity)) {
      throw new SeverityMapError(
        `"${text}": ${level === "" ? "no level" : `"${level}"`} is not a severity; expected ${severities.join(", ")}`,
      );
    }
    const severity = level as CheckSeverity;

    if (key === "malformed" || key === "malformed-schema") {
      throw new SeverityMapError(
        `"${text}": malformed findings are always fatal and always exit 4, so they cannot be remapped`,
      );
    }
    if (key === "") {
      throw new SeverityMapError(`"${text}": no key`);
    }

    if (key.endsWith("/*")) {
      const family = key.slice(0, -2);
      if (!families.has(family)) {
        throw new SeverityMapError(
          `"${text}": "${family}" is not a code family (${[...families].sort().join(", ")})`,
        );
      }
      byFamily.set(family, severity);
    } else if (key.includes("*")) {
      throw new SeverityMapError(`"${text}": "*" is only allowed as a trailing "/*"`);
    } else if (knownClasses.includes(key)) {
      // A class wins over a code of the same spelling; none collide today.
      byClass.set(key, severity);
    } else if (codes.has(key)) {
      byCode.set(key, severity);
    } else if (key.includes("/")) {
      throw new SeverityMapError(
        `"${text}": "${key}" is not a code oaverify emits${nearestCode(key, codes, families)}`,
      );
    } else {
      throw new SeverityMapError(
        `"${text}": "${key}" is not a class (${knownClasses.join(", ")}) or a code oaverify emits`,
      );
    }
  }

  return { byCode, byFamily, byClass };
}

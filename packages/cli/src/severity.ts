/**
 * Who decides what a `check` finding means.
 *
 * oaverify grades every finding, and that grading is a judgement about
 * consequence which a consumer may reasonably disagree with. The
 * defaults below are what oaverify believes; `--severity` is how a team
 * that believes otherwise says so, without post-processing JSON.
 *
 * The grading is not cosmetic. `--fail-on` reads `severity`, so a
 * remapping changes exit codes, which is the point: a team that treats
 * `unsatisfiable/*` as a release blocker can gate on it.
 *
 * @packageDocumentation
 */

import { CHECK_CODES, CHECK_FAMILIES } from "./codes.js";
import type { CheckClass, CheckSeverity } from "./commands.js";

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
 * A parsed `--severity` mapping.
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
 * beats its class. So `--severity 'unsatisfiable/*=error,unsatisfiable/pattern-length=warning'`
 * promotes the family and demotes the one member, and the order the two
 * were written in does not matter.
 *
 * @internal
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

/** Thrown for a malformed `--severity`; the CLI renders it as a usage error. */
export class SeverityMapError extends Error {}

/**
 * A hint for a rejected code key, as a trailing clause. Dozens of codes
 * across six classes is too many to print, and a mistyped code is nearly
 * always the wrong member of a family the caller had right.
 */
function nearestCode(key: string): string {
  const family = key.slice(0, key.indexOf("/"));
  const siblings = [...CHECK_CODES].filter((code) => code.startsWith(`${family}/`)).sort();
  if (siblings.length > 0) return `; "${family}/" holds ${siblings.join(", ")}`;
  return `; known families are ${[...CHECK_FAMILIES].sort().join(", ")}`;
}

/**
 * Parse `--severity` into a {@link SeverityMap}.
 *
 * The grammar is one comma-separated list of `key=level`, matching
 * `--only`'s shape rather than introducing a file for what is usually
 * one or two entries:
 *
 * ```
 * --severity 'unsatisfiable/*=error,redos=error'
 * ```
 *
 * A key is an exact code (`unsatisfiable/pattern-length`), a family
 * (`unsatisfiable/*`), or a class (`redos`). A level is one of
 * `warning`, `error`, `fatal`.
 *
 * All three key spaces are checked against what `check` can emit
 * ({@link CHECK_CODES}, {@link CHECK_FAMILIES}, and the caller's class
 * list). A key matching nothing is refused, not stored.
 *
 * **`malformed` cannot be mapped, and saying so is the point.** Its
 * findings are `fatal` and its exit code is 4, which outranks
 * `--fail-on` because a document that cannot be compiled is not a gate
 * result. A mapping that changed the printed severity while leaving the
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
 * @internal
 */
export function parseSeverityMap(
  entries: readonly string[],
  knownClasses: readonly string[],
  severities: readonly CheckSeverity[],
): SeverityMap {
  const byCode = new Map<string, CheckSeverity>();
  const byFamily = new Map<string, CheckSeverity>();
  const byClass = new Map<string, CheckSeverity>();

  for (const entry of entries.flatMap((e) => e.split(","))) {
    const text = entry.trim();
    if (text === "") continue;

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
      if (!CHECK_FAMILIES.has(family)) {
        throw new SeverityMapError(
          `"${text}": "${family}" is not a code family (${[...CHECK_FAMILIES].sort().join(", ")})`,
        );
      }
      byFamily.set(family, severity);
    } else if (key.includes("*")) {
      throw new SeverityMapError(`"${text}": "*" is only allowed as a trailing "/*"`);
    } else if (knownClasses.includes(key)) {
      // A class wins over a code of the same spelling; none collide today.
      byClass.set(key, severity);
    } else if (CHECK_CODES.has(key)) {
      byCode.set(key, severity);
    } else if (key.includes("/")) {
      throw new SeverityMapError(
        `"${text}": "${key}" is not a code oaverify emits${nearestCode(key)}`,
      );
    } else {
      throw new SeverityMapError(
        `"${text}": "${key}" is not a class (${knownClasses.join(", ")}) or a code oaverify emits`,
      );
    }
  }

  return { byCode, byFamily, byClass };
}

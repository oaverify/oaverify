/**
 * House rules: a user-supplied document check that runs inside `check`
 * and is graded, addressed and reported like a built-in one.
 *
 * **What this is for.** A team's house rules are plain JS over the
 * document `resolveSpec` returns, and they always were: `resolveSpec`,
 * `resolveJsonPointer`, `sourceOf` and `walkSubschemas` are public. What
 * a consumer could not do is get their finding into the same array as
 * oaverify's, graded by the same severity model, selected by `--only`,
 * gated by `--fail-on`, and rendered into the same SARIF upload. That
 * composition is the whole of what this module adds. Expressiveness is
 * not part of it, which is why there is no rule DSL here and no
 * targeting language: a rule is a function.
 *
 * **The trust boundary.** Loading a rule module executes local code.
 * That is coherent with refusing a remote `$ref` because the two are
 * different acts: `--rules ./house.mjs` is named by the invoker in their
 * own shell, and a `$ref` URL is named by a document that arrived from
 * somewhere. So the rule path is only ever read from argv. There is no
 * config file, no discovery, no walk-up, and no document extension that
 * can introduce one. Discovery is the hazard, since it turns "I cloned a
 * repo and ran a linter" into arbitrary code execution, and an explicit
 * flag has never had that property.
 *
 * **Addressing.** A rule returns a message and, when it has one, an
 * RFC 6901 pointer into the resolved document. Everything else on the
 * finding is derived: `class`, `severity`, `location`, `target.anchor`,
 * and the source address. The four-referent contract in
 * docs/strictness.md is therefore not something a rule author has to
 * honour, because the only referent they can supply is the one they are
 * in a position to know. A pointer that does not resolve is refused
 * rather than reported, since a target resolving nowhere is the failure
 * that field exists to prevent.
 *
 * @packageDocumentation
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveJsonPointer, type OpenAPIDocument } from "@oaverify/internal-core";
import type { CheckSeverity } from "@oaverify/check";

/**
 * What a rule knows about the run it is part of.
 *
 * Deliberately small. Everything here is something a rule could not
 * compute for itself from the document alone, which is the test for
 * admitting a field: `document` is the resolved document a rule would
 * otherwise have to resolve again, and `knownFormats` is a fact about
 * the compiler that will validate this team's traffic.
 *
 * A rule reaching for compiler knowledge repeatedly is evidence the
 * check wants to be a built-in rather than a house rule; #645 is that
 * story having already happened once.
 *
 * @public
 */
export interface RuleContext {
  /**
   * The resolved document, after overlays. The same object the built-in
   * passes walk, so a pointer computed here addresses what a pointer on
   * any other finding addresses.
   */
  readonly document: OpenAPIDocument;
  /**
   * Format names this run's compiler validates. A `format` outside this
   * set is checked against `type` alone.
   *
   * The one piece of compiler knowledge exposed today, and the reason a
   * house rule belongs in oaverify rather than in a generic linter: no
   * tool that is not the validator can answer it.
   */
  readonly knownFormats: ReadonlySet<string>;
}

/**
 * One thing a rule found.
 *
 * `message` and an optional `pointer` are the whole contract. There is
 * no `location`, no `class`, and no `anchor`, because a rule is not in
 * a position to compute them correctly and a field it can fill wrongly
 * is a field that makes the addressing contract "usually accurate".
 *
 * @public
 */
export interface RuleFinding {
  /**
   * RFC 6901 pointer into the resolved document, or absent when the
   * finding has no position: a rule about the document as a whole, or a
   * count that no single node is responsible for.
   *
   * Absent means the same thing it means on every other finding, and is
   * a fact rather than an omission. Present and unresolvable is a defect
   * in the rule and is refused.
   */
  readonly pointer?: string;
  /** What is wrong, in prose, for a human. */
  readonly message: string;
  /**
   * Grade this one finding, overriding the rule's own `severity`. For a
   * rule whose seriousness depends on what it found.
   *
   * The caller's `--severity` still wins over this, so a team can
   * regrade a rule they did not write without editing it.
   */
  readonly severity?: CheckSeverity;
}

/**
 * A document rule.
 *
 * @public
 */
export interface DocumentRule {
  /**
   * This rule's code, in the reserved `x-<namespace>/<name>` shape, e.g.
   * `x-acme/operation-needs-owner`.
   *
   * The `x-` prefix keeps the built-in code space closed: a user code
   * can never collide with one oaverify emits, and `--severity` can
   * still reject a typo in either space. The `<namespace>/` half is what
   * makes `--severity 'x-acme/*=error'` work through the existing family
   * grammar with no change to it.
   */
  readonly code: string;
  /** Grade for every finding this rule produces. Defaults to `"warning"`. */
  readonly severity?: CheckSeverity;
  /**
   * Run the rule. Sync or async, and may return any iterable, so a
   * generator is as usable as an array.
   */
  run(ctx: RuleContext): Iterable<RuleFinding> | Promise<Iterable<RuleFinding>>;
}

/**
 * A rule module could not be loaded, or what it exported is not a rule
 * set. The CLI renders it as a usage error: the module is the invoker's
 * own code, so the remedy is in their hands and not in the document.
 *
 * @public
 */
export class RuleLoadError extends Error {}

/**
 * A rule ran and returned something the contract does not allow. Also a
 * usage error, and for the same reason.
 *
 * @public
 */
export class RuleContractError extends Error {}

/**
 * The shape a rule code must have.
 *
 * Lowercase kebab, two halves, `x-` on the first. Restrictive on
 * purpose: a code appears in `--severity` keys, in SARIF `ruleId`s and
 * in fingerprints, so a code with a space or a `*` or an `=` in it
 * breaks one of those in a way that is hard to trace back here.
 */
const CODE_PATTERN = /^x-[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True for a `--severity` key that only a loaded rule set could define. */
export function isCustomSeverityKey(key: string): boolean {
  return key.startsWith("x-");
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  const kind = typeof value;
  return `${kind === "object" ? "an" : "a"} ${kind}`;
}

/**
 * The reason a rule module failed, for any thrown value.
 *
 * `throw "boom"` is legal JS and a rule author will eventually write it.
 * Reading `.message` off it yields `undefined`, which turns the error
 * whose whole job is to name the defect into one that hides it.
 */
function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    // A thrown object with a throwing `toString`. Rare, and cheaper to
    // answer than to let it mask the original failure.
    return describe(err);
  }
}

/**
 * Import one rule module and validate what it exported.
 *
 * Accepts `export const rules = [...]` or a default export of the same
 * array. Two spellings rather than one because a module written for this
 * is naturally a default export and a module that also exports helpers
 * is naturally named; refusing either would be a gotcha with no benefit.
 */
async function loadOne(specifier: string, cwd: string): Promise<DocumentRule[]> {
  const path = isAbsolute(specifier) ? specifier : resolvePath(cwd, specifier);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (err) {
    throw new RuleLoadError(`cannot load rule module ${specifier}: ${reasonOf(err)}`);
  }

  // `hasOwn` rather than `??`, so `export const rules = undefined` is
  // diagnosed as a broken named export instead of silently falling
  // through to the default one. Named wins when both are present.
  const named = Object.hasOwn(mod, "rules");
  const exported = named ? mod["rules"] : mod["default"];
  if (exported === undefined || exported === null) {
    throw new RuleLoadError(
      named
        ? `rule module ${specifier} exports "rules" as ${describe(exported)}`
        : `rule module ${specifier} exports neither "rules" nor a default export`,
    );
  }
  if (!Array.isArray(exported)) {
    throw new RuleLoadError(
      `rule module ${specifier} exports ${describe(exported)}, expected an array of rules`,
    );
  }

  return exported.map((rule, i) => {
    const at = `rule ${i} of ${specifier}`;
    if (rule === null || typeof rule !== "object") {
      throw new RuleLoadError(`${at} is ${describe(rule)}, expected an object`);
    }
    const { code, severity, run } = rule as Partial<DocumentRule>;
    if (typeof code !== "string") {
      throw new RuleLoadError(`${at} has no "code" string`);
    }
    if (!CODE_PATTERN.test(code)) {
      throw new RuleLoadError(
        `${at} has code "${code}", which is not "x-<namespace>/<name>" in lowercase kebab-case; ` +
          `the "x-" prefix is reserved for rule codes so they cannot collide with oaverify's`,
      );
    }
    if (typeof run !== "function") {
      throw new RuleLoadError(`rule ${code} (${specifier}) has no "run" function`);
    }
    if (severity !== undefined && !["warning", "error", "fatal"].includes(severity)) {
      throw new RuleLoadError(
        `rule ${code} (${specifier}) has severity "${String(severity)}"; expected warning, error, fatal`,
      );
    }
    return { code, run, ...(severity === undefined ? {} : { severity }) };
  });
}

/**
 * Load every rule module named on the command line, in order.
 *
 * Codes are unique across the whole set: two modules claiming one code
 * would make `--severity` ambiguous and would merge two rules' findings
 * under one SARIF rule descriptor, so it is refused rather than
 * last-one-wins.
 *
 * @param specifiers - Paths as typed, resolved against `cwd`.
 * @param cwd - Directory relative paths resolve against.
 *
 * @throws RuleLoadError naming the module and what is wrong with it.
 *
 * @public
 */
export async function loadRules(
  specifiers: readonly string[],
  cwd: string,
): Promise<readonly DocumentRule[]> {
  const rules: DocumentRule[] = [];
  const seen = new Map<string, string>();
  for (const specifier of specifiers) {
    for (const rule of await loadOne(specifier, cwd)) {
      const already = seen.get(rule.code);
      if (already !== undefined) {
        throw new RuleLoadError(
          `rule code ${rule.code} is declared by both ${already} and ${specifier}`,
        );
      }
      seen.set(rule.code, specifier);
      rules.push(rule);
    }
  }
  return rules;
}

/** A rule finding, normalised and ready to become a `CheckFinding`. */
export interface NormalisedRuleFinding {
  readonly code: string;
  readonly severity: CheckSeverity;
  readonly message: string;
  /** Absent when the rule reported no position. */
  readonly pointer?: string;
}

/**
 * Display text for a finding with no position.
 *
 * A fixed token rather than rule-supplied prose, so `location` cannot
 * become a second addressing channel that a consumer is tempted to
 * parse. It reads as "the document, as a whole", which is what a
 * pointerless finding is about.
 */
export const DOCUMENT_LOCATION = "<document>";

/**
 * Run every rule against the document and normalise what they return.
 *
 * Rules run in the order they were loaded, sequentially rather than
 * concurrently: a rule may read a file or call a service, and a
 * deterministic report is worth more here than overlapping IO on a
 * handful of rules.
 *
 * A pointer a rule supplies is resolved against the document before it
 * is accepted. An unresolvable one is a defect in the invoker's own
 * module, so it stops the run with an error naming the rule rather than
 * being graded as a finding: reporting it would put a target in the
 * report that resolves nowhere, which is exactly what `target`'s
 * contract promises never happens.
 *
 * @throws RuleContractError naming the rule and what it returned.
 *
 * @public
 */
export async function runRules(
  rules: readonly DocumentRule[],
  ctx: RuleContext,
): Promise<readonly NormalisedRuleFinding[]> {
  const out: NormalisedRuleFinding[] = [];
  for (const rule of rules) {
    let produced: Iterable<RuleFinding>;
    try {
      produced = await rule.run(ctx);
    } catch (err) {
      throw new RuleContractError(`rule ${rule.code} threw: ${reasonOf(err)}`);
    }
    if (
      produced === null ||
      produced === undefined ||
      typeof (produced as Iterable<RuleFinding>)[Symbol.iterator] !== "function"
    ) {
      throw new RuleContractError(
        `rule ${rule.code} returned ${describe(produced)}, expected an iterable of findings`,
      );
    }
    for (const finding of produced) {
      if (finding === null || typeof finding !== "object") {
        throw new RuleContractError(
          `rule ${rule.code} produced ${describe(finding)}, expected a finding object`,
        );
      }
      const { pointer, message, severity } = finding;
      if (typeof message !== "string" || message === "") {
        throw new RuleContractError(
          `rule ${rule.code} produced a finding with no "message" string`,
        );
      }
      if (severity !== undefined && !["warning", "error", "fatal"].includes(severity)) {
        throw new RuleContractError(
          `rule ${rule.code} produced a finding with severity "${String(severity)}"; expected warning, error, fatal`,
        );
      }
      if (pointer !== undefined) {
        if (typeof pointer !== "string") {
          throw new RuleContractError(
            `rule ${rule.code} produced a finding whose "pointer" is ${describe(pointer)}, expected a string`,
          );
        }
        try {
          resolveJsonPointer(ctx.document, pointer);
        } catch (err) {
          throw new RuleContractError(
            `rule ${rule.code} produced a finding at "${pointer}", which does not resolve in the ` +
              `document (${reasonOf(err)}). A finding with no position should omit ` +
              `"pointer" rather than guess one.`,
          );
        }
      }
      out.push({
        code: rule.code,
        severity: severity ?? rule.severity ?? "warning",
        message,
        ...(pointer === undefined ? {} : { pointer }),
      });
    }
  }
  return out;
}

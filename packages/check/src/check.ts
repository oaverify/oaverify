/**
 * The composed check: every pass, one graded finding list.
 *
 * This is what `oaverify check` runs. The CLI loads a spec, calls
 * {@link checkSpec}, and renders the result; everything between those
 * two ends lives here.
 *
 * @packageDocumentation
 */

import type { OpenAPIDocument } from "@oaverify/internal-core";
import {
  lintResolvedSpec,
  sourceOf,
  type ResolvedSpec,
  type SpecRegion,
} from "@oaverify/internal-spec";
import type { SchemaLintIssue } from "@oaverify/internal-schema";
import { checkDocumentExamples, createValidator } from "@oaverify/internal-validator";
import { checkDocumentConformance } from "@oaverify/internal-metaschema/conformance";
import { checkDocumentFormats, KNOWN_FORMATS } from "./format-check.js";
import { checkDocumentRedos } from "./redos-check.js";
import {
  CHECK_CLASSES,
  type CheckClass,
  type CheckFinding,
  type FindingTarget,
} from "./finding.js";
import {
  defaultSeverityFor,
  EMPTY_SEVERITY_MAP,
  severityFor,
  type SeverityMap,
} from "./severity.js";

/**
 * What a run may vary.
 *
 * Deliberately small. `check` fixes the compile at `schemaLint:
 * "strict"` and the format map at `builtInFormats`, and exposing either
 * is additive later; every option not shipped is one that cannot be got
 * wrong. See {@link CheckFinding} for what comes back.
 *
 * @public
 */
export interface CheckOptions {
  /**
   * Which classes to run. Defaults to all of {@link CHECK_CLASSES}.
   *
   * Selecting a subset is the only way to opt out of a pass's cost. The
   * `examples` class compiles schemas of its own accord and `redos`
   * reaches for a third-party analyser, so both are worth dropping on a
   * very large document that does not need them.
   */
  only?: readonly CheckClass[];
  /**
   * A regrading, applied over every class after the defaults.
   *
   * Takes the parsed map rather than the CLI's `--severity` strings, so
   * a caller building one by hand never goes through a string. Use
   * {@link parseSeverityMap} if you are reading the string form out of
   * a config file.
   *
   * `malformed` findings are never remapped; see
   * {@link parseSeverityMap} for why.
   */
  severity?: SeverityMap;
}

/**
 * Thrown when the document cannot be graded at all.
 *
 * Distinct from a malformed schema, which is a *finding*: the document
 * is still graded and the report is complete. This is the case where
 * nothing survives building the validator (an unresolvable `$ref`, a
 * document that is not an OpenAPI object), so there is no partial
 * result to hand back. The CLI reports it as exit 2, alongside a
 * document it could not read.
 *
 * @public
 */
export class CheckAbortedError extends Error {}

/**
 * Run every selected pass over a resolved spec and grade what they
 * find.
 *
 * Takes a {@link ResolvedSpec} rather than a bare `OpenAPIDocument`,
 * because two of the inputs are byproducts of resolution that the
 * document alone cannot reconstruct: the regions that give each finding
 * its `target.source`, and the `inlinedComponents` list that keeps the
 * hygiene pass from reporting a component an external `$ref` inlined.
 *
 * **Load with `provenance: true` for source attribution.** Without it
 * `ResolvedSpec.regions` is absent, every finding's `target.source` is
 * absent with it, and SARIF output carries no `locations`. That is the
 * same contract `sourceOf` states: a caller distinguishes "no source
 * node corresponds to this" from "no regions were recorded" by whether
 * regions were handed over at all.
 *
 * Synchronous, because every pass is. Loading is the only asynchronous
 * part of a `check` run and it belongs to the caller, which is what
 * keeps this package free of a reader and a second copy of `loadSpec`.
 *
 * @param resolved - A spec from `loadSpec` / `resolveSpec`.
 * @param options - See {@link CheckOptions}.
 * @returns Findings, graded. Empty means clean. A `malformed` finding
 *          in the array means the document cannot be compiled, which is
 *          what the CLI turns into exit 4.
 * @throws CheckAbortedError when the document cannot be graded at all.
 *
 * @public
 */
export function checkSpec(resolved: ResolvedSpec, options: CheckOptions = {}): CheckFinding[] {
  const classes = new Set<CheckClass>(options.only ?? CHECK_CLASSES);
  const severityMap = options.severity ?? EMPTY_SEVERITY_MAP;
  const document: OpenAPIDocument = resolved.document;
  const regions: readonly SpecRegion[] = resolved.regions ?? [];

  const findings: CheckFinding[] = [];

  // Recomputed here rather than read from `resolved.specHygieneIssues`,
  // so that `only` is the single switch deciding whether this class
  // runs. Reading the field would mean a caller who loaded without
  // `lint: true` and asked for the hygiene class got an empty answer
  // and no error.
  const specHygieneIssues = classes.has("hygiene")
    ? lintResolvedSpec(document, { inlinedComponents: resolved.inlinedComponents ?? [] })
    : [];

  if (classes.has("hygiene")) {
    for (const issue of specHygieneIssues) {
      findings.push({
        class: "hygiene",
        severity: defaultSeverityFor("hygiene", issue.code),
        code: issue.code,
        location: issue.pointer,
        message: issue.message,
        target: { pointer: issue.pointer, anchor: "node" },
      });
    }
  }

  // One defect reached from several operations is one thing to fix, and
  // printing it once per operation buries the rest of the report: on
  // Asana 101 schema findings are 28 distinct defects (#520). See
  // `addSchemaFinding` for the key, which is code plus message plus
  // pointer: message alone collapsed two components sharing a relative
  // path into one finding.
  const schemaFindings = new Map<string, CheckFinding>();

  // A malformed schema does not stop the run. The document is still
  // graded and the report is still complete; the finding says that what
  // was graded cannot be compiled. The CLI reads it back off the
  // returned array (a `malformed` finding is present) rather than being
  // told separately, so the two can never disagree.

  if (classes.has("schema")) {
    try {
      const validator = createValidator(document, { schemaLint: "strict" });
      // Compilation is lazy, so without this the schema class inspects
      // nothing: no schema has been checked and schemaLintIssues is
      // empty. `check` is exactly the caller that wants the whole
      // document compiled.
      //
      // `collect` rather than the default `throw`: a tool inspecting a
      // document wants every finding, and stopping at the first
      // malformed schema hid the rest of the file behind it (#515). A
      // server wants the opposite and gets it by default.
      for (const failure of validator.precompile({ onMalformed: "collect" })) {
        addSchemaFinding(schemaFindings, {
          class: "malformed",
          severity: "fatal",
          code: "malformed-schema",
          location: failure.location,
          message: failure.message,
          target:
            failure.pointer === undefined
              ? undefined
              : { pointer: failure.pointer, anchor: failure.anchor ?? "node" },
        });
      }
      for (const issue of validator.stats.schemaLintIssues) {
        // The path is relative to the schema that was compiled, which on
        // a spec with many operations does not say where to look. The
        // validator labels each compile with its operation, so prefer
        // that when it is present.
        const where = issue.path === "" ? "<root>" : issue.path;
        addSchemaFinding(schemaFindings, {
          class: "schema",
          severity: defaultSeverityFor("schema", issue.code),
          code: issue.code,
          location: issue.location === undefined ? where : `${issue.location} -> ${where}`,
          message: issue.message,
          target: targetForSchemaLint(issue),
        });
      }
    } catch (err) {
      // Nothing survives building the validator at all: an unresolvable
      // ref, a document that is not an OpenAPI object. Unlike a
      // malformed schema, there is no partial result to report, so the
      // run aborts rather than returning a report missing one class.
      throw new CheckAbortedError((err as Error).message, { cause: err });
    }

    // Outside the try: a document walk, not a compile, so a malformed
    // schema elsewhere does not cost the reader this finding.
    for (const issue of checkDocumentFormats(document, KNOWN_FORMATS)) {
      findings.push({
        class: "schema",
        severity: defaultSeverityFor("schema", issue.code),
        code: issue.code,
        location: issue.pointer,
        message: issue.message,
        target: { pointer: issue.pointer, anchor: "node" },
      });
    }
  }

  if (classes.has("conformance")) {
    // Structural conformance against the meta-schema OpenAPI publishes
    // for the version this document declares. Deliberately separate
    // from the schema class: that one asks whether oaverify understood
    // your schemas, this one asks whether the document is legal OpenAPI
    // at all. A document can fail either without failing the other.
    //
    // Overlap with the schema classes depends on the version. 3.1 and
    // 3.2 stub the Schema Object upstream, so this pass and the
    // compiler's well-formedness pass are disjoint. 3.0 describes it in
    // full, so one defect there can be reported by both. Deduplicating
    // needs the two to address findings the same way, which is #517:
    // malformed findings are located by operation, these by RFC 6901
    // pointer. See the note in metaschema/src/conformance.ts for why
    // stubbing 3.0 to match is not an option.
    const conformance = checkDocumentConformance(document);
    for (const issue of conformance.issues) {
      findings.push({
        class: "conformance",
        severity: defaultSeverityFor("conformance", issue.code),
        code: issue.code,
        location: issue.pointer,
        message: issue.message,
        target: { pointer: issue.pointer, anchor: "node" },
      });
    }
  }

  if (classes.has("examples")) {
    // Its own class, and its own pass over the document as written,
    // rather than a rule inside the schema class. The schema class
    // reads whatever the validator compiled, and body schemas are
    // compiled per direction (`readOnly` rewritten to `false` on the
    // request leg), so a component example that is a correct response
    // would be reported as invalid there. An example describes the
    // schema as authored, so it is checked against the schema as
    // authored.
    //
    // Separate class also gives the cost its own switch: this is the
    // one check that compiles schemas of its own accord, so
    // `--only hygiene,schema` opts out of it.
    for (const issue of checkDocumentExamples(document)) {
      findings.push({
        class: "examples",
        severity: defaultSeverityFor("examples", issue.code),
        code: issue.code,
        location: issue.pointer,
        message: issue.message,
        reasons: issue.reasons,
        target: { pointer: issue.pointer, anchor: "node" },
      });
    }
  }

  if (classes.has("redos")) {
    // Its own class because it is the only check that reaches for a
    // third-party analyser: `redos-detector` is a dependency of
    // `@oaverify/check`, kept off `@oaverify/core` so that stays
    // dependency-free. Runs by default like every other class; `--only`
    // is how a caller who has already hardened with `regexCompiler`, or
    // who finds the analysis slow on a very large document, opts out.
    for (const issue of checkDocumentRedos(document)) {
      findings.push({
        class: "redos",
        severity: defaultSeverityFor("redos", issue.code),
        code: issue.code,
        location: issue.pointer,
        message: issue.message,
        target: { pointer: issue.pointer, anchor: "node" },
      });
    }
  }

  findings.push(...schemaFindings.values());

  // The caller's grading, applied once over every class rather than at
  // each site that builds a finding, so no class can quietly opt out of
  // it.
  //
  // The `malformed` skip is not redundant with the parse-time refusal.
  // That refusal keys on two literal strings, so it catches
  // `malformed=...` and `malformed-schema=...` and nothing else; a
  // second code in this class carrying a slash would be reachable
  // through a `malformed/*` family key. Skipping by class holds
  // whatever codes the class grows.
  if (severityMap !== EMPTY_SEVERITY_MAP) {
    for (const finding of findings) {
      if (finding.class === "malformed") continue;
      finding.severity = severityFor(severityMap, finding, finding.severity);
    }
  }

  // Every target that addresses a node the resolver built from a source
  // file gains that file's address. A target with no covering region,
  // or one covered by something the resolver invented, keeps no
  // `source`, which is what absence means here.
  for (const finding of findings) {
    if (finding.target === undefined) continue;
    const source = sourceOf(regions, finding.target.pointer);
    if (source !== undefined) finding.target = { ...finding.target, source };
  }

  return findings;
}

/**
 * A schema lint finding's target, taken from what the compile
 * recorded rather than re-derived here.
 *
 * The anchor is decided where the knowledge is: the walk knows whether
 * it crossed a `$ref`, the validator knows whether it unwrapped one
 * before the compile started, and the rule knows whether its verdict
 * depends on the route. None of those is visible from the finished
 * finding, so this copies rather than infers.
 */
function targetForSchemaLint(issue: SchemaLintIssue): FindingTarget | undefined {
  if (issue.pointer === undefined || issue.anchor === undefined) return undefined;
  return { pointer: issue.pointer, anchor: issue.anchor };
}

/**
 * Add a schema finding, collapsing a repeat of one already recorded.
 *
 * Keyed on code plus message plus address. The message carries only the
 * path *within* a schema, so two distinct components with the same
 * defect at the same relative path (`Alpha.properties.a` and
 * `Beta.properties.a`) produce the same message and used to collapse
 * into one finding, hiding the second entirely. Those are two edits in
 * two places, not one defect seen twice.
 *
 * Including the pointer separates them and still collapses what #520
 * wanted collapsed: a genuine repeat is the same defect at the same
 * address, so it keys the same. `occurrences` therefore counts repeats
 * of one address rather than of one message.
 */
function addSchemaFinding(into: Map<string, CheckFinding>, finding: CheckFinding): void {
  const key = `${finding.code}\u0000${finding.message}\u0000${finding.target?.pointer ?? ""}`;
  const already = into.get(key);
  if (already === undefined) {
    into.set(key, finding);
    return;
  }
  already.occurrences = (already.occurrences ?? 1) + 1;
}

/**
 * The composed check: every pass, one graded finding list.
 *
 * This is what `oaverify check` runs. The CLI loads a spec, calls
 * {@link checkSpec}, and renders the result; everything between those
 * two ends lives here.
 *
 * @packageDocumentation
 */

import {
  classifyUnknownVersion,
  detectOpenAPIVersion,
  type OpenAPIDocument,
} from "@oaverify/internal-core";
import {
  lintResolvedSpec,
  sourceOf,
  type ResolvedSpec,
  type SpecRegion,
} from "@oaverify/internal-spec";
import { createValidator } from "@oaverify/internal-validator";
import {
  listUnservedParameterLocations,
  unservedParameterLocationMessage,
  checkDocumentExamplesInContext,
} from "@oaverify/internal-validator/internals";
import { checkDocumentConformance } from "@oaverify/internal-metaschema/conformance";
import {
  checkDocumentSchemas,
  checkMixedDialects,
  documentSchemas,
  type DocumentSchemas,
} from "./document-schemas.js";
import { schemaDialects } from "./schema-dialects.js";
import { checkFormatsInDialects, KNOWN_FORMATS } from "./format-check.js";
import { ambiguityWitness, checkRedosInDialects } from "./redos-check.js";
import { type CheckFinding, type ReasonSource } from "./finding.js";
import { reasonPointersFor } from "./span-target.js";
import {
  FORMAT_WALK_CODE,
  FULL_SELECTION,
  SELECTABLE_CODES,
  type FindingSelection,
} from "./selection.js";
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
   * Which findings to produce. Defaults to {@link FULL_SELECTION}, every
   * code every class can emit.
   *
   * The one selection option, at code granularity. It replaced a
   * class-granular `only`, which asked the same question one step
   * coarser: two options over one question meant two answers that could
   * disagree, and a caller had to know which won.
   *
   * Build one with `resolveFindingSelection(parseFindingTerms(value))`
   * from the CLI's `--findings` grammar, or with
   * {@link selectionForClasses} from a list of classes. The resolved
   * form rather than the strings, for
   * the reason on {@link CheckOptions.severity}.
   *
   * Two things it decides beyond which findings survive.
   *
   * A pass runs only when the selection holds a code that pass owns,
   * which is where the cost goes. Selecting a subset is the only way to
   * opt out of a pass's cost: the `examples` class compiles schemas of
   * its own accord and `redos` reaches for a third-party analyser, so
   * both are worth dropping on a very large document that does not need
   * them.
   *
   * Schema compilation is gated separately from resource discovery.
   * A selection naming `format-not-validated` alone builds the resource
   * inventory so referenced schema targets contribute, but skips compilation.
   * A local five-run Stripe CLI comparison on Node 26.8.2 measured this
   * selection at a median 0.20s / 205MB peak RSS with resource discovery,
   * versus 0.16s / 189MB before it. See docs/strictness.md for scope and
   * the earlier authored-schema compilation comparison.
   *
   * The gradeability gate is not selectable: {@link checkSpec} builds
   * the validator whatever the selection holds, so a document that is
   * not OpenAPI at all throws {@link CheckAbortedError} even when the
   * selection reaches no schema code. The build costs ~8ms on a large
   * document; it is the compile prepass, not the gate, that the
   * selection lets you skip.
   */
  findings?: FindingSelection;
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
 * building the validator fails (an unresolvable `$ref`, a document that
 * is not an OpenAPI object), so no complete report exists. The CLI
 * reports it as exit 2, alongside a document it could not read.
 * Whatever the passes had already produced rides out on
 * {@link CheckAbortedError.findings} rather than being discarded.
 *
 * Thrown at every selection: building the validator is where
 * ungradeability surfaces, and no selection can switch that off. A run
 * asking only for, say, the hygiene class still aborts on a document
 * nothing could grade, rather than returning an empty report that reads
 * as a clean bill (#674).
 *
 * @public
 */
export class CheckAbortedError extends Error {
  /**
   * Findings the passes that ran before the abort had already produced.
   *
   * The abort says the document could not be graded, which is true and
   * is why the exit code does not change. It is not a reason to throw
   * away located, actionable findings on the way out: a spec whose path
   * templates collide aborts in the router, and the hygiene finding
   * naming the offending template is exactly what explains why.
   *
   * Graded exactly like a returned finding: narrowed to the selection,
   * remapped by the caller's severity map, and given its `target.source`.
   * A selection naming one code would otherwise report more on an abort
   * than on a clean run.
   *
   * Empty when nothing had run, which is the common case.
   */
  readonly findings: readonly CheckFinding[];

  constructor(message: string, options?: ErrorOptions & { findings?: readonly CheckFinding[] }) {
    super(message, options);
    this.findings = options?.findings ?? [];
  }
}

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
 * Schema diagnostics compile authored OpenAPI schema roots, including
 * schemas outside routed operations. Subschemas keep their enclosing
 * composition and resource scope. Request/response transformations used
 * by runtime validation do not apply. Examples have their own pass.
 * A root that fails compilation contributes a malformed finding and
 * independent roots continue. Selecting only document-walk codes skips
 * compilation (see {@link CheckOptions.findings}).
 *
 * For OpenAPI 3.1/3.2, `jsonSchemaDialect` sets the default and `$schema`
 * overrides it at a schema root or an embedded `$id` resource. Ordinary
 * subschemas inherit their resource's dialect. Supported declarations are
 * `https://spec.openapis.org/oas/3.1/dialect/base`,
 * `https://spec.openapis.org/oas/3.2/dialect/base`, and
 * `https://json-schema.org/draft/2020-12/schema` (an empty trailing `#` is
 * accepted). Plain 2020-12 treats formats as annotations; the OpenAPI
 * dialects assert supported formats.
 *
 * `unsupported-schema-dialect` is a selectable schema warning. Schema
 * compilation and example validation are withheld for a unit whose
 * structural/reference closure reaches an unsupported dialect or mixes
 * supported dialects with different semantics. Severity remapping and
 * suppression never enable withheld execution. Independent supported
 * resources continue, including embedded resources discovered at recognized
 * schema positions inside unsupported resources. Format and ReDoS observations
 * are local to supported resources; annotation-only formats are omitted.
 * Runtime validation and standalone `checkDocumentExamples` retain
 * their existing dialect policy.
 *
 * @param resolved - A spec from `loadSpec` / `resolveSpec`.
 * @param options - See {@link CheckOptions}.
 * @returns Selected findings, graded. An empty array can reflect withheld
 *          checks when the coverage warning was not selected. A `malformed` finding
 *          in the array means the document cannot be compiled, which is
 *          what the CLI turns into exit 4.
 * @throws CheckAbortedError when the document cannot be graded at all.
 *
 * @public
 */
export function checkSpec(resolved: ResolvedSpec, options: CheckOptions = {}): CheckFinding[] {
  const selection = options.findings ?? FULL_SELECTION;
  const classes = selection.classes;
  const severityMap = options.severity ?? EMPTY_SEVERITY_MAP;
  const document: OpenAPIDocument = resolved.document;
  const regions: readonly SpecRegion[] = resolved.regions ?? [];

  const findings: CheckFinding[] = [];

  // Recomputed here rather than read from `resolved.specHygieneIssues`,
  // so that the selection is the single switch deciding whether this
  // class runs. Reading the field would mean a caller who loaded without
  // `lint: true` and asked for the hygiene class got an empty answer
  // and no error.
  //
  // Ahead of the gate because it needs only the document, so a document
  // that fails the gate still carries located findings out on the error.
  let specHygieneIssues: ReturnType<typeof lintResolvedSpec> = [];
  let lintError: unknown;
  if (classes.has("hygiene")) {
    try {
      specHygieneIssues = lintResolvedSpec(document, {
        inlinedComponents: resolved.inlinedComponents ?? [],
      });
    } catch (err) {
      // Held rather than swallowed. If the gate below rejects the
      // document, it is the authority and reports; a throw from here
      // would pre-empt it with a worse message and a different exit
      // code. If the gate passes, the document was gradeable and this
      // was a defect, so it is rethrown below rather than leaving the
      // hygiene section silently empty on an exit-0 report.
      lintError = err;
    }
  }

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

  // A parameter location the validator cannot serve. Reported rather
  // than left silent, because `createValidator` refuses to build for
  // this document and `compile-spec` refuses to emit for it: a clean
  // report on a document the other two verbs reject is the report
  // being wrong about the only question a user asked it.
  //
  // A finding, not an abort: the location can be legal (3.2's
  // `querystring`), the rest of the document is still gradeable, and one
  // parameter should not cost an author every other finding in the file.
  if (classes.has("hygiene")) {
    for (const unserved of listUnservedParameterLocations(document, {
      followPathItemRefs: true,
    })) {
      findings.push({
        class: "hygiene",
        severity: defaultSeverityFor("hygiene", "unserved-parameter-location"),
        code: "unserved-parameter-location",
        location: unserved.pointer,
        message: unservedParameterLocationMessage(unserved.where, unserved.name, unserved.location),
        // A use site that is a `$ref` holds no `in` to highlight, so the
        // target is the definition and the anchor says a `$ref` was
        // crossed. `scoped-definition` rather than `definition`, because
        // several operations can reach one definition and the message
        // names the operation this finding is about, which is the case
        // that anchor exists for.
        target:
          unserved.definitionPointer === undefined
            ? { pointer: unserved.pointer, anchor: "node" }
            : { pointer: unserved.definitionPointer, anchor: "scoped-definition" },
      });
    }
  }

  // The gradeability gate, unconditional on the selection. Building the
  // validator is what surfaces a document that cannot be graded at all
  // (not an OpenAPI object, an unresolvable ref), and it costs ~8ms and
  // 2MB on stripe.json, which is why it is cheap enough to run always.
  // Gating it on the schema class is what makes a selection like
  // `--findings hygiene` return an empty report with exit 0 on a
  // document nothing could grade (#674).
  try {
    // `unservedParameterLocations: "ignore"`: `createValidator` refuses
    // a document declaring a parameter location it cannot serve (#836),
    // and that refusal is about serving requests, not about whether the
    // document can be graded. Aborting cost a legal 3.2 document its
    // whole report, and cost a Swagger 2.0 leftover the conformance
    // findings that name the offending `in`.
    //
    // The option rather than a filtered copy of the document, which is
    // what this did first: rewriting `paths` to drop the offenders lost
    // the elided parameter's own schema findings, mishandled
    // `paths: null` and a `__proto__` path key, and could not shield a
    // dangling `$ref` from the gate anyway. Nothing is rewritten now,
    // so every pass sees the document the author wrote.
    createValidator(document, {
      schemaLint: "strict",
      unservedParameterLocations: "ignore",
    });
  } catch (err) {
    gradeFindings(findings, selection, severityMap, regions);
    throw new CheckAbortedError((err as Error).message, { cause: err, findings });
  }
  if (lintError !== undefined) throw lintError;

  if (
    classes.has("hygiene") &&
    detectOpenAPIVersion(document) === undefined &&
    classifyUnknownVersion(document.openapi).kind === "ok-unknown-minor"
  ) {
    findings.push({
      class: "hygiene",
      severity: defaultSeverityFor("hygiene", "unsupported-openapi-version"),
      code: "unsupported-openapi-version",
      location: "/openapi",
      message: `OpenAPI "${document.openapi}" is unsupported; conformance is skipped and schema checks use OpenAPI 3.1 semantics.`,
      target: { pointer: "/openapi", anchor: "node" },
    });
  }

  // One defect reached from several operations is one thing to fix, and
  // printing it once per operation buries the rest of the report: on
  // Asana 101 schema findings are 28 distinct defects (#520). See
  // `addSchemaFinding` for the key, which is code plus message plus
  // pointer: message alone collapsed two components sharing a relative
  // path into one finding.
  const schemaFindings = new Map<string, CheckFinding>();
  const dialects =
    classes.has("schema") || classes.has("examples") || classes.has("redos")
      ? schemaDialects(document)
      : undefined;
  let inventory: DocumentSchemas | undefined;
  const schemas = (): DocumentSchemas => (inventory ??= documentSchemas(document, dialects!));

  // A malformed schema does not stop the run. The document is still
  // graded and the report is still complete; the finding says that what
  // was graded cannot be compiled. The CLI reads it back off the
  // returned array (a `malformed` finding is present) rather than being
  // told separately, so the two can never disagree.

  if (classes.has("schema")) {
    // Compiler-owned findings require authored schema roots to be compiled.
    // A format-only selection remains a document walk.
    if (selection.compileSchemas) {
      for (const finding of checkDocumentSchemas(document, schemas())) {
        addSchemaFinding(schemaFindings, finding);
      }
    }

    // Its own gate: a document walk, not a compile, so a malformed
    // schema elsewhere does not cost the reader this finding. Gated on
    // its own code rather than on the class, which is what lets a
    // selection naming it alone skip the compile above.
    if (selection.base.has(FORMAT_WALK_CODE)) {
      for (const issue of checkFormatsInDialects(KNOWN_FORMATS, schemas().dialects)) {
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
    // Example validation has a separate selection and cost gate.
    // The guard hands the pass the same ambiguity analysis the redos
    // class runs, so an example whose schema reaches a catastrophic
    // pattern is reported as uncheckable instead of executed (#687:
    // a non-matching example against such a pattern hangs the
    // process). Wired here regardless of whether the redos class is
    // selected: `--findings examples` has to be protected too, so the
    // shared thing is the analysis, not the selection. Cached per
    // pattern source; the analysis is the expensive part.
    const ambiguity = new Map<string, boolean>();
    const patternGuard = (pattern: string): boolean => {
      let verdict = ambiguity.get(pattern);
      if (verdict === undefined) {
        verdict = ambiguityWitness(pattern) !== undefined;
        ambiguity.set(pattern, verdict);
      }
      return verdict;
    };
    for (const issue of checkDocumentExamplesInContext(
      document,
      { patternGuard },
      (schema) => schemas().prepare(schema),
      schemas().dialects.entries,
    )) {
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
    // dependency-free. Runs by default like every other class;
    // `--findings` is how a caller who has already hardened with
    // `regexCompiler`, or
    // who finds the analysis slow on a very large document, opts out.
    for (const issue of checkRedosInDialects(schemas().dialects)) {
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

  if (selection.base.has("unsupported-schema-dialect")) {
    if (
      dialects!.entries.some(
        ({ schema }) => typeof schema.$ref === "string" || typeof schema.$dynamicRef === "string",
      )
    )
      schemas();
    for (const finding of dialects!.unsupported.values()) addSchemaFinding(schemaFindings, finding);
    if (dialects!.supported.size > 1) {
      for (const finding of checkMixedDialects(schemas()))
        addSchemaFinding(schemaFindings, finding);
    }
  }
  findings.push(...schemaFindings.values());

  gradeFindings(findings, selection, severityMap, regions);

  return findings;
}

/**
 * The steps every finding goes through after the passes have run:
 * code-level narrowing, the caller's severity map, and provenance.
 *
 * Extracted so the aborted path can run them too. A finding handed out
 * on {@link CheckAbortedError} is graded exactly like a returned one, or
 * a selection naming a single code would report more on an abort than it
 * does on a clean run, which is the failure this whole area exists to
 * avoid.
 */
function gradeFindings(
  findings: CheckFinding[],
  selection: FindingSelection,
  severityMap: SeverityMap,
  regions: readonly SpecRegion[],
): void {
  // Narrowing within a class, which the pass gates above cannot do: a
  // selection naming one hygiene code still runs the whole hygiene pass.
  //
  // Two things survive it unconditionally. `malformed` is not in the
  // selectable vocabulary at all, so no selection can name it and none
  // can drop it; when the compile ran and found one, it is reported. And
  // a code the registry does not know is kept rather than dropped, so
  // drift between a pass and `codes.ts` surfaces as an unexpected
  // finding instead of a silently missing one.
  if (selection.base.size !== SELECTABLE_CODES.size) {
    const kept = findings.filter(
      (f) => f.class === "malformed" || !SELECTABLE_CODES.has(f.code) || selection.base.has(f.code),
    );
    findings.length = 0;
    findings.push(...kept);
  }

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
    // A reason's position is resolved the same way, rather than derived
    // by appending its path to the address above. The two differ
    // exactly when an overlay rewrote the node: the container keeps its
    // address while what is inside it no longer matches the file, so
    // deriving produced a region over bytes the overlay had removed
    // (#776). Asking `sourceOf` per position makes a rewritten node
    // answer with nothing, which is the right answer and the same one
    // it gives for the finding's own pointer.
    const reasonSources: ReasonSource[] = [];
    for (const { index, pointer } of reasonPointersFor(finding)) {
      const at = sourceOf(regions, pointer);
      if (at !== undefined) reasonSources.push({ index, source: at });
    }
    if (reasonSources.length > 0) finding.reasonSources = reasonSources;
  }
}

/**
 * Add a schema finding, collapsing a repeat of one already recorded.
 * Malformed findings identify the offending value directly, so their
 * pointer is sufficient even when traversal changes the rendered path.
 *
 * Keyed on code plus message plus address. The message carries only the
 * path *within* a schema, so two distinct components with the same
 * defect at the same relative path (`Alpha.properties.a` and
 * `Beta.properties.a`) produce the same message. Keyed on message alone
 * they collapse into one finding and the second disappears, though they
 * are two edits in two places rather than one defect seen twice.
 *
 * Including the pointer separates them and still collapses what #520
 * wanted collapsed: a genuine repeat is the same defect at the same
 * address, so it keys the same. `occurrences` therefore counts repeats
 * of one address rather than of one message.
 */
function addSchemaFinding(into: Map<string, CheckFinding>, finding: CheckFinding): void {
  const messageKey =
    finding.class === "malformed" && finding.target !== undefined ? "" : finding.message;
  const key = `${finding.code}\u0000${messageKey}\u0000${finding.target?.pointer ?? ""}`;
  const already = into.get(key);
  if (already === undefined) {
    into.set(key, finding);
    return;
  }
  already.occurrences = (already.occurrences ?? 1) + 1;
}

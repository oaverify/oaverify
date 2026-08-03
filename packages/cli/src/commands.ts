import { readFile, writeFile } from "node:fs/promises";
import {
  formatError,
  type JsonValue,
  type OutputFormat,
  type SchemaOrBoolean,
  type ValidationError,
} from "@oaverify/internal-core";
import {
  composeReaders,
  createFileReader,
  createHttpReader,
  isSpecOverlay,
  loadSpec,
  sourceOf,
  specOverlayVerbs,
  type DocumentReader,
  type SourceAddress,
  type SpecHygieneIssue,
  type SpecOverlay,
  type SpecRegion,
} from "@oaverify/internal-spec";
import {
  isOverlayDocument,
  translateOverlay,
  type OverlayDocument,
} from "@oaverify/internal-overlay-spec";
import { checkDocumentExamples, createValidator } from "@oaverify/internal-validator";
import type { SchemaLintIssue } from "@oaverify/internal-schema";
import { checkDocumentConformance } from "@oaverify/internal-metaschema/conformance";
import type * as Esbuild from "esbuild";
import type { OpenAPIDocument, RejectionReason } from "@oaverify/internal-core";
import { analyzeSpec } from "@oaverify/stream";
import { emitStandalone, type StandaloneDialect } from "./emit-standalone.js";
import { emitSpec } from "./emit-spec.js";
import { parseHttpFile } from "./http-parser.js";
import { checkDocumentRedos } from "./redos-check.js";
import { hasUnbounded, renderStreamBudget } from "./stream-check.js";

/**
 * Input shared by all CLI commands.
 *
 * @public
 */
export interface CommandOptions {
  /**
   * How `validate` renders an error tree. Only that command reads it;
   * `resolve` and `check` produce their own output and leave it unset.
   * Distinct from `check --format`, which selects an envelope shape
   * rather than an error renderer.
   */
  format?: OutputFormat;
  depth?: number;
  output?: string;
  quiet: boolean;
}

/**
 * Output of a command invocation: just the exit code. Commands write
 * their primary output through {@link CommandIo.stdout} (or the file
 * sink when `--output` is set); errors go through
 * {@link CommandIo.stderr}. Nothing is returned for the CLI layer to
 * echo.
 *
 * @public
 */
export interface CommandResult {
  exitCode: number;
}

/**
 * I/O substrate the commands talk to. Defaults to the local
 * filesystem + stdin/stdout/stderr; tests can pass an in-memory
 * substitute that captures writes for assertion.
 *
 * @public
 */
export interface CommandIo {
  reader: DocumentReader;
  readText(pathOrDash: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The real-filesystem {@link CommandIo}, used when callers don't
 * supply one of their own.
 *
 * @public
 */
export function defaultCommandIo(): CommandIo {
  return {
    // File reader first so `./spec.json` resolves locally without a
    // stat against the HTTP reader (which would reject it via
    // canRead anyway, but clearer ordering). HTTP reader accepts
    // `http:` / `https:` URIs; the YAML-over-HTTP story rides on
    // top of this chain in oaverify's CLI wrapper, which
    // composes YAML readers in front of whatever we return here.
    reader: composeReaders([createFileReader(), createHttpReader()]),
    async readText(pathOrDash: string) {
      if (pathOrDash === "-") return readAllStdin();
      return readFile(pathOrDash, "utf8");
    },
    async writeText(path: string, content: string) {
      await writeFile(path, content);
    },
    stdout: (chunk) => void process.stdout.write(chunk),
    stderr: (chunk) => void process.stderr.write(chunk),
  };
}

/**
 * Read and shape-check one `--overlay` file. Accepts a standard
 * OpenAPI Overlay 1.0 document (routed through
 * `@oaverify/core/overlay-spec`'s `translateOverlay`) or a typed
 * {@link SpecOverlay} (every key a recognised verb). Anything else
 * throws with the offending path and keys instead of being cast and
 * silently mis-applied (#448).
 */
async function readOverlay(io: CommandIo, path: string): Promise<SpecOverlay> {
  const doc = await io.reader.read(path);
  if (isOverlayDocument(doc)) {
    try {
      return translateOverlay(doc);
    } catch (err) {
      throw new Error(`${path}: ${(err as Error).message}`, { cause: err });
    }
  }
  if (isSpecOverlay(doc)) return doc;
  if (typeof doc !== "object" || doc === null) {
    throw new Error(`${path}: overlay file must contain an object`);
  }
  const keys = Object.keys(doc);
  if (keys.includes("overlay") || keys.includes("actions")) {
    // Meant to be an Overlay 1.0 document but the envelope is
    // incomplete; the translator's field-level complaint beats a
    // generic shape error.
    try {
      translateOverlay(doc as OverlayDocument);
    } catch (err) {
      throw new Error(`${path}: ${(err as Error).message}`, { cause: err });
    }
  }
  const unknown = keys.filter((key) => !specOverlayVerbs.has(key));
  throw new Error(
    `${path}: unrecognised overlay shape; expected an OpenAPI Overlay 1.0 document ` +
      `(\`overlay\`/\`info\`/\`actions\`) or a typed SpecOverlay ` +
      `(unrecognised keys: ${unknown.join(", ")})`,
  );
}

function readOverlays(io: CommandIo, paths: string[]): Promise<SpecOverlay[]> {
  return Promise.all(paths.map((path) => readOverlay(io, path)));
}

/**
 * Pick the primary output sink for a command:
 * - `--output FILE` → write to file (unconditional; `--quiet` doesn't
 *   suppress a deliberate file write).
 * - else if `--quiet` → swallow.
 * - else → `io.stdout`.
 *
 * Commands write exactly once through this sink, so `-o` naturally
 * redirects the "would go to stdout" content to a file without
 * duplicating it.
 */
function primarySink(
  io: CommandIo,
  opts: { output?: string; quiet: boolean },
): (content: string) => Promise<void> | void {
  if (opts.output !== undefined) {
    const path = opts.output;
    return (content) => io.writeText(path, content);
  }
  if (opts.quiet) return () => {};
  return io.stdout;
}

/**
 * Implement the `oaverify resolve <spec>` subcommand.
 *
 * @param args - Entry spec path, overlay files, optional lint flags, and
 *   base CLI options.
 * @returns Exit code 0 on success, 1 when `--lint --fail-on warning`
 *   surfaces any findings, 3 on usage errors (`--fail-on` without
 *   `--lint`, or an `--overlay` file of unrecognised shape).
 *
 * @public
 */
export async function resolveCommand(
  args: {
    spec: string;
    overlays: string[];
    options: CommandOptions;
  },
  io: CommandIo = defaultCommandIo(),
): Promise<CommandResult> {
  let overlayDocs: SpecOverlay[];
  try {
    overlayDocs = await readOverlays(io, args.overlays);
  } catch (err) {
    io.stderr(`resolve: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }
  const { document } = await loadSpec({
    reader: io.reader,
    entry: args.spec,
    overlays: overlayDocs,
  });

  await primarySink(io, args.options)(JSON.stringify(document, null, 2) + "\n");
  return { exitCode: 0 };
}

/**
 * A single finding from `oaverify check`, normalised across the classes so
 * one array can carry all of them.
 *
 * The CLI unifies where the programmatic API does not: `check` runs the
 * classes together by construction, while an API caller reaches for one
 * layer at a time and would have to filter a union to get back what they
 * asked for. `class` is required so a consumer can re-split them.
 *
 * @public
 */
export interface CheckFinding {
  /**
   * Which check produced this, matching the three-class model in
   * docs/strictness.md.
   *
   * Not the same set as {@link CHECK_CLASSES}, which is what `--only`
   * selects. A malformed schema is found by compiling, which is what the
   * `schema` class does, so it cannot be requested on its own; it is
   * reported under its own class because it is a different kind of
   * problem with a different remedy, and a consumer re-splitting the
   * array should not have to match on `code` to find it.
   */
  class: "hygiene" | "schema" | "malformed" | "conformance" | "examples" | "redos";
  /**
   * What this means for you, independent of which check found it.
   *
   * Separate from `class` on purpose. Class says which pass produced a
   * finding; severity says whether it breaks anything. Conflating them
   * is what made `--fail-on` useless: `path-param-undeclared` violates
   * the OpenAPI spec and `unused-tag` is housekeeping, but both are
   * `hygiene`, so gating on the class meant gating on both or neither.
   *
   * - `"fatal"`: the document cannot be compiled into a validator.
   * - `"error"`: legal to parse, but violates the OpenAPI specification.
   * - `"warning"`: legal, and probably not what the author meant.
   */
  severity: CheckSeverity;
  /** The class-specific code, e.g. `"unused-component"`, `"unknown-keyword"`. */
  code: string;
  /**
   * Where it is, for a human. Display text, and the format varies by
   * class: a pointer for the classes that address the document, an
   * operation label plus a path within the schema for the classes that
   * do not.
   *
   * **Never parse this.** It carries no stable grammar and is free to
   * change wording. {@link CheckFinding.target} is the machine address
   * and is the field to switch on, key off, or map to a source line.
   *
   * Unchanged since before `target` existed, deliberately: the point of
   * adding a machine contract was to stop a consumer needing this one,
   * not to alter what a reader sees.
   */
  location: string;
  message: string;
  /**
   * How many operations reported this same defect, when more than one.
   * Absent for a single occurrence.
   *
   * Schemas compile per operation, so a component reached from several
   * of them is checked several times and produces one finding each. They
   * are one defect and one edit. `location` names the first operation
   * that reached it; the rest are collapsed into this count rather than
   * printed again.
   */
  occurrences?: number;
  /**
   * Structured cause data: every leaf the underlying check rejected the
   * value on. The machine half of `message`, so a consumer never
   * recovers `allowed` / `actual` by parsing prose (#580).
   *
   * Populated by the `examples` class only. Absent on every other
   * class, which means "this class does not produce leaf-level causes",
   * not "this finding had none". The field is class-agnostic by
   * construction, so `conformance` (whose issues are validation
   * failures of the same shape) can adopt it later without a rename.
   *
   * Uncapped, and so longer than `message` where `message` truncated.
   * See {@link ExampleIssue.reasons}.
   */
  reasons?: readonly RejectionReason[];
  /**
   * Where this finding is, for a machine. The counterpart to
   * `location`, which stays prose.
   *
   * Absent means **no pointer into the resolved document resolves to
   * this finding**, which is a fact about the finding rather than an
   * omission, and never an instruction to parse `location` instead.
   * External `$ref` targets and anchors name a schema and no position
   * in this document; a hand-built route has no addressable operation.
   * A synthesized pointer that resolves nowhere, or worse resolves
   * somewhere wrong, is the failure this field exists to prevent.
   *
   * Populated per class:
   * - `hygiene`, `conformance`, `examples`, `redos`: always, anchored
   *   at the offending node.
   * - `schema`: whenever the compile knew where its schema sat in the
   *   document, which is every schema `check` compiles.
   * - `malformed`: the schema that would not compile, addressed as the
   *   successful path would have addressed it. Where the failure is
   *   operation-wide rather than owned by one schema (an unresolvable
   *   `$ref` that aborts the build), the pointer names the operation
   *   instead, which is the smallest unit that failed. Absent for a
   *   security compile, which has no document position of its own.
   *
   * One finding can stand for several occurrences of the same defect
   * (see `occurrences`), and `target` then addresses the first one
   * reached, exactly as `location` does. It locates the defect; it does
   * not enumerate every site affected.
   */
  target?: FindingTarget;
}

/**
 * What a {@link CheckFinding.target} pointer means for the reader who
 * follows it.
 *
 * Derived from what the analysis actually did rather than declared per
 * rule, with one exception noted on `scoped-definition`.
 *
 * @public
 */
export type FindingAnchor =
  /**
   * The pointer is the finding's own address, reached without crossing
   * a `$ref`, so editing there affects nothing else. Usually the
   * offending node; for an operation-wide build failure it is the
   * operation, which is the smallest unit that failed.
   */
  | "node"
  /**
   * A `$ref` was crossed, and the pointer names the shared definition
   * the text is written in. Editing there affects every use site, and
   * `location` may name an operation this pointer does not address.
   */
  | "definition"
  /**
   * A `$ref` was crossed, the pointer names the shared definition, and
   * the finding is **scoped to the route** named by `location`. The
   * text at the pointer may be correct for the definition's other
   * users.
   *
   * The one anchor that is not a property of the walk alone: it also
   * depends on whether a rule's verdict varies by the route taken to
   * reach a node. Today that is `silent-rewrite/required-not-in-properties`
   * alone, which asks which property names are reachable at an
   * *instance* position, and a component says different things at
   * different use sites.
   */
  | "scoped-definition";

/**
 * A finding's machine-readable address.
 *
 * One object rather than two optional fields, because the two are
 * coupled in both directions: an anchor is meaningless without a
 * pointer, and a pointer is ambiguous without an anchor. Splitting
 * them would admit two states that should be unrepresentable.
 *
 * @public
 */
export interface FindingTarget {
  /**
   * RFC 6901 pointer into the resolved document, percent-decoded with
   * `~0` / `~1` retained. Guaranteed to resolve against the document
   * `check` graded; that guarantee is why the field is absent rather
   * than best-effort.
   */
  pointer: string;
  /** What following `pointer` gets you, and what editing there affects. */
  anchor: FindingAnchor;
  /**
   * Where the node at `pointer` came from in the files that were read:
   * which document, where in it, and the references that reached it.
   *
   * `pointer` addresses the **resolved** document, which for a spec
   * assembled from several files names a node no author typed, in a
   * component the resolver may have invented. This is the address in
   * the file the author would open.
   *
   * Absent means no source node corresponds to this one. In `check`
   * output that is a fact about the node rather than an omission:
   * `check` always records provenance, so absence means the node exists
   * only in the resolved document. The resolver invented the container
   * that holds hoisted schemas, or the root extension that stitched
   * externals live under, or an overlay rewrote or added the node after
   * resolution and its position in a source file would be stale.
   *
   * Present or absent as a unit, never partly filled. See
   * {@link SourceAddress}, which also states the one thing this does not
   * claim: it addresses the node the resolved node was built from, and
   * does not promise the two hold the same value.
   */
  source?: SourceAddress;
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

/**
 * Check classes `--only` accepts. These are the checks that can be
 * *run*; see {@link CheckFinding.class} for the classes a finding can be
 * *reported* under, which additionally includes `"malformed"`.
 */
export const CHECK_CLASSES = ["hygiene", "schema", "conformance", "examples", "redos"] as const;
export type CheckClass = (typeof CHECK_CLASSES)[number];

/**
 * Severities `--fail-on` accepts, ordered least to most serious. A
 * threshold fires on its own level and everything above it, so
 * `--fail-on error` gates on specification violations and ignores the
 * rest.
 *
 * No `info` level, deliberately. Adding one and putting the tidiness
 * codes in it would have changed what `--fail-on warning` does: it
 * historically meant "any finding at all", and demoting
 * `unused-component` below the threshold would silently stop an
 * existing CI gate from firing. `warning` is also the honest level for
 * those codes: declaring a component nothing reaches is legal, and
 * probably not what the author meant, which is what warning means here.
 * An `info` level can be added when something actually belongs in it.
 */
export const CHECK_SEVERITIES = ["warning", "error", "fatal"] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];

/**
 * Hygiene codes that are specification violations rather than
 * housekeeping. OpenAPI requires every path-template placeholder to have
 * a matching parameter declaration, so these are not a matter of taste;
 * the rest of the hygiene codes (unused components, tags, `$defs`) name
 * things that are legal and merely dead.
 */
const HYGIENE_ERRORS = new Set(["path-param-undeclared", "path-param-unused"]);

/**
 * Column budget the `check` text report wraps to when the caller does
 * not supply one, which covers every non-TTY run: a pipe, a redirect,
 * `-o file`, and the tests.
 *
 * A fixed number rather than "unwrapped when not a terminal" so that
 * redirected output is identical to what the terminal showed, which is
 * what makes a saved report reviewable and a golden file diffable.
 */
const DEFAULT_REPORT_WIDTH = 80;

/**
 * Greedy word-wrap for report prose.
 *
 * Long unbroken tokens (JSON pointers, regex sources, schema paths) are
 * allowed to overrun the width rather than being split. Breaking them
 * would make the one part of a finding a reader needs to copy verbatim
 * the one part they cannot select in a single go, and a pointer that
 * wrapped mid-token reads as two pointers.
 */
function wrapText(text: string, width: number, first: string, rest: string): string[] {
  const lines: string[] = [];
  let prefix = first;
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line === "") {
      line = word;
    } else if (prefix.length + line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(prefix + line);
      prefix = rest;
      line = word;
    }
  }
  if (line !== "") lines.push(prefix + line);
  return lines.length === 0 ? [first.trimEnd()] : lines;
}

/**
 * Implement the `oaverify check <spec> ...` subcommand: answer "what is
 * wrong with my spec?".
 *
 * The counterpart to `validate`, which answers "does this payload conform?".
 * Two verbs, one question each: `check` is about the document, `validate`
 * is about traffic.
 *
 * Findings carry a `class` (which pass found it, and what `--only`
 * selects) and a `severity` (what it means for you, and what `--fail-on`
 * gates on). The two cut across each other: `hygiene` holds both a
 * specification violation and pure housekeeping. See
 * docs/strictness.md.
 *
 * - **malformed**: a schema the compiler cannot interpret at all. Fatal
 *   for the operation that holds it, so the run exits 2 whatever the
 *   gate says, and reported alongside the rest rather than instead of
 *   it: one bad `items` should not hide every other finding in the
 *   document (#515).
 * - **hygiene**: unused components / tags / `$defs`, path-parameter
 *   mismatches.
 * - **schema**: partially-implemented keywords, unknown keywords.
 * - **conformance**: the document does not satisfy the JSON Schema
 *   OpenAPI publishes for the version it declares. Structural only; it
 *   cannot follow references, so cross-reference defects are out of
 *   scope (see docs/strictness.md).
 *
 * @returns 0 clean, 1 findings met `--fail-on`, 2 the document could not be
 *          read at all (nothing was graded, nothing printed), 3 usage error,
 *          4 the document was graded and at least one schema is malformed.
 *
 * The 2-versus-4 split is what a script can act on. Exit 2 means there
 * is no report to read, and it means the same thing in every command
 * that loads a spec. Exit 4 means the report on stdout is complete and
 * one or more of its findings makes the document uncompilable, which is
 * a different remedy: read the findings, fix the schema. Before this
 * split both answered 2, so a caller could not tell "I could not open
 * your file" from "here are 43 findings, one of them fatal".
 *
 * @public
 */
export async function checkCommand(
  args: {
    spec: string;
    overlays: string[];
    /** Classes to run. Defaults to all of {@link CHECK_CLASSES}. */
    only?: CheckClass[];
    /**
     * Exit non-zero when any finding at or above this severity appears.
     * `"warning"` is the floor and keeps its historical meaning of "any
     * finding at all"; `"error"` is the new capability, gating on
     * specification violations while ignoring the rest.
     */
    failOn?: CheckSeverity;
    /** `"text"` (default) or `"json"`. */
    format?: "text" | "json";
    /**
     * Column budget the `"text"` report wraps prose to. Defaults to
     * {@link DEFAULT_REPORT_WIDTH}.
     *
     * Passed in rather than read from `process.stdout` here so the width
     * is an input to the rendering and not an ambient fact about the
     * process: tests pin it, and a run whose output is redirected wraps
     * the same way every time instead of inheriting whatever terminal
     * happened to launch it. `cli.ts` supplies the terminal width when
     * stdout is a TTY.
     */
    width?: number;
    options: CommandOptions;
  },
  io: CommandIo = defaultCommandIo(),
): Promise<CommandResult> {
  const classes = new Set<CheckClass>(args.only ?? CHECK_CLASSES);

  let overlayDocs: SpecOverlay[];
  try {
    overlayDocs = await readOverlays(io, args.overlays);
  } catch (err) {
    io.stderr(`check: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }

  const findings: CheckFinding[] = [];

  let document: OpenAPIDocument;
  let specHygieneIssues: readonly SpecHygieneIssue[] = [];
  // Where each part of the resolved document came from, applied to
  // every finding's target in one pass below rather than per class, so
  // no class can quietly answer differently from the rest.
  let regions: readonly SpecRegion[] = [];
  try {
    const loaded = await loadSpec({
      reader: io.reader,
      entry: args.spec,
      overlays: overlayDocs,
      lint: classes.has("hygiene"),
      provenance: true,
    });
    document = loaded.document;
    specHygieneIssues = loaded.specHygieneIssues;
    regions = loaded.regions ?? [];
  } catch (err) {
    // The document could not be read, resolved, or parsed. Not a finding:
    // there is nothing to report findings about.
    io.stderr(`check: ${(err as Error).message}\n`);
    return { exitCode: 2 };
  }

  if (classes.has("hygiene")) {
    for (const issue of specHygieneIssues) {
      findings.push({
        class: "hygiene",
        severity: HYGIENE_ERRORS.has(issue.code) ? "error" : "warning",
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

  // Set when at least one schema was malformed. The document is still
  // graded, so the report is complete; the exit code says the grading
  // ran against a document that cannot be compiled.
  let malformed = false;

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
        malformed = true;
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
          severity: "warning",
          code: issue.code,
          location: issue.location === undefined ? where : `${issue.location} -> ${where}`,
          message: issue.message,
          target: targetForSchemaLint(issue),
        });
      }
    } catch (err) {
      // Nothing survives building the validator at all: an unresolvable
      // ref, a document that is not an OpenAPI object. Unlike a
      // malformed schema, there is no partial result to report.
      io.stderr(`check: ${(err as Error).message}\n`);
      return { exitCode: 2 };
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
        severity: "error",
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
        severity: "warning",
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
    // third-party analyser: `redos-detector` is a CLI dependency, kept
    // out of the library so `@oaverify/core` stays dependency-free (see
    // redos-check.ts). Runs by default like every other class; `--only`
    // is how a caller who has already hardened with `regexCompiler`, or
    // who finds the analysis slow on a very large document, opts out.
    for (const issue of checkDocumentRedos(document)) {
      findings.push({
        class: "redos",
        severity: "warning",
        code: issue.code,
        location: issue.pointer,
        message: issue.message,
        target: { pointer: issue.pointer, anchor: "node" },
      });
    }
  }

  findings.push(...schemaFindings.values());

  // Every target that addresses a node the resolver built from a source
  // file gains that file's address. A target with no covering region,
  // or one covered by something the resolver invented, keeps no
  // `source`, which is what absence means here.
  for (const finding of findings) {
    if (finding.target === undefined) continue;
    const source = sourceOf(regions, finding.target.pointer);
    if (source !== undefined) finding.target = { ...finding.target, source };
  }

  const sink = primarySink(io, args.options);
  if (args.format === "json") {
    await sink(JSON.stringify({ findings }, null, 2) + "\n");
  } else if (findings.length === 0) {
    await sink(`check: no findings (${[...classes].sort().join(", ")})\n`);
  } else {
    const width = args.width ?? DEFAULT_REPORT_WIDTH;
    for (const f of findings) {
      // Three parts, each on its own line, because they answer three
      // different questions and a reader is usually asking one of them:
      // how bad and what kind (the header), where to look (`at`), and
      // what is wrong (the message). Run together on one line, as this
      // was, the header was the only part with a fixed position and the
      // other two ran past the terminal width into a wrap the reader had
      // to re-parse per finding.
      //
      // Severity leads, because it is what decides whether you act now.
      // Class follows, because it says which pass to look at. Both are
      // padded to a column so that the codes line up down the report and
      // a scan for one severity is a scan down a fixed offset.
      const also = f.occurrences === undefined ? "" : `  (+${f.occurrences - 1} more operation(s))`;
      await sink(`${f.severity.padEnd(7)}  ${f.class.padEnd(11)}  ${f.code}${also}\n`);
      // Message before location, at the shallower indent, because "what
      // is wrong" is what a reader wants from a report they are skimming
      // and "where" is what they want only once one finding has their
      // attention. The location then hangs deeper, like a stack frame
      // under an exception.
      //
      // The two indents are what separates them. At a common indent the
      // blocks ran together, which mattered here because several
      // messages open by restating the schema path that the location
      // ends on, so the eye had no cue for where one stopped.
      for (const line of wrapText(f.message, width, "  ", "  ")) await sink(`${line}\n`);
      for (const line of wrapText(f.location, width, "    at ", "       ")) await sink(`${line}\n`);
      // Blank line between findings: the report is scanned for the one
      // that matters, and blocks separate where indentation alone does
      // not once a message itself wraps to several lines.
      await sink("\n");
    }
    // A bare total does not say whether to act. The breakdown does, and
    // it is the whole reason severity exists as a field.
    const bySeverity = CHECK_SEVERITIES.filter((sev) => findings.some((f) => f.severity === sev))
      .reverse()
      .map((sev) => `${findings.filter((f) => f.severity === sev).length} ${sev}`)
      .join(", ");
    // No leading blank line: each finding block already ends with one.
    await sink(`${findings.length} finding(s): ${bySeverity}\n`);
  }

  // A malformed schema outranks the gate: the document cannot be
  // compiled, whatever the findings say. Distinct from the exit 2 above,
  // which means the document could not be read and nothing was printed;
  // here the report is complete and one of its findings is fatal.
  if (malformed) return { exitCode: 4 };
  if (args.failOn !== undefined) {
    const threshold = CHECK_SEVERITIES.indexOf(args.failOn);
    const hit = findings.some((f) => CHECK_SEVERITIES.indexOf(f.severity) >= threshold);
    if (hit) return { exitCode: 1 };
  }
  return { exitCode: 0 };
}

/**
 * Implement the `oaverify stream-check <spec> ...` subcommand: roll up the
 * streaming-buffer budget for every operation's request / response bodies
 * and print a per-operation table (or the `SpecBudget` JSON payload). This
 * is the streamability analysis (`@oaverify/stream`) surfaced over a
 * whole resolved spec, so a deployer can see, before deploy, which bodies
 * stream and which buffer (and where).
 *
 * @returns exit code 0, or 1 when `--fail-on-unbounded` is set and any body
 *          has an unbounded peak.
 *
 * @public
 */
export async function streamCheckCommand(
  args: {
    spec: string;
    overlays: string[];
    format: "text" | "json";
    maxBufferedBytes?: number;
    failOnUnbounded: boolean;
    verbose: boolean;
    options: CommandOptions;
  },
  io: CommandIo = defaultCommandIo(),
): Promise<CommandResult> {
  let overlayDocs: SpecOverlay[];
  try {
    overlayDocs = await readOverlays(io, args.overlays);
  } catch (err) {
    io.stderr(`stream-check: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }
  const { document } = await loadSpec({
    reader: io.reader,
    entry: args.spec,
    overlays: overlayDocs,
  });

  const budget = analyzeSpec(
    document,
    args.maxBufferedBytes === undefined ? {} : { maxBufferedBytes: args.maxBufferedBytes },
  );

  const sink = primarySink(io, args.options);
  if (args.format === "json") {
    await sink(JSON.stringify(budget, null, 2) + "\n");
  } else {
    await sink(renderStreamBudget(document, budget, { verbose: args.verbose }));
  }

  if (args.failOnUnbounded && hasUnbounded(budget)) return { exitCode: 1 };
  return { exitCode: 0 };
}

/**
 * Implement the `oaverify validate <spec> ...` subcommand.
 *
 * @param args - Entry spec, overlays, and one of the mutually-exclusive
 *               validate-what inputs.
 * @returns A validation result with exit code 0 (valid) / 1 (invalid) / 3 (usage).
 *
 * @public
 */
export async function validateCommand(
  args: {
    spec: string;
    overlays: string[];
    mode: ValidateMode;
    options: CommandOptions;
  },
  io: CommandIo = defaultCommandIo(),
): Promise<CommandResult> {
  let overlayDocs: SpecOverlay[];
  try {
    overlayDocs = await readOverlays(io, args.overlays);
  } catch (err) {
    io.stderr(`validate: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }
  const { document } = await loadSpec({
    reader: io.reader,
    entry: args.spec,
    overlays: overlayDocs,
  });
  // The CLI renders a nested error tree and reports every problem it
  // finds, so it compiles in tree mode with uncapped error collection
  // rather than the flat fail-fast default.
  const validator = createValidator(document, {
    output: "tree",
    maxErrors: Number.POSITIVE_INFINITY,
  });

  let err: ValidationError | null;
  if (args.mode.kind === "request") {
    const raw = await io.readText(args.mode.file);
    const req = parseHttpFile(raw);
    const r = validator.validateRequest(req);
    err = r.valid ? null : r.error;
  } else if (args.mode.kind === "bodyForPath") {
    const rawBody = await io.readText(args.mode.body);
    const body = tryJson(rawBody) as JsonValue | undefined;
    const r = validator.validateRequest({
      method: args.mode.method,
      path: args.mode.path,
      contentType: "application/json",
      body,
    });
    err = r.valid ? null : r.error;
  } else if (args.mode.kind === "responseForPath") {
    const rawBody = await io.readText(args.mode.body);
    const body = tryJson(rawBody) as JsonValue | undefined;
    const r = validator.validateResponse(
      { method: args.mode.method, path: args.mode.path },
      { status: args.mode.status, contentType: "application/json", body },
    );
    err = r.valid ? null : r.error;
  } else {
    io.stderr("validate: no action specified\n");
    return { exitCode: 3 };
  }

  // Silence on success; no bare-newline leak, matches Unix convention.
  if (err === null) return { exitCode: 0 };
  const rendered = formatError(err, args.options.format ?? "text", args.options.depth);
  await primarySink(io, args.options)(rendered + "\n");
  return { exitCode: 1 };
}

function tryJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

/**
 * Mode for the `validate` subcommand.
 *
 * @public
 */
export type ValidateMode =
  | { kind: "request"; file: string }
  | { kind: "bodyForPath"; method: string; path: string; body: string }
  | { kind: "responseForPath"; method: string; path: string; status: number; body: string };

/**
 * Implement the `oaverify compile-schema <schema>` subcommand. Reads a JSON
 * Schema from disk (or stdin via `-`), emits an ES module whose
 * `validate(data)` mirrors `compileSchema(schema).validate(data)`, then
 * bundles it via esbuild into a single file with zero imports.
 *
 * The output runs without `@oaverify/core` installed at all: the
 * Lambda / edge / single-file deployment case. `esbuild` is a required
 * peer dependency for this subcommand; a clear install hint prints on
 * stderr with exit code 3 if it's not resolvable.
 *
 * @public
 */
export async function compileSchemaCommand(
  args: {
    schema: string;
    output?: string;
    dialect?: StandaloneDialect;
    /**
     * Override the `@oaverify/core` prefix used in the intermediate
     * pre-bundle module's imports. Tests use workspace aliases for
     * that same published name. Not exposed on the CLI.
     */
    importPrefix?: string;
    /**
     * Override esbuild's resolveDir. Defaults to `process.cwd()`,
     * which is where a real consumer's installed `@oaverify/core`
     * sits. Not exposed on the CLI.
     */
    resolveDir?: string;
    /**
     * Test-only: esbuild `alias` entries for the emitted module's
     * imports. The emitted source imports `@oaverify/core` subpaths by
     * their real published names, which resolve through that package's
     * `exports` map to `dist/`. Tests run against source with no build,
     * so they alias those specifiers to the workspace sources instead.
     * Not exposed on the CLI.
     */
    bundleAlias?: Record<string, string>;
  },
  io: CommandIo = defaultCommandIo(),
): Promise<CommandResult> {
  const raw = await io.readText(args.schema);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    io.stderr(`compile-schema: ${args.schema} is not valid JSON (${(err as Error).message})\n`);
    return { exitCode: 3 };
  }
  let source: string;
  try {
    source = emitStandalone(parsed as SchemaOrBoolean, {
      dialect: args.dialect ?? "2020-12",
      importPrefix: args.importPrefix,
    });
  } catch (err) {
    io.stderr(`compile-schema: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }
  try {
    source = await bundleEmitted(source, args.resolveDir ?? process.cwd(), args.bundleAlias);
  } catch (err) {
    io.stderr(`compile-schema: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }
  if (args.output !== undefined) {
    await io.writeText(args.output, source);
    return { exitCode: 0 };
  }
  io.stdout(source);
  return { exitCode: 0 };
}

/**
 * Bundle an emitted validator source with esbuild so it has no external
 * imports. Lazy-imports esbuild so programmatic-API consumers who never
 * invoke the CLI don't pay the dependency cost. Throws with an
 * install-hint message when esbuild isn't resolvable.
 */
async function bundleEmitted(
  source: string,
  resolveDir: string,
  alias?: Record<string, string>,
): Promise<string> {
  let esbuild: typeof Esbuild;
  try {
    esbuild = await import("esbuild");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "compile-schema / compile-spec require 'esbuild' as a peer dependency.\n" +
          "  Install it alongside oaverify, e.g.:\n" +
          "    npm install esbuild\n" +
          "    pnpm add esbuild",
        { cause: err },
      );
    }
    throw err;
  }
  const result = await esbuild.build({
    stdin: { contents: source, resolveDir, loader: "js" },
    ...(alias === undefined ? {} : { alias }),
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const out = result.outputFiles[0];
  if (out === undefined) throw new Error("esbuild produced no output");
  return out.text;
}

/**
 * Implement the `oaverify compile-spec <spec>` subcommand. Loads an OpenAPI
 * document (with optional overlays), compiles every operation's
 * schemas, and emits a standalone ES module exposing the full
 * `createValidator`-equivalent surface: `validateRequest`,
 * `validateResponse`, `validateFetchRequest`, `validateFetchResponse`,
 * `getOperation`, `detectedVersion`, `warnings`, with zero imports
 * after bundling.
 *
 * @public
 */
export async function compileSpecCommand(
  args: {
    spec: string;
    overlays: string[];
    output?: string;
    dialect?: StandaloneDialect;
    requestsOnly?: boolean;
    /** `{ method, path }` include-list; empty = all ops. */
    only?: Array<{ method: string; path: string }>;
    /** Result shape of the emitted validators. Default `"flat"`. */
    outputMode?: "flat" | "tree" | "predicate";
    /** Leaf-error cap baked into the emitted validators. Default `1`. */
    maxErrors?: number;
    /** Test-only: override the emitted module's import prefix. */
    importPrefix?: string;
    /** Test-only: override esbuild's resolveDir for in-workspace bundle. */
    resolveDir?: string;
    /** Test-only: esbuild `alias` entries so emitted imports resolve to source. */
    bundleAlias?: Record<string, string>;
  },
  io: CommandIo = defaultCommandIo(),
): Promise<CommandResult> {
  let overlayDocs: SpecOverlay[];
  try {
    overlayDocs = await readOverlays(io, args.overlays);
  } catch (err) {
    io.stderr(`compile-spec: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }
  let document: OpenAPIDocument;
  try {
    const loaded = await loadSpec({
      reader: io.reader,
      entry: args.spec,
      overlays: overlayDocs,
    });
    document = loaded.document;
  } catch (err) {
    io.stderr(`compile-spec: ${(err as Error).message}\n`);
    return { exitCode: 2 };
  }

  let source: string;
  try {
    source = emitSpec(document, {
      dialect: args.dialect,
      requestsOnly: args.requestsOnly === true,
      only: args.only,
      outputMode: args.outputMode,
      maxErrors: args.maxErrors,
      importPrefix: args.importPrefix,
    });
  } catch (err) {
    io.stderr(`compile-spec: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }
  try {
    source = await bundleEmitted(source, args.resolveDir ?? process.cwd(), args.bundleAlias);
  } catch (err) {
    io.stderr(`compile-spec: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }
  if (args.output !== undefined) {
    await io.writeText(args.output, source);
    return { exitCode: 0 };
  }
  io.stdout(source);
  return { exitCode: 0 };
}

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
  createStdinReader,
  isSpecOverlay,
  loadSpec,
  specOverlayVerbs,
  STDIN_URI,
  type DocumentReader,
  type ResolvedSpec,
  type SpecOverlay,
} from "@oaverify/internal-spec";
import { createValidator } from "@oaverify/internal-validator";
import {
  isOverlayDocument,
  translateOverlay,
  type OverlayDocument,
} from "@oaverify/internal-overlay-spec";
import type * as Esbuild from "esbuild";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { analyzeSpec } from "@oaverify/stream";
import { emitStandalone, type StandaloneDialect } from "./emit-standalone.js";
import { emitSpec } from "./emit-spec.js";
import { parseHttpFile } from "./http-parser.js";
import { hasUnbounded, renderStreamBudget } from "./stream-check.js";
import {
  applySkip,
  CHECK_SEVERITIES,
  checkSpec,
  EMPTY_SEVERITY_MAP,
  FindingTermError,
  FULL_SELECTION,
  parseFindingTerms,
  parseSeverityMap,
  renderSarif,
  resolveFindingSelection,
  SeverityMapError,
  CheckAbortedError,
  type CheckFinding,
  type CheckSeverity,
  type FindingSelection,
  type SeverityMap,
} from "@oaverify/check";

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
    reader: composeReaders([createStdinReader(), createFileReader(), createHttpReader()]),
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
 *   for the operation that holds it, so the run exits 4 whatever the
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
    /**
     * Exit non-zero when any finding at or above this severity appears.
     * `"warning"` is the floor and keeps its historical meaning of "any
     * finding at all"; `"error"` is the new capability, gating on
     * specification violations while ignoring the rest.
     */
    failOn?: CheckSeverity;
    /**
     * `--severity` entries, unparsed. Each is a comma-separated list of
     * `<key>=<level>`; see `parseSeverityMap` for the grammar and for
     * why `malformed` is refused.
     */
    severity?: readonly string[];
    /**
     * `--findings`, unparsed: one comma-separated list of terms, each a
     * key in `--severity`'s key space, optionally prefixed `-` to
     * exclude.
     *
     * One flag over the two questions `--only` and `--skip` ask
     * separately, with the two stages split by sign rather than by flag
     * name: a term without `-` decides what runs, a term with `-` drops
     * findings the passes produced. See `parseFindingTerms` for the
     * grammar and `resolveFindingSelection` for the rule.
     *
     * Refused alongside `--only` or `--skip`. They are competing
     * spellings of one selection, and a run given both would have to
     * pick an order to apply them in, which is the ambiguity one flag
     * exists to remove.
     */
    findings?: string;
    /** `"text"` (default), `"json"`, or `"sarif"`. */
    format?: "text" | "json" | "sarif";
    /**
     * Tool version to record in SARIF output. The CLI passes its own
     * package version; unset it becomes `"0.0.0"`, which is what a
     * library caller that does not care gets.
     */
    version?: string;
    /**
     * Directory that SARIF paths are made relative to, normally the
     * working directory. A parameter so a test does not depend on where
     * it was invoked from.
     */
    cwd?: string;
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
  // One selection. Which passes run, which findings survive, and what
  // the report says all read this one object.
  let selection: FindingSelection;
  if (args.findings === undefined) {
    selection = FULL_SELECTION;
  } else {
    try {
      selection = resolveFindingSelection(parseFindingTerms(args.findings));
    } catch (err) {
      if (!(err instanceof FindingTermError)) throw err;
      io.stderr(`check: --findings ${err.message}\n`);
      return { exitCode: 3 };
    }
  }
  const classes = selection.classes;

  // Parsed before anything is read: a typo in a CI flag should fail on
  // the flag rather than after grading a document.
  let severityMap: SeverityMap;
  try {
    severityMap =
      args.severity === undefined || args.severity.length === 0
        ? EMPTY_SEVERITY_MAP
        : parseSeverityMap(args.severity);
  } catch (err) {
    if (!(err instanceof SeverityMapError)) throw err;
    io.stderr(`check: --severity ${err.message}\n`);
    return { exitCode: 3 };
  }

  let overlayDocs: SpecOverlay[];
  try {
    overlayDocs = await readOverlays(io, args.overlays);
  } catch (err) {
    io.stderr(`check: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }

  let resolved: ResolvedSpec;
  try {
    // `provenance: true` unconditionally: every finding's `target.source`
    // depends on it, and `check` promises that field is absent only when
    // the node genuinely has no source. Loading is the CLI's job because
    // it is the asynchronous half; `checkSpec` takes what it produces.
    resolved = await loadSpec({
      reader: io.reader,
      entry: args.spec,
      overlays: overlayDocs,
      provenance: true,
    });
  } catch (err) {
    // The document could not be read, resolved, or parsed. Not a finding:
    // there is nothing to report findings about.
    io.stderr(`check: ${(err as Error).message}\n`);
    return { exitCode: 2 };
  }

  let findings: CheckFinding[];
  try {
    findings = checkSpec(resolved, { findings: selection, severity: severityMap });
  } catch (err) {
    // Only the abort. It means the same to a caller as a document that
    // would not read: nothing was graded, so there is no report. Any
    // other throw is a defect rather than a verdict, and is left to
    // propagate as it always has rather than being dressed up as one of
    // this command's exit codes.
    if (!(err instanceof CheckAbortedError)) throw err;
    io.stderr(`check: ${err.message}\n`);
    return { exitCode: 2 };
  }

  // A skipped finding is not produced: it leaves the array here, so it
  // gates on nothing below and counts toward nothing in the summary.
  // The report is what keeps that from being silent.
  // `--findings`' exclusions and `--skip`'s keys are the same operation
  // and go through the same function; only the flag that named them
  // differs, so only the report wording does.
  const skipResult = applySkip(findings, selection.excludeKeys);
  findings = skipResult.findings;
  const skipped = skipResult.skipped;
  // Echoed the way it was written, sign included, so a reader can match
  // the line back to the term without reconstructing it.
  const skipLine =
    skipped.length === 0
      ? ""
      : `skipped: ${skipResult.dropped} finding(s) (${skipped
          .map((e) => `-${e.key} x${e.count}`)
          .join(", ")})\n`;

  // A term that changes nothing is reported rather than refused, because
  // `-a,-b` is what a script produces when it unions two exclusion
  // lists, and refusing that would make exclusion lists uncomposable. It
  // changes no exit code; a CI configuration that has drifted is worth
  // saying out loud and is not worth failing a build over on its own.
  const noopTerms = selection.terms.filter((t) => t.noop !== undefined);
  const noopLine =
    noopTerms.length === 0
      ? ""
      : `no-op terms: ${noopTerms.map((t) => `${t.term} (${t.noop ?? ""})`).join(", ")}\n`;

  const sink = primarySink(io, args.options);
  if (args.format === "sarif") {
    await sink(
      renderSarif(findings, {
        version: args.version ?? "0.0.0",
        base: args.cwd ?? process.cwd(),
        classes: [...classes],
        skipped,
        ...(noopTerms.length === 0 ? {} : { noopTerms }),
      }),
    );
  } else if (args.format === "json") {
    await sink(
      JSON.stringify(
        {
          findings,
          ...(skipped.length === 0 ? {} : { skipped }),
          ...(noopTerms.length === 0 ? {} : { noopTerms }),
        },
        null,
        2,
      ) + "\n",
    );
  } else if (findings.length === 0) {
    await sink(`check: no findings (${[...classes].sort().join(", ")})\n`);
    if (skipLine !== "") await sink(skipLine);
    if (noopLine !== "") await sink(noopLine);
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
    // After the total, because it qualifies it: the count above is what
    // survived, and this is what did not.
    if (skipLine !== "") await sink(skipLine);
    if (noopLine !== "") await sink(noopLine);
  }

  // A malformed schema outranks the gate: the document cannot be
  // compiled, whatever the findings say. Distinct from the exit 2 above,
  // which means the document could not be read and nothing was printed;
  // here the report is complete and one of its findings is fatal.
  if (findings.some((f) => f.class === "malformed")) return { exitCode: 4 };
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
  // `-` is one stream, so it can be the spec or the payload and not
  // both. Caught here rather than left to produce a confusing parse
  // failure on whichever consumer lost the race.
  const payloadFromStdin =
    args.mode.kind === "request"
      ? args.mode.file
      : args.mode.kind === "bodyForPath" || args.mode.kind === "responseForPath"
        ? args.mode.body
        : undefined;
  if (args.spec === STDIN_URI && payloadFromStdin === STDIN_URI) {
    io.stderr(
      "validate: stdin was given as both the spec and the payload; " +
        "only one of them can read it. Pass a file for one.\n",
    );
    return { exitCode: 3 };
  }

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

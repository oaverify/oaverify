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
import {
  collectUnknownFormats,
  emitStandalone,
  type StandaloneDialect,
} from "./emit-standalone.js";
import { emitSpec } from "./emit-spec.js";
import { parseHttpFile } from "./http-parser.js";
import {
  confineRootFor,
  confinedEntry,
  entryRefusal,
  policyFor,
  fileOptionsFor,
  httpOptionsFor,
  policyHttpReader,
  type ReaderFlags,
  type ReaderPolicy,
  type RemoteRefsMode,
} from "./reader-policy.js";
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
  ruleFor,
  SeverityMapError,
  CheckAbortedError,
  type CheckFinding,
  type CheckRule,
  type SkipReportEntry,
  type TermReport,
  type CheckSeverity,
  type FindingSelection,
  type SeverityMap,
} from "@oaverify/check";
import { spanLookupFor } from "./check-spans.js";

/**
 * Render one finding as the lines the text report prints for it,
 * trailing blank line included.
 *
 * Three parts, each on its own line, because they answer three different
 * questions and a reader is usually asking one of them: how bad and what
 * kind (the header), where to look (`at`), and what is wrong (the
 * message). Run together on one line, as this was, the header was the
 * only part with a fixed position and the other two ran past the
 * terminal width into a wrap the reader had to re-parse per finding.
 *
 * Severity leads, because it is what decides whether you act now. Class
 * follows, because it says which pass to look at. Both are padded to a
 * column so that the codes line up down the report and a scan for one
 * severity is a scan down a fixed offset.
 *
 * Message before location, at the shallower indent, because "what is
 * wrong" is what a reader wants from a report they are skimming and
 * "where" is what they want only once one finding has their attention.
 * The location then hangs deeper, like a stack frame under an exception.
 * The two indents are what separates them. At a common indent the blocks
 * ran together, which mattered here because several messages open by
 * restating the schema path that the location ends on, so the eye had no
 * cue for where one stopped.
 *
 * Extracted so the aborted-check path prints findings the same way a
 * graded report does rather than growing a second, drifting format.
 */
function formatFinding(f: CheckFinding, width: number): string[] {
  const also = f.occurrences === undefined ? "" : `  (+${f.occurrences - 1} more operation(s))`;
  const out = [`${f.severity.padEnd(7)}  ${f.class.padEnd(11)}  ${f.code}${also}\n`];
  for (const line of wrapText(f.message, width, "  ", "  ")) out.push(`${line}\n`);
  for (const line of wrapText(f.location, width, "    at ", "       ")) out.push(`${line}\n`);
  // Blank line between findings: the report is scanned for the one that
  // matters, and blocks separate where indentation alone does not once a
  // message itself wraps to several lines.
  out.push("\n");
  return out;
}

/**
 * The rule notes that close a text report: one entry per explained rule
 * the run produced, whatever the number of findings under it.
 *
 * The counterpart to short finding messages: the advice is kept, and
 * charged once. `format-not-validated` carries ~349 characters of
 * explanation, printed here a single time however many findings cite it,
 * while each of those findings stays a line long. A run with 332
 * `example-invalid` findings pays for the text once, not 332 times.
 *
 * Only rules with an explanation appear. Most have none, because their
 * message already says everything: `unused-component` naming the
 * component nothing reaches needs no footnote, and printing its title
 * again under a heading would be words without facts.
 *
 * Last in the report rather than first, because it is reference matter.
 * A reader skimming for what broke reads upward from the total; a
 * reader who has found their finding and wants to know what the rule
 * means reads down to here.
 */
function formatRuleNotes(findings: readonly CheckFinding[], width: number): string[] {
  const seen = new Set<string>();
  const notes: { code: string; rule: CheckRule }[] = [];
  for (const f of findings) {
    if (seen.has(f.code)) continue;
    seen.add(f.code);
    const rule = ruleFor(f.code);
    if (rule?.explanation !== undefined) notes.push({ code: f.code, rule });
  }
  if (notes.length === 0) return [];

  const out = [`\n${notes.length} rule(s) in this report explained:\n`];
  for (const { code, rule } of notes) {
    out.push("\n");
    // Code then title on one line, matching the finding header's
    // ordering so the eye lands on the code in the same place.
    // Colon rather than aligned columns: a title is a phrase, and the
    // wrap that a long code plus a long title provokes would break an
    // alignment anyway.
    for (const line of wrapText(`${code}: ${rule.title}`, width, "  ", "    ")) {
      out.push(`${line}\n`);
    }
    for (const line of wrapText(rule.explanation ?? "", width, "    ", "    "))
      out.push(`${line}\n`);
  }
  return out;
}

/**
 * What `check --format json` emits.
 *
 * The canonical statement of that report's shape, per AGENTS.md "Type
 * as canonical contract". Three renderers carry the same facts, and
 * parity between them is easy to lose one field at a time: an addition
 * lands in SARIF and in the text report, and this one is the report
 * nobody is looking at while making it.
 *
 * So the rule for anyone adding to a report: **a fact a consumer can
 * read from SARIF or from the text report belongs here too.**
 * `check-json-contract.test.ts` is what makes leaving one out a failing
 * test rather than a silent gap, by comparing `findings` against what
 * `checkSpec` returned rather than against a list of field names.
 *
 * `findings` is always present, empty included, so a consumer can index
 * it without a guard. The other three are absent when they have nothing
 * to say, so a clean run is `{"findings": []}` rather than a shape
 * padded with empty containers a reader has to tell from absence.
 */
interface CheckJsonReport {
  /** Every finding the run produced, after regrading and skipping. */
  findings: readonly CheckFinding[];
  /**
   * The rule behind each code present, keyed by code. The same metadata
   * SARIF puts in `shortDescription` / `fullDescription` and the text
   * report prints as its closing notes. Absent when no code in the
   * report has an entry.
   */
  rules?: Record<string, CheckRule>;
  /** What `--findings` exclusions dropped, when they dropped anything. */
  skipped?: readonly SkipReportEntry[];
  /** Terms that selected nothing, when there were any. */
  noopTerms?: readonly TermReport[];
}

/**
 * Input shared by all CLI commands.
 *
 * @public
 */
export interface CommandOptions {
  /**
   * How `validate` renders an error tree. Only that command reads it;
   * `resolve`, `check` and `stream-check` produce their own output and
   * leave it unset.
   *
   * Named for the question it answers rather than for the flag that
   * sets it, because `check` takes a `format` of its own, at the top
   * level of its arguments, selecting an envelope shape rather than an
   * error renderer. While both were called `format`, one sat inside the
   * other's argument object: setting `options.format` on a `check` call
   * type-checked wherever the two unions overlapped and did nothing at
   * all, which is how a test came to claim three formats and exercise
   * one (#867).
   */
  errorFormat?: OutputFormat;
  depth?: number;
  output?: string;
  quiet: boolean;
  /**
   * `--remote-refs`. Absent when the flag was not passed, which is what
   * lets `--untrusted` imply a posture without overriding an explicit
   * one. See {@link policyFor}.
   */
  remoteRefs?: RemoteRefsMode;
  /** `--untrusted`. */
  untrusted?: boolean;
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
  /**
   * Build the reader for one invocation.
   *
   * A factory rather than an instance because the posture depends on
   * the entry: `--remote-refs same-origin` admits the origin the entry
   * was served from, which is not known until the command has parsed
   * its argument. See {@link ReaderPolicy}.
   */
  reader(policy: ReaderPolicy): DocumentReader;
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
    //
    // That wrapper's `createSmartHttpReader` claims every http(s) URI
    // and sits in front of this one, so in the shipped binary the
    // reader built here never serves a remote read. Both compositions
    // have to apply the posture, or the flag holds in tests and not in
    // the CLI.
    reader: (policy) =>
      composeReaders([
        createStdinReader(),
        createFileReader(confineRootFor(policy), fileOptionsFor(policy)),
        policyHttpReader(createHttpReader(httpOptionsFor(policy)), policy),
      ]),
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
async function readOverlay(reader: DocumentReader, path: string): Promise<SpecOverlay> {
  const doc = await reader.read(path);
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

/**
 * Resolve the reader posture for one invocation, or the usage error
 * that says the posture and the entry disagree.
 *
 * Every spec-taking command opens with this, so the refusal is reported
 * before anything is read, the same way everywhere.
 */
function openReader(
  io: CommandIo,
  command: string,
  entry: string,
  flags: ReaderFlags & { quiet?: boolean },
): { reader: DocumentReader; entry: string } | { refusal: CommandResult } {
  const policy = policyFor(entry, flags);
  const refusal = entryRefusal(policy);
  if (refusal !== undefined) {
    io.stderr(`${command}: ${refusal}\n`);
    // 3, the documented usage code: the flags and the argument
    // contradict each other, which is a mistake in the invocation
    // rather than anything about the document.
    return { refusal: { exitCode: 3 } };
  }
  return { reader: io.reader(policy), entry: confinedEntry(policy) };
}

function readOverlays(reader: DocumentReader, paths: string[]): Promise<SpecOverlay[]> {
  return Promise.all(paths.map((path) => readOverlay(reader, path)));
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
 * duplicating it. Build the whole report first and hand it over in one
 * call; a sink is not a stream.
 *
 * That invariant is checked rather than trusted. It was stated here and
 * quietly broken by the `check` text branch, which wrote a line at a
 * time: to stdout that looks identical, and to a file each write
 * truncated the last, so `-o` produced a one-line report of what should
 * have been a full one (#848). Silent output loss through a documented
 * flag is worth a loud failure, and any second call is a bug in this
 * file rather than anything a user did.
 *
 * Exported for its own test. No command constructs a sink from outside
 * this module, and the guard is the one piece of it that no command can
 * exercise: a second call is by definition a path that should not
 * exist, so nothing short of calling it directly pins the behaviour.
 *
 * @internal
 */
export function primarySink(
  io: CommandIo,
  opts: { output?: string; quiet: boolean },
): (content: string) => Promise<void> | void {
  const once = <T>(write: (content: string) => T): ((content: string) => T) => {
    let written = false;
    return (content) => {
      if (written) {
        throw new Error(
          "internal: a command wrote through its primary sink more than once. " +
            "Build the whole report and write it in one call; with --output " +
            "each write truncates the last.",
        );
      }
      written = true;
      return write(content);
    };
  };

  if (opts.output !== undefined) {
    const path = opts.output;
    return once((content) => io.writeText(path, content));
  }
  if (opts.quiet) return once(() => {});
  // Called through `io` rather than passed unbound, so a `CommandIo`
  // whose `stdout` is written as a method shorthand keeps its receiver.
  return once((content) => io.stdout(content));
}

/**
 * Implement the `oaverify resolve <spec>` subcommand.
 *
 * @param args - Entry spec path, overlay files, and base CLI options.
 * @returns Exit code 0 on success, 3 on usage errors (an `--overlay`
 *   file of unrecognised shape, or a reader posture that refuses the
 *   entry).
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
  const opened = openReader(io, "resolve", args.spec, args.options);
  if ("refusal" in opened) return opened.refusal;
  const { reader, entry } = opened;
  let overlayDocs: SpecOverlay[];
  try {
    overlayDocs = await readOverlays(reader, args.overlays);
  } catch (err) {
    io.stderr(`resolve: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }
  const { document } = await loadSpec({
    reader,
    entry,
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
 * Findings carry a `class` (which pass found it, and what `--findings`
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
 * - **examples**: documented examples that do not validate against the
 *   schema they illustrate.
 * - **redos**: `pattern` regexes with a proven ambiguity, which a
 *   backtracking engine can be made to match in superlinear time.
 *
 * @returns 0 clean (or every finding sits below the gate), 1 findings met
 *          the `--fail-on` gate (default `error`, so a specification
 *          violation fails with no flag; `--fail-on none` restores the
 *          advisory exit 0), 2 the document could not be read or graded
 *          (a load failure prints nothing; an aborted check prints the
 *          findings produced before the abort to stderr, and the report
 *          sink stays empty), 3 usage error, 4 the
 *          document was graded and at least one schema is malformed.
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
    /**
     * Exit non-zero when any finding at or above this severity appears.
     * Defaults to `"error"` (#549): a document that violates the
     * OpenAPI specification fails the run with no flag, because in CI
     * the exit code is the only signal anyone sees. `"none"` restores
     * the advisory behavior (report everything, exit 0); `"warning"`
     * is the floor and keeps its historical meaning of "any finding at
     * all". Note the default makes `--severity` gate-affecting: a map
     * that promotes a code to `error` moves the exit code unless
     * `--fail-on` pins otherwise.
     */
    failOn?: CheckSeverity | "none";
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
     * One flag over the two questions inclusion and exclusion ask
     * separately, with the two stages split by sign rather than by flag
     * name: a term without `-` decides what runs, a term with `-` drops
     * findings the passes produced. See `parseFindingTerms` for the
     * grammar and `resolveFindingSelection` for the rule.
     *
     * One flag rather than two because a run given both would have to
     * pick an order to apply them in, which is the ambiguity this
     * spelling exists to remove.
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

  const opened = openReader(io, "check", args.spec, args.options);
  if ("refusal" in opened) return opened.refusal;
  const { reader, entry } = opened;
  let overlayDocs: SpecOverlay[];
  try {
    overlayDocs = await readOverlays(reader, args.overlays);
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
      reader,
      entry,
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
    // Findings the passes that ran before the abort had already produced.
    // The exit code stays 2: the document still could not be graded, and
    // this report is partial by construction. They go to stderr with the
    // abort rather than to the report sink, so a `--format json` consumer
    // never sees a partial body where a complete one belongs.
    // Through the same exclusion the returned path uses, so a code
    // suppressed in CI stays suppressed on an abort. `checkSpec` has
    // already narrowed and graded these; this is the CLI-side half.
    const partial = applySkip([...err.findings], selection.excludeKeys).findings;
    if (partial.length > 0) {
      io.stderr(`check: ${partial.length} finding(s) produced before the check was aborted:\n`);
      const width = args.width ?? DEFAULT_REPORT_WIDTH;
      for (const f of partial) {
        for (const line of formatFinding(f, width)) io.stderr(line);
      }
    }
    return { exitCode: 2 };
  }

  // A skipped finding is not produced: it leaves the array here, so it
  // gates on nothing below and counts toward nothing in the summary.
  // The report is what keeps that from being silent.
  // `--findings`' exclusions go through the same function the library's
  // `applySkip` exposes; only the wording of the report differs.
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
    const base = args.cwd ?? process.cwd();
    // Positions for the locations this log is about to emit. Only for
    // SARIF: it is the one format with a place to put a line, and a
    // format that has no use for one should not pay to compute it.
    // See `check-spans.ts` for which text sources can answer.
    const spanOf = await spanLookupFor(findings, (path) => io.readText(path), base);
    await sink(
      renderSarif(findings, {
        version: args.version ?? "0.0.0",
        base,
        classes: [...classes],
        skipped,
        spanOf,
        ...(noopTerms.length === 0 ? {} : { noopTerms }),
      }),
    );
  } else if (args.format === "json") {
    // The rules this report's codes belong to, keyed by code, so a
    // consumer reading the JSON has the same rule text SARIF gets in
    // `fullDescription` and the text report prints as its notes (#773).
    // A caller in-process can import CHECK_RULES; one piping this
    // through jq cannot, and without this it is the only consumer the
    // message shortening leaves worse off.
    //
    // Every code in the report, not only the explained ones, because
    // `title` is useful on its own here: a JSON consumer rendering a
    // list has nowhere else to get a human name for a code.
    const rules = Object.fromEntries(
      [...new Set(findings.map((f) => f.code))].flatMap((code) => {
        const rule = ruleFor(code);
        return rule === undefined ? [] : [[code, rule] as const];
      }),
    );
    const report: CheckJsonReport = {
      findings,
      ...(Object.keys(rules).length === 0 ? {} : { rules }),
      ...(skipped.length === 0 ? {} : { skipped }),
      ...(noopTerms.length === 0 ? {} : { noopTerms }),
    };
    await sink(JSON.stringify(report, null, 2) + "\n");
  } else if (findings.length === 0) {
    const report = [`check: no findings (${[...classes].sort().join(", ")})\n`];
    if (skipLine !== "") report.push(skipLine);
    if (noopLine !== "") report.push(noopLine);
    await sink(report.join(""));
  } else {
    const width = args.width ?? DEFAULT_REPORT_WIDTH;
    // Built whole and written once. A text report is many lines and the
    // sink is a single write: `--output` truncates per call, so writing
    // line by line left the file holding only the last one (#848).
    const report: string[] = [];
    for (const f of findings) {
      report.push(...formatFinding(f, width));
    }
    // A bare total does not say whether to act. The breakdown does, and
    // it is the whole reason severity exists as a field.
    const bySeverity = CHECK_SEVERITIES.filter((sev) => findings.some((f) => f.severity === sev))
      .reverse()
      .map((sev) => `${findings.filter((f) => f.severity === sev).length} ${sev}`)
      .join(", ");
    // No leading blank line: each finding block already ends with one.
    report.push(`${findings.length} finding(s): ${bySeverity}\n`);
    // After the total, because it qualifies it: the count above is what
    // survived, and this is what did not.
    if (skipLine !== "") report.push(skipLine);
    if (noopLine !== "") report.push(noopLine);
    report.push(...formatRuleNotes(findings, width));
    await sink(report.join(""));
  }

  // A malformed schema outranks the gate: the document cannot be
  // compiled, whatever the findings say. Distinct from the exit 2 above,
  // which means the document could not be read and nothing was printed;
  // here the report is complete and one of its findings is fatal.
  if (findings.some((f) => f.class === "malformed")) return { exitCode: 4 };
  const failOn = args.failOn ?? "error";
  if (failOn !== "none") {
    const threshold = CHECK_SEVERITIES.indexOf(failOn);
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
  const opened = openReader(io, "stream-check", args.spec, args.options);
  if ("refusal" in opened) return opened.refusal;
  const { reader, entry } = opened;
  let overlayDocs: SpecOverlay[];
  try {
    overlayDocs = await readOverlays(reader, args.overlays);
  } catch (err) {
    io.stderr(`stream-check: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }
  const { document } = await loadSpec({
    reader,
    entry,
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

  const opened = openReader(io, "validate", args.spec, args.options);
  if ("refusal" in opened) return opened.refusal;
  const { reader, entry } = opened;
  let overlayDocs: SpecOverlay[];
  try {
    overlayDocs = await readOverlays(reader, args.overlays);
  } catch (err) {
    io.stderr(`validate: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }
  const { document } = await loadSpec({
    reader,
    entry,
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
    // parseHttpFile throws on a malformed file (bad request line,
    // declared-JSON body that does not parse). That is a usage
    // problem with the input file, so it exits 3 like the other
    // pre-validation failures rather than escaping the action.
    let req: ReturnType<typeof parseHttpFile>;
    try {
      req = parseHttpFile(raw);
    } catch (parseErr) {
      io.stderr(`validate: ${args.mode.file}: ${(parseErr as Error).message}\n`);
      return { exitCode: 3 };
    }
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
  const rendered = formatError(err, args.options.errorFormat ?? "text", args.options.depth);
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
    /** Policy for formats outside the built-in set. Default `"error"`. */
    unknownFormats?: "ignore" | "error";
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
  // An OpenAPI document is a legal-but-meaningless input here: every
  // top-level key is an unknown keyword to JSON Schema, so the emitted
  // validate() would accept everything, silently. Refuse with a pointer
  // instead (the same class of early error as the JSON reader's
  // .yaml install hint).
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const marker = ["openapi", "swagger"].find((k) => k in (parsed as Record<string, unknown>));
    if (marker !== undefined) {
      io.stderr(
        `compile-schema: ${args.schema} looks like an OpenAPI document (it has ` +
          `an "${marker}" field), not a JSON Schema. Compiled as a schema it would ` +
          `accept every value. Use compile-spec for an HTTP validator, or pass the ` +
          `schema object itself.\n`,
      );
      return { exitCode: 2 };
    }
  }
  const unknownFormatsMode = args.unknownFormats ?? "error";
  if (unknownFormatsMode === "ignore") {
    for (const name of collectUnknownFormats(parsed as SchemaOrBoolean)) {
      io.stderr(
        `compile-schema: warning: format "${name}" is not in the built-in set; the emitted validator does not assert it\n`,
      );
    }
  }
  let source: string;
  try {
    source = emitStandalone(parsed as SchemaOrBoolean, {
      dialect: args.dialect ?? "2020-12",
      importPrefix: args.importPrefix,
      unknownFormats: unknownFormatsMode,
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
  // Through the shared sink rather than an inline `-o`-else-stdout
  // dispatch, so "how a command emits its primary output" has one
  // implementation and one enforced invariant. `--quiet` is not a flag
  // either command declares, so it is pinned false rather than plumbed.
  await primarySink(io, { output: args.output, quiet: false })(source);
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
  return stripBundlerPathComments(out.text);
}

/**
 * Drop esbuild's per-module path comments from the emitted bundle.
 *
 * esbuild labels each bundled module with a `// <path>` line. For a
 * module bundled out of this CLI's own build those read
 * `// dist/chunk-2YDUB5Q2.js`: build-internal names that mean nothing to
 * the reader of a standalone validator, and whose hashes change on every
 * rebuild, so a user who commits the generated file gets a diff for
 * work they did not do.
 *
 * The label is the module path **relative to esbuild's working
 * directory**, so it is not a fixed string. Running from this repo it is
 * `dist/chunk-….js`, because `@oaverify/core` resolves by package
 * self-reference. Running from a user's project, which is the case the
 * paragraph above is about, it is
 * `node_modules/@oaverify/core/dist/chunk-….js`, or under pnpm the
 * longer `node_modules/.pnpm/@oaverify+core@…/node_modules/…` form.
 * Anchoring on `dist/chunk-` alone matched only the first, so the fix
 * fired exactly where it was least needed.
 *
 * Matching `dist/chunk-<HASH>.js` under any prefix covers all three. A
 * comment a user wrote that happens to read `// dist/chunk-ABC123.js` is
 * also removed; there is nothing in the output that distinguishes it,
 * and the cost of being wrong there is a lost comment rather than a
 * broken module.
 */
const BUNDLER_CHUNK_COMMENT = /^\/\/ (?:\S*\/)?dist\/chunk-[A-Z0-9]+\.js\n/gm;

/**
 * Strip esbuild's per-module path comments from a bundle.
 *
 * @internal Exported for the unit test: the compile-spec suite bundles
 * from `packages/*\/src` with no prior build, so its module labels never
 * take the `dist/chunk-` shape this removes.
 */
export function stripBundlerPathComments(text: string): string {
  return text.replace(BUNDLER_CHUNK_COMMENT, "");
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
    /**
     * Emit the `returnValues` channel on the request side. Default
     * `false`. See `EmitSpecOptions.returnValues` for the presence
     * rule and the byte-identity guarantee when off.
     */
    returnValues?: boolean;
    /**
     * Security mode baked into the emitted module. Default `"off"`.
     * See `EmitSpecOptions.validateSecurity`.
     */
    validateSecurity?: "off" | "shape" | "strict";
    /** Fetch-helper body byte cap baked in. Default 1 MiB. */
    maxTotalBytes?: number;
    /** Policy for formats outside the built-in set. Default `"error"`. */
    unknownFormats?: "ignore" | "error";
    /** Test-only: override the emitted module's import prefix. */
    importPrefix?: string;
    /** Test-only: override esbuild's resolveDir for in-workspace bundle. */
    resolveDir?: string;
    /** Test-only: esbuild `alias` entries so emitted imports resolve to source. */
    bundleAlias?: Record<string, string>;
    /** `--remote-refs`; see {@link CommandOptions.remoteRefs}. */
    remoteRefs?: RemoteRefsMode;
    /** `--untrusted`. */
    untrusted?: boolean;
  },
  io: CommandIo = defaultCommandIo(),
): Promise<CommandResult> {
  const opened = openReader(io, "compile-spec", args.spec, args);
  if ("refusal" in opened) return opened.refusal;
  const { reader, entry } = opened;
  let overlayDocs: SpecOverlay[];
  try {
    overlayDocs = await readOverlays(reader, args.overlays);
  } catch (err) {
    io.stderr(`compile-spec: ${(err as Error).message}\n`);
    return { exitCode: 3 };
  }
  let document: OpenAPIDocument;
  try {
    const loaded = await loadSpec({
      reader,
      entry,
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
      returnValues: args.returnValues,
      validateSecurity: args.validateSecurity,
      maxTotalBytes: args.maxTotalBytes,
      importPrefix: args.importPrefix,
      unknownFormats: args.unknownFormats,
      onUnknownFormats: (names) => {
        for (const name of names) {
          io.stderr(
            `compile-spec: warning: format "${name}" is not in the built-in set; the emitted validator does not assert it\n`,
          );
        }
      },
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
  // Through the shared sink rather than an inline `-o`-else-stdout
  // dispatch, so "how a command emits its primary output" has one
  // implementation and one enforced invariant. `--quiet` is not a flag
  // either command declares, so it is pinned false rather than plumbed.
  await primarySink(io, { output: args.output, quiet: false })(source);
  return { exitCode: 0 };
}

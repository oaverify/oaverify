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
  specOverlayVerbs,
  type DocumentReader,
  type SpecHygieneIssue,
  type SpecOverlay,
} from "@oaverify/internal-spec";
import {
  isOverlayDocument,
  translateOverlay,
  type OverlayDocument,
} from "@oaverify/internal-overlay-spec";
import { createValidator } from "@oaverify/internal-validator";
import type * as Esbuild from "esbuild";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { analyzeSpec } from "@oaverify/stream";
import { emitStandalone, type StandaloneDialect } from "./emit-standalone.js";
import { emitSpec } from "./emit-spec.js";
import { parseHttpFile } from "./http-parser.js";
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
 * {@link @oaverify/internal-overlay-spec!translateOverlay}) or a typed
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
  /** Which check produced this. */
  class: "hygiene" | "schema";
  /** The class-specific code, e.g. `"unused-component"`, `"unknown-keyword"`. */
  code: string;
  /**
   * Where it is. An RFC 6901 pointer for hygiene findings (they address
   * the resolved document) and a dotted schema path for schema-lint
   * findings (they address a position inside one schema). Kept as one
   * field because a consumer wants "where" more than it wants the
   * addressing scheme.
   */
  location: string;
  message: string;
}

/** Check classes `--only` accepts. */
export const CHECK_CLASSES = ["hygiene", "schema"] as const;
export type CheckClass = (typeof CHECK_CLASSES)[number];

/**
 * Implement the `oaverify check <spec> ...` subcommand: answer "what is
 * wrong with my spec?".
 *
 * The counterpart to `validate`, which answers "does this payload conform?".
 * Two verbs, one question each: `check` is about the document, `validate`
 * is about traffic.
 *
 * Three classes of problem exist (see docs/strictness.md); this command
 * surfaces the two that are reportable:
 *
 * - **Malformed** schemas are fatal and cannot be collected: the document
 *   cannot be compiled at all, so they surface as exit 2 with the compiler's
 *   located message rather than as findings.
 * - **hygiene**: unused components / tags / `$defs`, path-parameter
 *   mismatches.
 * - **schema**: partially-implemented keywords, unknown keywords.
 *
 * @returns 0 clean, 1 findings met `--fail-on`, 2 the document could not be
 *          loaded or compiled, 3 usage error.
 *
 * @public
 */
export async function checkCommand(
  args: {
    spec: string;
    overlays: string[];
    /** Classes to run. Defaults to all of {@link CHECK_CLASSES}. */
    only?: CheckClass[];
    /** Exit non-zero when any finding at or above <level> appears. */
    failOn?: "warning";
    /** `"text"` (default) or `"json"`. */
    format?: "text" | "json";
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
  try {
    const loaded = await loadSpec({
      reader: io.reader,
      entry: args.spec,
      overlays: overlayDocs,
      lint: classes.has("hygiene"),
    });
    document = loaded.document;
    specHygieneIssues = loaded.specHygieneIssues;
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
        code: issue.code,
        location: issue.pointer,
        message: issue.message,
      });
    }
  }

  if (classes.has("schema")) {
    try {
      const validator = createValidator(document, { schemaLint: "strict" });
      // Compilation is lazy, so without this the schema class inspects
      // nothing: no schema has been checked and schemaLintIssues is
      // empty. `check` is exactly the caller that wants the whole
      // document compiled.
      validator.precompile();
      for (const issue of validator.stats.schemaLintIssues) {
        // The path is relative to the schema that was compiled, which on
        // a spec with many operations does not say where to look. The
        // validator labels each compile with its operation, so prefer
        // that when it is present.
        const where = issue.path === "" ? "<root>" : issue.path;
        findings.push({
          class: "schema",
          code: issue.code,
          location: issue.context === undefined ? where : `${issue.context} -> ${where}`,
          message: issue.message,
        });
      }
    } catch (err) {
      // A malformed schema throws rather than linting. Exit 2, same as a
      // document that would not load: in both cases there is no validator
      // to grade.
      io.stderr(`check: ${(err as Error).message}\n`);
      return { exitCode: 2 };
    }
  }

  const sink = primarySink(io, args.options);
  if (args.format === "json") {
    await sink(JSON.stringify({ findings }, null, 2) + "\n");
  } else if (findings.length === 0) {
    await sink(`check: no findings (${[...classes].sort().join(", ")})\n`);
  } else {
    for (const f of findings) {
      await sink(`${f.class} [${f.code}] ${f.location}: ${f.message}\n`);
    }
    await sink(`\n${findings.length} finding(s)\n`);
  }

  if (args.failOn === "warning" && findings.length > 0) return { exitCode: 1 };
  return { exitCode: 0 };
}

/**
 * Implement the `oaverify stream-check <spec> ...` subcommand: roll up the
 * streaming-buffer budget for every operation's request / response bodies
 * and print a per-operation table (or the `SpecBudget` JSON payload). This
 * is the streamability analysis (`@oaverify/internal-stream-validator`) surfaced over a
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

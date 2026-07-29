import { Command } from "commander";
import { KNOWN_OUTPUT_FORMATS, isOutputFormat, type OutputFormat } from "@oaverify/internal-core";
import {
  CHECK_CLASSES,
  CHECK_SEVERITIES,
  checkCommand,
  compileSchemaCommand,
  compileSpecCommand,
  defaultCommandIo,
  resolveCommand,
  streamCheckCommand,
  validateCommand,
  type CheckClass,
  type CheckSeverity,
  type CommandIo,
  type ValidateMode,
} from "./commands.js";
import type { StandaloneDialect } from "./emit-standalone.js";

const STANDALONE_DIALECTS = ["2020-12", "openapi-3.1", "openapi-3.0"] as const;
function isStandaloneDialect(v: string): v is StandaloneDialect {
  return (STANDALONE_DIALECTS as readonly string[]).includes(v);
}

/**
 * Options accepted by {@link buildProgram}.
 *
 * @public
 */
export interface BuildProgramOptions {
  /**
   * I/O substrate. Defaults to the real filesystem + stdin +
   * process.stdout/stderr via {@link defaultCommandIo}. Tests can pass
   * an in-memory substitute that captures writes for assertion.
   */
  io?: CommandIo;
  /**
   * Exit handler. Defaults to `process.exit`. In-process tests should
   * pass a throwing implementation so the test harness observes the
   * exit code via the rejection and doesn't actually terminate.
   */
  exit?: (code: number) => void;
  /**
   * Version reported by `--version`. Supplied by the binary, which
   * reads it from its own `package.json`, rather than baked in here:
   * this package is bundled into the `oaverify` tarball and has no
   * version of its own that a user could meaningfully be told.
   *
   * Omitted, `--version` is not registered at all, which is better than
   * answering with something that could drift from the installed
   * package.
   */
  version?: string;
}

/**
 * Set the exit code and let the process end on its own.
 *
 * `process.exit` terminates immediately, discarding whatever is still
 * queued on stdout. When stdout is a pipe its writes are asynchronous,
 * so any report larger than the pipe buffer (64 KiB) arrived truncated
 * and the exit code stayed 0: `check --format json | jq` got
 * valid-looking JSON that stopped mid-token (#510). Redirecting to a
 * file was unaffected, because a file descriptor is written
 * synchronously, which is what made this look like a formatting bug
 * rather than a lost-output one.
 *
 * Node keeps the process alive while a pipe still has pending writes,
 * so returning instead of exiting flushes the report first. Every write
 * is covered, including the ones whose call sites do not await their
 * sink.
 *
 * @internal
 */
export function defaultExit(code: number): void {
  process.exitCode = code;
}

/**
 * Build the Commander program. Exported so tests can invoke the program
 * without spawning a child process; pass `{ io, exit }` to route all
 * side-effects through in-process collaborators. Commands write their
 * primary output through `io.stdout` (or the file sink when `-o` is
 * set) and their errors through `io.stderr`; this CLI layer only
 * handles argv-parsing usage errors + the final `exit` call.
 *
 * @public
 */
export function buildProgram(options: BuildProgramOptions = {}): Command {
  const io = options.io ?? defaultCommandIo();
  const exit = options.exit ?? defaultExit;

  const program = new Command();
  program
    .name("oaverify")
    .description("OpenAPI 3.1 HTTP request/response validator")
    .exitOverride();
  // A wrapper recording which engine produced a result reaches for this
  // first; without it they record the path to the binary instead (#518).
  if (options.version !== undefined) program.version(options.version);

  program
    .command("resolve <spec>")
    .description("Resolve a (possibly multi-file) OpenAPI document and print the stitched result.")
    .option(
      "--overlay <file...>",
      "apply one or more overlay files in order (OpenAPI Overlay 1.0 or typed SpecOverlay)",
      collectOverlays,
      [],
    )
    .option("-o, --output <file>", "write output to a file instead of stdout")
    .option("--quiet", "print nothing; exit code only", false)
    .action(async (spec: string, opts: { overlay: string[]; output?: string; quiet: boolean }) => {
      const res = await resolveCommand(
        {
          spec,
          overlays: opts.overlay,
          options: { output: opts.output, quiet: opts.quiet },
        },
        io,
      );
      exit(res.exitCode);
    });

  program
    .command("check <spec>")
    .description(
      "Report what is wrong with a spec: document conformance, hygiene, and schema findings.",
    )
    .option(
      "--overlay <file...>",
      "apply one or more overlay files in order (OpenAPI Overlay 1.0 or typed SpecOverlay)",
      collectOverlays,
      [],
    )
    .option(
      "--only <classes>",
      `comma-separated subset of: ${CHECK_CLASSES.join(", ")} (default: all)`,
      (value: string): CheckClass[] =>
        value.split(",").map((raw) => {
          const name = raw.trim();
          if (!(CHECK_CLASSES as readonly string[]).includes(name)) {
            throw new Error(`unknown check class: ${name} (expected ${CHECK_CLASSES.join(", ")})`);
          }
          return name as CheckClass;
        }),
    )
    .option(
      "--fail-on <level>",
      `non-zero exit when any finding at or above <level> appears: ${CHECK_SEVERITIES.join(", ")}`,
      (value: string): CheckSeverity => {
        if (!(CHECK_SEVERITIES as readonly string[]).includes(value)) {
          throw new Error(`unknown level: ${value} (expected ${CHECK_SEVERITIES.join(", ")})`);
        }
        return value as CheckSeverity;
      },
    )
    .option(
      "--format <shape>",
      "'text' (default; one finding per line) or 'json' ({ findings })",
      (value: string): "text" | "json" => {
        if (value !== "text" && value !== "json") {
          throw new Error(`unknown format: ${value} (expected "text" or "json")`);
        }
        return value;
      },
      "text",
    )
    .option("-o, --output <file>", "write output to a file instead of stdout")
    .option("--quiet", "print nothing; exit code only", false)
    .action(
      async (
        spec: string,
        opts: {
          overlay: string[];
          only?: CheckClass[];
          failOn?: CheckSeverity;
          format: "text" | "json";
          output?: string;
          quiet: boolean;
        },
      ) => {
        const res = await checkCommand(
          {
            spec,
            overlays: opts.overlay,
            only: opts.only,
            failOn: opts.failOn,
            format: opts.format,
            options: { output: opts.output, quiet: opts.quiet },
          },
          io,
        );
        exit(res.exitCode);
      },
    );

  program
    .command("validate <spec>")
    .description("Validate a request/response/body against an OpenAPI document.")
    .option(
      "--overlay <file...>",
      "apply one or more overlay files in order (OpenAPI Overlay 1.0 or typed SpecOverlay)",
      collectOverlays,
      [],
    )
    .option("--request <file>", "path to a .http file (use '-' for stdin)")
    .option("--path <method-path>", 'e.g. "POST /pets"')
    .option("--body <file>", "body file (use '-' for stdin)")
    .option("--response", "validate a response instead of a request", false)
    .option("--status <code>", "response status code (required when --response)")
    .option(
      "--format <format>",
      KNOWN_OUTPUT_FORMATS.join(" | "),
      (value: string): OutputFormat => {
        if (!isOutputFormat(value)) throw new Error(`unknown format: ${value}`);
        return value;
      },
      "text" as OutputFormat,
    )
    .option("--depth <n>", "truncate error tree depth", (v: string) => Number.parseInt(v, 10))
    .option("-o, --output <file>", "write output to a file instead of stdout")
    .option("--quiet", "print nothing; exit code only", false)
    .action(async (spec: string, opts) => {
      // deriveMode is the only pre-validation step that throws (usage
      // errors). Keep the try narrow so it doesn't also catch the
      // exit() call's in-process throw (tests inject a throwing exit
      // to observe the code without terminating the process).
      let mode: ValidateMode;
      try {
        mode = deriveMode(opts);
      } catch (err) {
        io.stderr(`error: ${(err as Error).message}\n`);
        exit(3);
        return;
      }
      const res = await validateCommand(
        {
          spec,
          overlays: opts.overlay ?? [],
          mode,
          options: {
            format: opts.format as OutputFormat,
            depth: opts.depth,
            output: opts.output,
            quiet: opts.quiet,
          },
        },
        io,
      );
      exit(res.exitCode);
    });

  program
    .command("stream-check <spec>")
    .description(
      "Report the streaming-buffer budget per operation (which request/response bodies stream vs buffer, and where).",
    )
    .option(
      "--overlay <file...>",
      "apply one or more overlay files in order (OpenAPI Overlay 1.0 or typed SpecOverlay)",
      collectOverlays,
      [],
    )
    .option(
      "--format <shape>",
      "'text' (default; per-operation table) or 'json' (the SpecBudget payload)",
      (value: string): "text" | "json" => {
        if (value !== "text" && value !== "json") {
          throw new Error(`unknown format: ${value} (expected "text" or "json")`);
        }
        return value;
      },
      "text",
    )
    .option(
      "--max-buffered-bytes <n>",
      "buffer cap to compute the effective peak against",
      (v: string) => Number.parseInt(v, 10),
    )
    .option("--fail-on-unbounded", "exit non-zero if any body has an unbounded peak buffer", false)
    .option("--verbose", "list each unbounded buffering position with its path", false)
    .option("-o, --output <file>", "write output to a file instead of stdout")
    .option("--quiet", "print nothing; exit code only", false)
    .action(
      async (
        spec: string,
        opts: {
          overlay: string[];
          format: "text" | "json";
          maxBufferedBytes?: number;
          failOnUnbounded: boolean;
          verbose: boolean;
          output?: string;
          quiet: boolean;
        },
      ) => {
        const res = await streamCheckCommand(
          {
            spec,
            overlays: opts.overlay ?? [],
            format: opts.format,
            ...(opts.maxBufferedBytes !== undefined && {
              maxBufferedBytes: opts.maxBufferedBytes,
            }),
            failOnUnbounded: opts.failOnUnbounded,
            verbose: opts.verbose,
            options: { format: "text", output: opts.output, quiet: opts.quiet },
          },
          io,
        );
        exit(res.exitCode);
      },
    );

  program
    .command("compile-schema <schema>")
    .description("AOT-compile a JSON Schema to a standalone ES module (zero imports).")
    .option(
      "--dialect <dialect>",
      STANDALONE_DIALECTS.join(" | "),
      (value: string): StandaloneDialect => {
        if (!isStandaloneDialect(value)) throw new Error(`unknown dialect: ${value}`);
        return value;
      },
      "2020-12" as StandaloneDialect,
    )
    .option("-o, --output <file>", "write output to a file instead of stdout")
    .action(async (schema: string, opts: { dialect: StandaloneDialect; output?: string }) => {
      const res = await compileSchemaCommand(
        {
          schema,
          output: opts.output,
          dialect: opts.dialect,
        },
        io,
      );
      exit(res.exitCode);
    });

  program
    .command("compile-spec <spec>")
    .description(
      "AOT-compile an OpenAPI document to a standalone HTTP validator module (zero imports).",
    )
    .option(
      "--overlay <file...>",
      "apply one or more overlay files in order (OpenAPI Overlay 1.0 or typed SpecOverlay)",
      collectOverlays,
      [],
    )
    .option(
      "--dialect <dialect>",
      STANDALONE_DIALECTS.join(" | "),
      (value: string): StandaloneDialect => {
        if (!isStandaloneDialect(value)) throw new Error(`unknown dialect: ${value}`);
        return value;
      },
    )
    .option("--requests-only", "skip response-validator emit (smaller output)", false)
    .option(
      "--only <method-path...>",
      'restrict emit to specified operations, e.g. --only "POST /pets" "GET /pets/{id}"',
      collectOnly,
      [],
    )
    .option(
      "--output-mode <mode>",
      "result shape of the emitted validators: flat | tree | predicate (default: flat)",
      parseOutputMode,
    )
    .option(
      "--max-errors <n>",
      'leaf-error cap baked into the validators: a positive integer or "all" (default: 1)',
      parseMaxErrors,
    )
    .option("-o, --output <file>", "write output to a file instead of stdout")
    .action(
      async (
        spec: string,
        opts: {
          overlay: string[];
          dialect?: StandaloneDialect;
          requestsOnly?: boolean;
          only: Array<{ method: string; path: string }>;
          outputMode?: "flat" | "tree" | "predicate";
          maxErrors?: number;
          output?: string;
        },
      ) => {
        const res = await compileSpecCommand(
          {
            spec,
            overlays: opts.overlay ?? [],
            output: opts.output,
            dialect: opts.dialect,
            requestsOnly: opts.requestsOnly === true,
            only: opts.only,
            outputMode: opts.outputMode,
            maxErrors: opts.maxErrors,
          },
          io,
        );
        exit(res.exitCode);
      },
    );

  return program;
}

function collectOnly(
  value: string,
  previous: Array<{ method: string; path: string }>,
): Array<{ method: string; path: string }> {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new Error(`--only expects "METHOD PATH" (space-delimited), got ${JSON.stringify(value)}`);
  }
  return [...previous, { method: parts[0]!.toUpperCase(), path: parts[1]! }];
}

function collectOverlays(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseOutputMode(value: string): "flat" | "tree" | "predicate" {
  if (value !== "flat" && value !== "tree" && value !== "predicate") {
    throw new Error(`--output-mode must be flat | tree | predicate, got ${JSON.stringify(value)}`);
  }
  return value;
}

function parseMaxErrors(value: string): number {
  if (value === "all" || value === "infinity") return Number.POSITIVE_INFINITY;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `--max-errors must be a positive integer or "all", got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

function deriveMode(opts: {
  request?: string;
  path?: string;
  body?: string;
  response?: boolean;
  status?: string;
}): ValidateMode {
  if (opts.request !== undefined) {
    return { kind: "request", file: opts.request };
  }
  if (opts.path !== undefined && opts.body !== undefined) {
    const parts = opts.path.trim().split(/\s+/);
    const method = (parts[0] ?? "GET").toUpperCase();
    const path = parts[1] ?? "/";
    if (opts.response) {
      const status = opts.status !== undefined ? Number.parseInt(opts.status, 10) : Number.NaN;
      if (!Number.isFinite(status)) throw new Error("--response requires --status");
      return { kind: "responseForPath", method, path, status, body: opts.body };
    }
    return { kind: "bodyForPath", method, path, body: opts.body };
  }
  throw new Error(
    "validate: provide either --request <file> or --path <method-path> --body <file>",
  );
}

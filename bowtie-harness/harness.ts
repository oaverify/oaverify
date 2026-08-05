/**
 * Bowtie harness for oaverify's JSON Schema engine.
 *
 * Speaks version 1 of the Bowtie harness protocol (start / dialect / run /
 * stop) over stdin/stdout, one JSON object per line. See
 * https://docs.bowtie.report/en/stable/implementers/
 *
 * The compile/validate path mirrors conformance/run-json-schema-suite.ts:
 * `compileSchema` with `jsonSchemaDialect` and `builtInFormats`, with the
 * test case's registry fed in through the `external` map the same way that
 * runner feeds the suite's `remotes/` directory.
 *
 * Only JSON Schema 2020-12 is advertised. The engine ships three dialects
 * (`jsonSchemaDialect`, `openapi31Dialect`, `oas30Dialect`) and the other
 * two are OpenAPI flavours, not JSON Schema drafts, so 2020-12 is the whole
 * of its JSON Schema support. Advertising more would manufacture failures.
 */

import readline from "node:readline/promises";
import os from "node:os";
import process from "node:process";

import { compileSchema, jsonSchemaDialect } from "@oaverify/internal-schema";
import { builtInFormats } from "@oaverify/internal-formats";

declare const __OAVERIFY_VERSION__: string;

const DIALECT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

interface BowtieTest {
  description: string;
  instance: unknown;
  valid?: boolean | null;
}

interface BowtieCase {
  description: string;
  schema: unknown;
  registry?: Record<string, unknown> | null;
  tests: BowtieTest[];
}

/** The union of every field Bowtie sends; which are present depends on `cmd`. */
interface BowtieRequest {
  cmd: string;
  version?: number;
  dialect?: string;
  seq?: number;
  case?: BowtieCase;
}

type TestResult =
  | { valid: boolean }
  | { errored: true; context: { message: string; traceback?: string } }
  | { skipped: true; message: string };

function errored(err: unknown): TestResult {
  const e = err as Error;
  return {
    errored: true,
    context: { message: e?.message ?? String(err), traceback: e?.stack },
  };
}

let started = false;
let dialect: string | undefined;

/** One JSON object per line on stdout is the whole response transport. */
function send(response: unknown): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const commands: Record<string, (request: BowtieRequest) => unknown> = {
  start(request) {
    if (request.version !== 1) {
      throw new Error(`Unsupported Bowtie protocol version: ${request.version}`);
    }
    started = true;
    return {
      version: 1,
      implementation: {
        language: "javascript",
        name: "oaverify",
        version: __OAVERIFY_VERSION__,
        homepage: "https://github.com/roarmouse/oaverify",
        issues: "https://github.com/roarmouse/oaverify/issues",
        source: "https://github.com/roarmouse/oaverify",
        dialects: [DIALECT_2020_12],
        os: os.platform(),
        os_version: os.release(),
        language_version: process.version,
      },
    };
  },

  dialect(request) {
    if (!started) throw new Error("Not started!");
    // The engine has a single JSON Schema dialect and no per-run default to
    // configure, so this only records what Bowtie selected.
    dialect = request.dialect;
    return { ok: dialect === DIALECT_2020_12 };
  },

  run(request) {
    if (!started) throw new Error("Not started!");
    const testCase = request.case!;

    let validate: ((data: unknown) => { valid: boolean }) | undefined;
    try {
      const external = new Map<string, never>(
        Object.entries(testCase.registry ?? {}) as Array<[string, never]>,
      );
      validate = compileSchema(testCase.schema as never, {
        dialect: jsonSchemaDialect,
        formats: builtInFormats,
        external,
      }).validate;
    } catch (err) {
      // A schema this engine cannot compile is one errored result per test,
      // never a dead process: a single bad schema must not end the run.
      return { seq: request.seq, results: testCase.tests.map(() => errored(err)) };
    }

    const results = testCase.tests.map((test): TestResult => {
      try {
        return { valid: validate!(test.instance).valid };
      } catch (err) {
        return errored(err);
      }
    });
    return { seq: request.seq, results };
  },

  stop() {
    if (!started) throw new Error("Not started!");
    process.exit(0);
  },
};

async function main(): Promise<void> {
  const stdio = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  for await (const line of stdio) {
    if (line.trim() === "") continue;
    let request: BowtieRequest;
    try {
      request = JSON.parse(line) as BowtieRequest;
    } catch (err) {
      send(errored(err));
      continue;
    }
    const command = commands[request.cmd];
    if (command === undefined) {
      send(errored(new Error(`Unknown command: ${request.cmd}`)));
      continue;
    }
    try {
      send(command(request));
    } catch (err) {
      send(errored(err));
    }
  }
}

await main();

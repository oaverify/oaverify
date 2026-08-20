/**
 * The verdict rules for `run-openapi-cases.ts`, separated from its I/O
 * so `run-openapi-selftest.ts` can exercise them directly.
 *
 * This is where #804 lived: the runner mapped exit 1 to "invalid"
 * unconditionally, so a CLI that died before it could answer was
 * reported as a validation verdict. Every branch below only fires when
 * something has already gone wrong, which is exactly when nobody is
 * reading closely, so the rules are pinned rather than eyeballed.
 */

import { statSync } from "node:fs";
import type { SpawnSyncReturns } from "node:child_process";

export interface Case {
  name: string;
  kind: "request" | "response";
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  contentType?: string;
  status?: number;
  body?: unknown;
  expect: "valid" | "invalid";
  expectCodes?: string[];
}

export interface CaseOutcome {
  name: string;
  expect: string;
  expectCodes?: string[];
  actual: "valid" | "invalid" | "error";
  actualCodes: string[];
  pass: boolean;
  note?: string;
}

export function collect(node: unknown, out: string[]): void {
  if (node === null || typeof node !== "object") return;
  const n = node as { code?: string; children?: unknown[] };
  if (typeof n.code === "string") out.push(n.code);
  if (Array.isArray(n.children)) for (const c of n.children) collect(c, out);
}

/**
 * The one line of a failed process's stderr worth reporting.
 *
 * Node prefaces an uncaught throw with four lines: source location, the
 * offending source line, a caret, then the message. Only the caret marks
 * where that ends, and a throw of a non-Error has no "...Error:" line at
 * all, so pattern-matching the other three is guesswork. Skip past the
 * caret instead, and fall back to the first line that survives when
 * there is no caret (an OOM abort prints none).
 */
export function selectStderrLine(stderr: string): string {
  const raw = stderr.split("\n").map((l) => l.trim());
  const caret = raw.findIndex((l) => /^\^+$/.test(l));
  const lines = (caret === -1 ? raw : raw.slice(caret + 1))
    .filter(Boolean)
    .filter((l) => !/^(node:|file:|at )/.test(l));
  return lines.find((l) => /^([A-Za-z]*Error\b|FATAL ERROR\b)/.test(l)) ?? lines[0] ?? "";
}

/** Cap by code point, so the slice cannot end inside a surrogate pair. */
function capped(s: string, max: number): string {
  return [...s].slice(0, max).join("");
}

export function makeOutcome(c: Case, result: SpawnSyncReturns<string>): CaseOutcome {
  const { status: exitCode, signal, error: spawnError } = result;
  // Both are undefined when the spawn itself fails.
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const actualCodes: string[] = [];
  let parsed = false;
  if (stdout.trim().startsWith("{")) {
    try {
      collect(JSON.parse(stdout), actualCodes);
      parsed = true;
    } catch {
      // leave empty
    }
  }
  // A CLI that dies before it can answer also exits 1, with nothing on
  // stdout, so the exit code alone cannot tell a verdict from a corpse:
  // module resolution fails before the CLI's own handler runs, which is
  // what a concurrent `pnpm build` produces. Requiring the JSON is what
  // separates them. The exit-0 side cannot be separated this way at all,
  // since the CLI is silent on success; the runner's probes cover it.
  let actual: "valid" | "invalid" | "error" = "error";
  if (exitCode === 0) actual = "valid";
  else if (exitCode === 1 && parsed) actual = "invalid";

  let note: string | undefined;
  if (actual === "error") {
    // `signal` first: `spawnSync` also sets `error` when it kills the
    // child for exceeding `maxBuffer`, and "failed to spawn" would send
    // the reader looking at the wrong thing for a process that ran.
    const how =
      signal !== null
        ? `was killed by ${signal}`
        : spawnError !== undefined
          ? "failed to spawn"
          : `exited ${exitCode}`;
    // A killed process may leave nothing on stderr (SIGKILL does), and a
    // spawn failure leaves only `error`.
    const detail = spawnError?.message ?? selectStderrLine(stderr);
    note = `CLI ${how} without a parseable JSON verdict${detail ? `: ${capped(detail, 160)}` : ""}`;
  }

  const pass =
    actual === c.expect &&
    (c.expectCodes === undefined || c.expectCodes.every((code) => actualCodes.includes(code)));
  return {
    name: c.name,
    expect: c.expect,
    expectCodes: c.expectCodes,
    actual,
    actualCodes,
    pass,
    note,
  };
}

/**
 * Identity of the CLI binary, for detecting a rewrite mid-run.
 *
 * A build that unlinks before writing leaves no file to stat, which is a
 * changed binary like any other. Reporting it as a value rather than
 * throwing keeps that on the runner's exit 2 ("results are meaningless")
 * instead of its exit 1 ("cases failed").
 */
export function stampCli(file: string): string {
  try {
    const st = statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "absent";
  }
}

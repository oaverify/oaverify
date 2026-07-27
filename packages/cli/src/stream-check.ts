/**
 * Human-readable rendering for `oaverify stream-check`: a per-operation
 * streamability table over a {@link SpecBudget}, surfacing where each
 * request / response body buffers and the unbounded positions that drive
 * the cost. The machine-readable form is the `SpecBudget` JSON itself
 * (`--envelope json`).
 *
 * @packageDocumentation
 */

import type { OpenAPIDocument } from "@oaverify/internal-core";
import type { BodyBudget, ByteSize, SpecBudget, StreamabilityReport } from "@oaverify/stream";

/** Format a wire-byte size as a short human string. */
export function formatBytes(size: ByteSize): string {
  if (size === "unbounded") return "UNBOUNDED";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// "request" / a response status, padded so the body lines align.
function roleLabel(body: BodyBudget): string {
  return body.role === "request" ? "request" : (body.status ?? "response");
}

function classLabel(report: StreamabilityReport): string {
  return report.classification;
}

// A body line carrying its class + peak + buffering-island counts. Under
// `verbose`, each unbounded island is also listed with its path and the
// keyword that would bound it (the actionable punch list); bounded islands
// stay a count, since they need no action.
function renderBody(body: BodyBudget, pad: number, verbose: boolean): string[] {
  const role = roleLabel(body).padEnd(pad);
  const media = body.mediaType.padEnd(24);
  if (body.report === undefined) {
    return [`  ${role} ${media} not-streamable: ${body.error}`];
  }
  const report = body.report;
  const buffers = report.positions.filter((p) => p.classification === "buffer");
  const unbounded = buffers.filter((p) => p.maxBytes === "unbounded");
  const bounded = buffers.length - unbounded.length;
  const counts = buffers.length > 0 ? `  (${unbounded.length} unbounded, ${bounded} bounded)` : "";
  // Surface the configured cap when it actually binds (effective < intrinsic,
  // or a finite cap over an unbounded peak); equal means no cap is set or the
  // cap does not bind.
  const capped =
    report.effectivePeakBytes === report.peakBytes
      ? ""
      : `  (capped to ${formatBytes(report.effectivePeakBytes)})`;
  const head = `  ${role} ${media} ${classLabel(report).padEnd(11)} peak ${formatBytes(report.peakBytes)}${capped}${counts}`;
  if (!verbose) return [head];

  const lines = [head];
  for (const p of unbounded) {
    const at = p.path === "" ? "(root)" : p.path;
    lines.push(`         - ${at}  ${p.keyword}  unbounded (needs ${p.unboundedBy})`);
  }
  return lines;
}

interface Counts {
  bodies: number;
  streamable: number;
  tee: number;
  buffer: number;
  unbounded: number;
  errors: number;
}

function tally(budget: SpecBudget): Counts {
  const c: Counts = { bodies: 0, streamable: 0, tee: 0, buffer: 0, unbounded: 0, errors: 0 };
  for (const op of budget.operations) {
    for (const body of op.bodies) {
      c.bodies++;
      if (body.report === undefined) {
        c.errors++;
        continue;
      }
      const r = body.report;
      if (r.classification === "streamable") c.streamable++;
      else if (r.classification === "tee") c.tee++;
      else c.buffer++;
      if (r.peakBytes === "unbounded") c.unbounded++;
    }
  }
  return c;
}

/** True when any body in the budget has an unbounded peak (the `--fail-on-unbounded` trigger). */
export function hasUnbounded(budget: SpecBudget): boolean {
  return budget.operations.some((op) => op.bodies.some((b) => b.report?.peakBytes === "unbounded"));
}

/**
 * Render a {@link SpecBudget} as a per-operation text table. With
 * `verbose`, each unbounded buffering position is listed under its body
 * (path + the keyword that would bound it); otherwise bodies show only
 * island counts.
 *
 * @public
 */
export function renderStreamBudget(
  doc: OpenAPIDocument,
  budget: SpecBudget,
  options: { verbose?: boolean } = {},
): string {
  const verbose = options.verbose ?? false;
  const title = doc.info?.title ?? "(untitled)";
  const lines: string[] = [`${title}  (openapi ${doc.openapi})`, ""];

  // Pad the role column to the widest label so bodies align.
  const pad = Math.max(
    7,
    ...budget.operations.flatMap((op) => op.bodies.map((b) => roleLabel(b).length)),
  );

  for (const op of budget.operations) {
    lines.push(`${op.method} ${JSON.stringify(op.path)}`);
    for (const body of op.bodies) lines.push(...renderBody(body, pad, verbose));
  }

  const c = tally(budget);
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  lines.push(
    "",
    `summary: ${plural(c.bodies, "body", "bodies")} in ` +
      `${plural(budget.operations.length, "operation", "operations")}. ` +
      `${c.streamable} streamable, ${c.tee} tee, ${c.buffer} buffer ` +
      `(${c.unbounded} unbounded)` +
      (c.errors > 0 ? `, ${c.errors} not-streamable` : ""),
  );
  return lines.join("\n") + "\n";
}

/**
 * The gate's verdict: take every case's observed differences, ask the
 * registry which of them an entry accounts for, and report what is
 * left.
 *
 * Separated from the test file so the rules that decide whether a
 * difference can hide here are testable on synthetic input. An
 * instrument whose own accounting is untested is the thing brief 3d.1
 * warns about: the registry is the most attractive place in this
 * repository to bury a parity defect.
 */

import type { DivergenceEntry } from "./divergences.js";
import { differences, signatureOf, type CaseResult, type Channel } from "./run.js";

export const CHANNELS: Channel[] = ["verdict", "leaves", "value", "operation", "error"];

export interface ChannelTally {
  differing: number;
  signed: number;
  unexplained: number;
}

export interface GateResult {
  cases: number;
  perChannel: Record<Channel, ChannelTally>;
  /** Cases no entry claimed, plus cases an entry claimed with the wrong signature. */
  unexplained: CaseResult[];
  /** Cases an entry claimed whose signature it does not list. */
  signatureMismatches: Array<{ case: CaseResult; entry: string; signature: string }>;
  /** How many cases each entry claimed, by entry name. */
  matched: Map<string, number>;
  /** Entries that claimed nothing: a fixed defect leaving an exemption behind. */
  stale: string[];
  /**
   * Listed signatures no case produced, as `entry/signature`.
   *
   * Entry-level staleness is not enough once an entry lists more than
   * one signature: fix the query and header halves of a four-location
   * defect and the entry still matches, while two dead signatures stay
   * in the registry ready to absorb the next difference that happens to
   * look like them. With multiple signatures, the signature is the
   * exemption, so the signature is what has to still be earning its
   * place.
   */
  staleSignatures: string[];
}

function emptyChannels(): Record<Channel, ChannelTally> {
  return {
    verdict: { differing: 0, signed: 0, unexplained: 0 },
    leaves: { differing: 0, signed: 0, unexplained: 0 },
    value: { differing: 0, signed: 0, unexplained: 0 },
    operation: { differing: 0, signed: 0, unexplained: 0 },
    error: { differing: 0, signed: 0, unexplained: 0 },
  };
}

export function evaluate(cases: CaseResult[], entries: DivergenceEntry[]): GateResult {
  const out: GateResult = {
    cases: cases.length,
    perChannel: emptyChannels(),
    unexplained: [],
    signatureMismatches: [],
    matched: new Map(),
    stale: [],
    staleSignatures: [],
  };
  const observed = new Map<string, Set<string>>();

  for (const c of cases) {
    const diffs = differences(c);
    if (diffs.length === 0) continue;
    const entry = entries.find((e) => e.match(c.axes, c.wireId));
    const signature = signatureOf(c);
    if (entry === undefined) {
      for (const ch of diffs) {
        out.perChannel[ch].differing += 1;
        out.perChannel[ch].unexplained += 1;
      }
      out.unexplained.push(c);
      continue;
    }
    out.matched.set(entry.name, (out.matched.get(entry.name) ?? 0) + 1);
    let seen = observed.get(entry.name);
    if (seen === undefined) {
      seen = new Set<string>();
      observed.set(entry.name, seen);
    }
    seen.add(signature);
    // Claiming a case is not enough. The entry has to have said what
    // the difference would be, or a second defect in the same shape
    // rides in under the first one's name.
    const known = entry.signatures.includes(signature);
    for (const ch of diffs) {
      out.perChannel[ch].differing += 1;
      if (known) out.perChannel[ch].signed += 1;
      else out.perChannel[ch].unexplained += 1;
    }
    if (!known) {
      out.signatureMismatches.push({ case: c, entry: entry.name, signature });
      out.unexplained.push(c);
    }
  }

  out.stale = entries.filter((e) => (out.matched.get(e.name) ?? 0) === 0).map((e) => e.name);
  for (const e of entries) {
    const seen = observed.get(e.name) ?? new Set<string>();
    for (const signature of e.signatures) {
      if (!seen.has(signature)) out.staleSignatures.push(`${e.name}/${signature}`);
    }
  }
  return out;
}

/**
 * The report.
 *
 * A channel the run could not compare prints `not compared` rather than
 * `0`. The two are one word apart in a tally and mean opposite things,
 * which is the lesson `scripts/grid/README.md` records as `silent off`
 * against `silent 0`.
 */
export function render(
  r: GateResult,
  entries: DivergenceEntry[],
  declarationCount: number,
  elapsedMs: number,
  comparedChannels: Channel[] = CHANNELS,
): string {
  const lines = [
    `grid: ${r.cases} cases from ${declarationCount} declarations in ${Math.round(elapsedMs)}ms`,
  ];
  for (const s of r.staleSignatures) {
    lines.push(`  stale signature, no case produced it: ${s}`);
  }
  for (const ch of CHANNELS) {
    if (!comparedChannels.includes(ch)) {
      lines.push(`  ${ch.padEnd(9)} not compared`);
      continue;
    }
    const c = r.perChannel[ch];
    lines.push(
      `  ${ch.padEnd(9)} ${String(c.differing).padStart(5)} differing, ` +
        `${String(c.signed).padStart(5)} signed by an entry, ` +
        `${String(c.unexplained).padStart(5)} unexplained`,
    );
  }

  const bySignature = new Map<string, { n: number; sample: CaseResult }>();
  for (const c of r.unexplained) {
    const sig = signatureOf(c);
    const hit = bySignature.get(sig);
    if (hit === undefined) bySignature.set(sig, { n: 1, sample: c });
    else hit.n += 1;
  }
  if (bySignature.size > 0) {
    lines.push(`  ${bySignature.size} unexplained signature(s):`);
    for (const [sig, { n, sample }] of [...bySignature.entries()].sort((a, b) => b[1].n - a[1].n)) {
      lines.push(`    x${n}  ${sample.id} :: ${sample.wireId}`);
      lines.push(`          ${sig}`);
    }
  }
  for (const { case: c, entry, signature } of r.signatureMismatches) {
    lines.push(`  entry ${entry} claims ${c.id} :: ${c.wireId} but does not list its signature:`);
    lines.push(`          ${signature}`);
  }
  for (const entry of entries) {
    const n = r.matched.get(entry.name) ?? 0;
    lines.push(`  entry ${entry.name} (${entry.kind}, ${entry.issue}): ${n} case(s)`);
  }
  return lines.join("\n");
}

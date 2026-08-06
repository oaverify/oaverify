/**
 * Throwaway instrumentation for the #624 spike. Not shipped.
 *
 * Enabled by `OAV_SPIKE_STATS=1`. Counts compile units, generated
 * source bytes, emitted functions, and how many distinct schema objects
 * those functions were emitted for, so cross-unit duplication (H1) can
 * be measured rather than argued.
 */

export const SPIKE_ENABLED = process.env.OAV_SPIKE_STATS === "1";

interface SpikeStats {
  units: number;
  sourceBytes: number;
  functions: number;
  distinctSchemas: Set<object>;
  perUnitBytes: number[];
}

const stats: SpikeStats = {
  units: 0,
  sourceBytes: 0,
  functions: 0,
  distinctSchemas: new Set<object>(),
  perUnitBytes: [],
};

let registered = false;

function register(): void {
  if (registered) return;
  registered = true;
  process.on("exit", () => {
    const sorted = [...stats.perUnitBytes].sort((a, b) => b - a);
    const total = stats.sourceBytes;
    const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;
    process.stderr.write(
      [
        "",
        "--- spike #624 compile stats ---",
        `compile units:            ${stats.units}`,
        `generated source total:   ${mb(total)}`,
        `largest unit:             ${mb(sorted[0] ?? 0)}`,
        `median unit:              ${mb(sorted[Math.floor(sorted.length / 2)] ?? 0)}`,
        `functions emitted:        ${stats.functions}`,
        `distinct schema objects:  ${stats.distinctSchemas.size}`,
        `duplication factor:       ${(stats.functions / Math.max(1, stats.distinctSchemas.size)).toFixed(1)}x`,
        "",
      ].join("\n"),
    );
  });
}

export function spikeRecordUnit(sourceLength: number, functionCount: number): void {
  if (!SPIKE_ENABLED) return;
  register();
  stats.units += 1;
  stats.sourceBytes += sourceLength;
  stats.functions += functionCount;
  stats.perUnitBytes.push(sourceLength);
}

export function spikeRecordSchema(schema: unknown): void {
  if (!SPIKE_ENABLED) return;
  if (typeof schema === "object" && schema !== null) stats.distinctSchemas.add(schema);
}

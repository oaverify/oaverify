import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { loadSpec } from "../../../dist/spec.js";
import { checkSpec } from "../../../packages/check/dist/index.js";

const manifest = JSON.parse(await readFile(new URL("manifest.json", import.meta.url), "utf8"));
const directory = new URL("../specs/industry31/", import.meta.url);
const resources = new Map(manifest.resources.map((resource) => [resource.url, resource]));
const results = new URL("results/", directory);
await mkdir(results, { recursive: true });
const entries = [];

for (const entry of manifest.entries) {
  const reads = new Set();
  const reader = {
    canRead: () => true,
    async read(uri) {
      const resource = resources.get(uri);
      if (!resource) throw new Error(`Unpinned resource: ${uri}`);
      const bytes = await readFile(new URL(`blobs/${resource.sha256}`, directory));
      if (createHash("sha256").update(bytes).digest("hex") !== resource.sha256)
        throw new Error(`Cached bytes changed: ${uri}`);
      reads.add(uri);
      return parse(bytes.toString("utf8"));
    },
  };
  const resolved = await loadSpec({ entry: entry.entry, reader, provenance: true });
  if (resolved.document.openapi !== entry.openapi)
    throw new Error(`Unexpected OpenAPI version: ${entry.id}`);
  const findings = checkSpec(resolved);
  await writeFile(new URL(`${entry.id}.json`, results), `${JSON.stringify(findings, null, 2)}\n`);
  const counts = {};
  for (const finding of findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1;
  entries.push({
    id: entry.id,
    paths: Object.keys(resolved.document.paths ?? {}).length,
    webhooks: Object.keys(resolved.document.webhooks ?? {}).length,
    findings: counts,
    resources: reads.size,
  });
}
// Findings are research output. Read/hash/load/check failures still fail the run.
console.log(JSON.stringify({ entries }, null, 2));

// Upstream bytes are pinned, so a difference against the recorded snapshot is
// ours. Reported and never fatal: findings move whenever the checker improves.
function differences(before, after) {
  const lines = [];
  const recorded = new Map(before.entries.map((entry) => [entry.id, entry]));
  for (const entry of after.entries) {
    const was = recorded.get(entry.id);
    recorded.delete(entry.id);
    if (was === undefined) {
      lines.push(`${entry.id}  not in the snapshot`);
      continue;
    }
    for (const field of ["paths", "webhooks", "resources"])
      if (was[field] !== entry[field])
        lines.push(`${entry.id}  ${field}  ${was[field]} -> ${entry[field]}`);
    const codes = [...new Set([...Object.keys(was.findings), ...Object.keys(entry.findings)])];
    for (const code of codes.sort()) {
      const from = was.findings[code] ?? 0;
      const to = entry.findings[code] ?? 0;
      if (from !== to) lines.push(`${entry.id}  ${code}  ${from} -> ${to}`);
    }
  }
  for (const id of recorded.keys()) lines.push(`${id}  in the snapshot, not in this run`);
  return lines;
}

if (process.argv.includes("--diff-snapshot")) {
  const snapshot = JSON.parse(await readFile(new URL("snapshot.json", import.meta.url), "utf8"));
  const lines = differences(snapshot, { entries });
  const against = `snapshot.json (${snapshot.measuredAgainst})`;
  console.log(
    lines.length === 0
      ? `No change against ${against}.`
      : [`Changes against ${against}:`, ...lines].join("\n"),
  );
}

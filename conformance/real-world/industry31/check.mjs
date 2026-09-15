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

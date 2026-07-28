/**
 * Picks the apis.guru sample and prints one `filename<TAB>url` line per
 * spec. Selection is deterministic (no randomness, no date input) so a
 * finding reported against this corpus can be reproduced by re-running
 * download.sh.
 *
 * Skew: every OpenAPI 3.1 entry apis.guru has, then a breadth sample of
 * 3.0 capped per provider. Taking the first N alphabetically would give
 * a corpus of Amazon and Azure and nothing else; the per-provider cap is
 * what buys variety of document shape.
 */
import { readFileSync } from "node:fs";

const PER_PROVIDER_30 = 2;
const MAX_30 = 260;

const list = JSON.parse(readFileSync(process.argv[2], "utf8"));

/** Preferred version entry for one API, or undefined when it is not 3.x. */
function preferred(api) {
  const key = api.preferred ?? Object.keys(api.versions).sort().pop();
  const entry = api.versions[key];
  if (entry === undefined) return undefined;
  if (!String(entry.openapiVer ?? "").startsWith("3.")) return undefined;
  return entry;
}

const picked31 = [];
const by30Provider = new Map();

for (const [name, api] of Object.entries(list).sort(([a], [b]) => (a < b ? -1 : 1))) {
  const entry = preferred(api);
  if (entry === undefined) continue;
  const url = entry.swaggerYamlUrl ?? entry.swaggerUrl;
  if (url === undefined) continue;
  const record = { name, url, ver: entry.openapiVer };
  if (entry.openapiVer.startsWith("3.1")) {
    picked31.push(record);
    continue;
  }
  const provider = name.split(":")[0];
  const bucket = by30Provider.get(provider) ?? [];
  if (bucket.length < PER_PROVIDER_30) {
    bucket.push(record);
    by30Provider.set(provider, bucket);
  }
}

// Round-robin across providers so the 3.0 cap trims breadth-last rather
// than truncating the alphabet.
const buckets = [...by30Provider.values()];
const picked30 = [];
for (let i = 0; picked30.length < MAX_30; i += 1) {
  const before = picked30.length;
  for (const bucket of buckets) {
    if (bucket[i] !== undefined && picked30.length < MAX_30) picked30.push(bucket[i]);
  }
  if (picked30.length === before) break;
}

for (const { name, url, ver } of [...picked31, ...picked30]) {
  const ext = url.endsWith(".json") ? "json" : "yaml";
  const file = `guru-${name.replace(/[^A-Za-z0-9.-]/g, "_")}-${ver}.${ext}`;
  process.stdout.write(`${file}\t${url}\n`);
}

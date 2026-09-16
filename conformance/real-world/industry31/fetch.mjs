import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("manifest.json", import.meta.url), "utf8"));
const directory = new URL("../specs/industry31/blobs/", import.meta.url);
await mkdir(directory, { recursive: true });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Verify existing bytes too: an interrupted or edited cache is not a pinned corpus.
for (const resource of manifest.resources) {
  const file = new URL(resource.sha256, directory);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (bytes === undefined) {
    const response = await fetch(resource.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${response.status}: ${resource.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== resource.sha256) throw new Error(`Source bytes changed: ${resource.url}`);
    await writeFile(file, bytes);
  }
  if (digest(bytes) !== resource.sha256) throw new Error(`Cached bytes changed: ${resource.url}`);
}
console.log(
  `Verified ${manifest.resources.length} resources for ${manifest.entries.length} API roots.`,
);

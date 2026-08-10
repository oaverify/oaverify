import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createYamlFileReader } from "../src/index.js";

// The YAML readers take the same `FileReaderOptions`, so they honour
// `maxBytes` too: an option one reader applies and another ignores
// would be worse than no option. Only the async reader is covered here
// because `createYamlFileReaderSync` is private and `loadSpecSync`
// builds it with no options, so there is no public way to set one.
function scratch(): { root: string; smallBytes: number } {
  const root = mkdtempSync(join(tmpdir(), "oav-yaml-maxbytes-"));
  const small = "ok: true\n";
  writeFileSync(join(root, "small.yaml"), small);
  writeFileSync(join(root, "big.yaml"), `pad: ${"x".repeat(4096)}\n`);
  return { root, smallBytes: Buffer.byteLength(small) };
}

describe("createYamlFileReader maxBytes", () => {
  it("refuses a file over the limit", async () => {
    const { root, smallBytes } = scratch();
    const reader = createYamlFileReader(root, { maxBytes: smallBytes });
    await expect(reader.read("big.yaml")).rejects.toThrow(/file exceeds maxBytes/);
  });

  it("reads a file under the limit", async () => {
    const { root, smallBytes } = scratch();
    const reader = createYamlFileReader(root, { maxBytes: smallBytes });
    await expect(reader.read("small.yaml")).resolves.toEqual({ ok: true });
  });

  it("reads any size when unset", async () => {
    const { root } = scratch();
    await expect(createYamlFileReader(root).read("big.yaml")).resolves.toBeTypeOf("object");
  });
});

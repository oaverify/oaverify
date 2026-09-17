import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadSpec } from "@oaverify/internal-spec";
import { createYamlFileReader, loadSpecSync } from "../src/index.js";

const base = mkdtempSync(join(tmpdir(), "oav-encoded-yaml-"));
const root = join(base, "root");
mkdirSync(root);
afterAll(() => rmSync(base, { recursive: true, force: true }));
const source = 'openapi: 3.1.0\ninfo: { title: Encoded, version: "1" }\npaths: {}\n';
const reader = createYamlFileReader(root, { confine: true });

describe("YAML file path decoding", () => {
  it.each([
    ["série.yaml", "s%C3%A9rie.yaml"],
    ["日本語.yml", "%E6%97%A5%E6%9C%AC%E8%AA%9E.yml"],
    ["😀 space.yaml", "%F0%9F%98%80%20space.yaml"],
    ["has+plus.yaml", "has%2bplus.yaml"],
    ["literal%20.yaml", "literal%2520.yaml"],
    ["stray%zz%.yaml", "stray%zz%.yaml"],
    ["mix%é.yaml", "mix%%C3%A9.yaml"],
  ])("loads %s through async and sync readers", async (name, uri) => {
    writeFileSync(join(root, name), source);
    const expected = await reader.read(name.replaceAll("%", "%25"));
    expect(await reader.read(uri)).toEqual(expected);
    const entry = `file://${join(root, uri)}`;
    expect((await loadSpec({ entry, reader })).document).toEqual(expected);
    expect(loadSpecSync({ entry }).document).toEqual(expected);
  });

  it.each(["%C3", "%FF", "%E2%82", "%C0%AF", "%ED%A0%80"])(
    "rejects malformed UTF-8 %s even when a literal filename exists",
    async (bad) => {
      const uri = `${bad}.yaml`;
      writeFileSync(join(root, uri), source);
      await expect(reader.read(uri)).rejects.toBeInstanceOf(URIError);
      expect(() => loadSpecSync({ entry: join(root, uri) })).toThrow(
        expect.objectContaining({ cause: expect.any(URIError) }),
      );
    },
  );

  it("checks confinement after decoding", async () => {
    writeFileSync(join(base, "série.yaml"), source);
    await expect(reader.read("%2e%2e%2fs%C3%A9rie.yaml")).rejects.toThrow(
      /refusing to read outside/,
    );
  });

  it("resolves an encoded external schema reference in async and sync loads", async () => {
    writeFileSync(join(root, "référence.yaml"), "type: string\n");
    writeFileSync(
      join(root, "entry.yaml"),
      source + 'components:\n  schemas:\n    Value:\n      $ref: "r%C3%A9f%C3%A9rence.yaml"\n',
    );
    const entry = join(root, "entry.yaml");
    const asyncResult = await loadSpec({ entry, reader });
    const syncResult = loadSpecSync({ entry });
    expect(asyncResult.document).toEqual(syncResult.document);
    expect(Object.values(asyncResult.document.components!.schemas!)).toContainEqual({
      type: "string",
    });
  });
});

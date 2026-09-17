import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFileReader, createFileReaderSync } from "../src/reader.js";
import { loadSpec, loadSpecSync } from "../src/load.js";

const base = mkdtempSync(join(tmpdir(), "oav-encoded-json-"));
const root = join(base, "root");
mkdirSync(root);
afterAll(() => rmSync(base, { recursive: true, force: true }));
const spec = { openapi: "3.1.0", info: { title: "Encoded paths", version: "1" }, paths: {} };
const reader = createFileReader(root, { confine: true });
const syncReader = createFileReaderSync(root, { confine: true });

describe("JSON file path decoding", () => {
  it.each([
    ["série.json", "s%C3%A9rie.json"],
    ["日本語.json", "%E6%97%A5%E6%9C%AC%E8%AA%9E.json"],
    ["😀 space.json", "%F0%9F%98%80%20space.json"],
    ["has+plus.json", "has%2bplus.json"],
    ["literal%20.json", "literal%2520.json"],
    ["stray%zz%.json", "stray%zz%.json"],
    ["mix%é.json", "mix%%C3%A9.json"],
  ])("loads %s through direct and resolver readers", async (name, uri) => {
    writeFileSync(join(root, name), JSON.stringify(spec));
    expect(await reader.read(uri)).toEqual(spec);
    expect(syncReader.read(uri)).toEqual(spec);
    const entry = `file://${join(root, uri)}`;
    expect((await loadSpec({ entry, reader })).document).toEqual(spec);
    expect(loadSpecSync({ entry, reader: syncReader }).document).toEqual(spec);
  });

  it.each(["%C3", "%FF", "%E2%82", "%C0%AF", "%ED%A0%80"])(
    "rejects malformed UTF-8 %s even when a literal filename exists",
    async (bad) => {
      const uri = `${bad}.json`;
      writeFileSync(join(root, uri), JSON.stringify(spec));
      for (const input of [uri, `file://${join(root, uri)}`]) {
        const error = expect.objectContaining({
          name: "URIError",
          message: `${input}: invalid UTF-8 in percent-encoded file path`,
          cause: expect.any(URIError),
        });
        await expect(reader.read(input)).rejects.toThrow(error);
        expect(() => syncReader.read(input)).toThrow(error);
        const wrapped = expect.objectContaining({ cause: error });
        await expect(loadSpec({ entry: input, reader })).rejects.toThrow(wrapped);
        expect(() => loadSpecSync({ entry: input, reader: syncReader })).toThrow(wrapped);
      }
    },
  );

  it("checks confinement after decoding", async () => {
    writeFileSync(join(base, "série.json"), JSON.stringify(spec));
    const uri = "%2e%2e%2fs%C3%A9rie.json";
    await expect(reader.read(uri)).rejects.toThrow(/refusing to read outside/);
    expect(() => syncReader.read(uri)).toThrow(/refusing to read outside/);
  });

  it("resolves an encoded external schema reference in async and sync loads", async () => {
    writeFileSync(join(root, "référence.json"), JSON.stringify({ type: "string" }));
    const doc = {
      ...spec,
      components: { schemas: { Value: { $ref: "r%C3%A9f%C3%A9rence.json" } } },
    };
    writeFileSync(join(root, "entry.json"), JSON.stringify(doc));
    const entry = join(root, "entry.json");
    const asyncResult = await loadSpec({ entry, reader });
    const syncResult = loadSpecSync({ entry, reader: syncReader });
    expect(asyncResult.document).toEqual(syncResult.document);
    expect(Object.values(asyncResult.document.components!.schemas!)).toContainEqual({
      type: "string",
    });
  });
});

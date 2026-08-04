import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileReader } from "../src/reader.js";
import { createFileReaderSync } from "../src/internals.js";

/**
 * `maxBytes` on the file readers, matching the HTTP reader's option of
 * the same name. Opt-in: the last block pins that a default-constructed
 * reader still reads a file of any size.
 */
function scratch(): { root: string; smallBytes: number; bigBytes: number } {
  const root = mkdtempSync(join(tmpdir(), "oav-maxbytes-"));
  const small = JSON.stringify({ ok: true });
  const big = JSON.stringify({ pad: "x".repeat(4096) });
  writeFileSync(join(root, "small.json"), small);
  writeFileSync(join(root, "big.json"), big);
  return {
    root,
    smallBytes: Buffer.byteLength(small),
    bigBytes: Buffer.byteLength(big),
  };
}

describe("createFileReader maxBytes", () => {
  it("refuses a file over the limit, naming the limit", async () => {
    const { root, smallBytes } = scratch();
    const reader = createFileReader(root, { maxBytes: smallBytes });
    await expect(reader.read("big.json")).rejects.toThrow(
      /big\.json: file exceeds maxBytes \(\d+\)/,
    );
  });

  it("reads a file at or under the limit", async () => {
    const { root, smallBytes } = scratch();
    const reader = createFileReader(root, { maxBytes: smallBytes });
    await expect(reader.read("small.json")).resolves.toEqual({ ok: true });
  });

  it("reads a file exactly at the limit", async () => {
    const { root, bigBytes } = scratch();
    const reader = createFileReader(root, { maxBytes: bigBytes });
    await expect(reader.read("big.json")).resolves.toBeTypeOf("object");
  });
});

describe("createFileReaderSync maxBytes", () => {
  it("refuses a file over the limit", () => {
    const { root, smallBytes } = scratch();
    const reader = createFileReaderSync(root, { maxBytes: smallBytes });
    expect(() => reader.read("big.json")).toThrow(/file exceeds maxBytes/);
  });

  it("reads a file under the limit", () => {
    const { root, smallBytes } = scratch();
    const reader = createFileReaderSync(root, { maxBytes: smallBytes });
    expect(reader.read("small.json")).toEqual({ ok: true });
  });
});

describe("unset, reads stay unbounded", () => {
  it("reads a file of any size with no options", async () => {
    const { root } = scratch();
    await expect(createFileReader(root).read("big.json")).resolves.toBeTypeOf("object");
    expect(createFileReaderSync(root).read("big.json")).toBeTypeOf("object");
  });
});

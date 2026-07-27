import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  composeReaders,
  createFileReader,
  createHttpReader,
  createMemoryReader,
} from "../src/reader.js";

describe("memory reader", () => {
  it("returns parsed JSON when given a string source", async () => {
    const r = createMemoryReader(new Map([["x.json", '{"a":1}']]));
    expect(await r.read("x.json")).toEqual({ a: 1 });
  });

  it("returns prepared values verbatim", async () => {
    const value = { pre: "parsed" };
    const r = createMemoryReader(new Map<string, unknown>([["x", value]]));
    expect(await r.read("x")).toBe(value);
  });

  it("reports canRead() truthfully", () => {
    const r = createMemoryReader(new Map([["x", "y"]]));
    expect(r.canRead("x")).toBe(true);
    expect(r.canRead("nope")).toBe(false);
  });

  it("throws the install-hint error for .yaml string sources", async () => {
    const r = createMemoryReader(new Map([["x.yaml", "a: 1"]]));
    await expect(r.read("x.yaml")).rejects.toThrow(/Install @oaverify\/yaml/);
  });
});

describe("http reader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports canRead() for http/https URIs only", () => {
    const r = createHttpReader();
    expect(r.canRead("http://example.com/spec.json")).toBe(true);
    expect(r.canRead("https://example.com/spec.json")).toBe(true);
    expect(r.canRead("file:///tmp/spec.json")).toBe(false);
    expect(r.canRead("memory:spec")).toBe(false);
  });

  it("fetches and parses JSON by .json extension", async () => {
    const fetchMock = vi.fn(async () => new Response('{"openapi":"3.1.0"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = createHttpReader();
    expect(await r.read("https://example.com/spec.json")).toEqual({ openapi: "3.1.0" });
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/spec.json");
  });

  it("rejects .yaml URIs with the install-hint error (before fetching)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = createHttpReader();
    await expect(r.read("https://example.com/spec.yaml")).rejects.toThrow(
      /Install @oaverify\/yaml/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the response is non-ok, including the status in the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const r = createHttpReader();
    await expect(r.read("https://example.com/missing.json")).rejects.toThrow(
      /HTTP 404 fetching https:\/\/example\.com\/missing\.json/,
    );
  });

  it("propagates network-level fetch rejections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const r = createHttpReader();
    await expect(r.read("https://example.com/spec.json")).rejects.toThrow(/network down/);
  });
});

describe("file reader", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oav-reader-"));
    writeFileSync(join(dir, "plain.json"), '{"x":1}');
    writeFileSync(join(dir, "has space.json"), '{"x":1}');
    writeFileSync(join(dir, "has+plus.json"), '{"x":2}');
    writeFileSync(join(dir, "something.yaml"), "x: 1");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads an undecorated path", async () => {
    const r = createFileReader(dir);
    expect(await r.read("plain.json")).toEqual({ x: 1 });
  });

  it("decodes percent-escaped spaces in $ref-style paths (#37)", async () => {
    const r = createFileReader(dir);
    expect(await r.read("has%20space.json")).toEqual({ x: 1 });
  });

  it("decodes percent-escaped `+` in paths", async () => {
    const r = createFileReader(dir);
    expect(await r.read("has%2Bplus.json")).toEqual({ x: 2 });
  });

  it("leaves the path alone when it contains a literal unescaped space", async () => {
    const r = createFileReader(dir);
    expect(await r.read("has space.json")).toEqual({ x: 1 });
  });

  it("accepts file:// URIs", async () => {
    const r = createFileReader(dir);
    expect(await r.read("file://plain.json")).toEqual({ x: 1 });
  });

  it("throws the install-hint error for .yaml paths (before touching disk)", async () => {
    const r = createFileReader(dir);
    await expect(r.read("something.yaml")).rejects.toThrow(/Install @oaverify\/yaml/);
  });
});

describe("composeReaders", () => {
  it("tries each reader until one claims the URI", async () => {
    const a = createMemoryReader(new Map([["a.json", '{"from":"a"}']]));
    const b = createMemoryReader(new Map([["b.json", '{"from":"b"}']]));
    const composed = composeReaders([a, b]);
    expect(await composed.read("a.json")).toEqual({ from: "a" });
    expect(await composed.read("b.json")).toEqual({ from: "b" });
  });

  it("throws when no reader accepts", async () => {
    const composed = composeReaders([createMemoryReader(new Map())]);
    await expect(composed.read("nope")).rejects.toThrow(/no reader/);
  });

  it("first reader to claim a URI wins (later readers are shadowed)", async () => {
    // Documented composition contract: composeReaders walks the array and
    // returns the first reader where canRead() is true. A second reader
    // that also claims the same URI must be shadowed; this is the
    // mechanism for layering (e.g. a project-specific reader in front of
    // a generic file reader).
    const front = createMemoryReader(new Map([["shared.json", '{"from":"front"}']]));
    const back = createMemoryReader(new Map([["shared.json", '{"from":"back"}']]));
    const composed = composeReaders([front, back]);
    expect(await composed.read("shared.json")).toEqual({ from: "front" });
  });
});

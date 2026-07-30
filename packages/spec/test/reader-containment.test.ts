import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileReader, createHttpReader, type HttpReaderOptions } from "../src/reader.js";
import { createFileReaderSync } from "../src/internals.js";

/**
 * Containment and outbound-request controls on the readers. All of them
 * are opt-in: the final block pins that a default-constructed reader
 * still behaves exactly as it did before the options existed, including
 * reading through `../`.
 */

function scratch(): { root: string; sibling: string } {
  const base = mkdtempSync(join(tmpdir(), "oav-confine-"));
  const root = join(base, "spec");
  const sibling = join(base, "spec-other");
  mkdirSync(root);
  mkdirSync(sibling);
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "main.json"), `{"in":"root"}`);
  writeFileSync(join(root, "sub", "nested.json"), `{"in":"sub"}`);
  writeFileSync(join(base, "outside.json"), `{"in":"outside"}`);
  writeFileSync(join(sibling, "other.json"), `{"in":"sibling"}`);
  return { root, sibling };
}

function streamingBody(chunks: string[]): {
  body: ReadableStream<Uint8Array>;
  closed: () => boolean;
  pulls: () => number;
} {
  const enc = new TextEncoder();
  let i = 0;
  let closed = false;
  let pulls = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        const chunk = chunks[i];
        i += 1;
        if (chunk === undefined) {
          closed = true;
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(chunk));
      },
    }),
    closed: () => closed,
    pulls: () => pulls,
  };
}

describe("createFileReader confine", () => {
  it("rejects a ../ escape", async () => {
    const { root } = scratch();
    const reader = createFileReader(root, { confine: true });
    await expect(reader.read("../outside.json")).rejects.toThrow(/refusing to read outside/);
  });

  it("rejects an absolute path outside the root", async () => {
    const { root } = scratch();
    const reader = createFileReader(root, { confine: true });
    await expect(reader.read(join(root, "..", "outside.json"))).rejects.toThrow(
      /refusing to read outside/,
    );
  });

  it("still accepts a sibling file and a subdirectory ref", async () => {
    const { root } = scratch();
    const reader = createFileReader(root, { confine: true });
    await expect(reader.read("main.json")).resolves.toEqual({ in: "root" });
    await expect(reader.read("sub/nested.json")).resolves.toEqual({ in: "sub" });
  });

  it("does not admit a sibling directory whose name extends the root", async () => {
    const { root, sibling } = scratch();
    const reader = createFileReader(root, { confine: true });
    // `/…/spec` must not admit `/…/spec-other`: this is what the
    // trailing-separator check buys over a bare startsWith.
    await expect(reader.read(join(sibling, "other.json"))).rejects.toThrow(
      /refusing to read outside/,
    );
  });

  it("rejects a symlink that resolves outside the root", async () => {
    const { root } = scratch();
    symlinkSync(join(root, "..", "outside.json"), join(root, "outside-link.json"));
    const reader = createFileReader(root, { confine: true });
    await expect(reader.read("outside-link.json")).rejects.toThrow(/refusing to read outside/);
  });

  it("accepts a symlink that resolves inside the root", async () => {
    const { root } = scratch();
    symlinkSync(join(root, "sub", "nested.json"), join(root, "nested-link.json"));
    const reader = createFileReader(root, { confine: true });
    await expect(reader.read("nested-link.json")).resolves.toEqual({ in: "sub" });
  });

  it("lets a missing confined file surface the filesystem error", async () => {
    const { root } = scratch();
    const reader = createFileReader(root, { confine: true });
    await expect(reader.read("missing.json")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies to the sync reader too", () => {
    const { root } = scratch();
    symlinkSync(join(root, "..", "outside.json"), join(root, "outside-link.json"));
    const reader = createFileReaderSync(root, { confine: true });
    expect(reader.read("main.json")).toEqual({ in: "root" });
    expect(() => reader.read("../outside.json")).toThrow(/refusing to read outside/);
    expect(() => reader.read("outside-link.json")).toThrow(/refusing to read outside/);
  });
});

describe("createHttpReader controls", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(body: string, init: { status?: number } = {}): ReturnType<typeof vi.fn> {
    const spy = vi.fn(() => Promise.resolve(new Response(body, { status: init.status ?? 200 })));
    globalThis.fetch = spy as unknown as typeof fetch;
    return spy;
  }

  it("allowUri returning false prevents the request entirely", async () => {
    const spy = stubFetch(`{"ok":true}`);
    const reader = createHttpReader({ allowUri: (uri) => uri.startsWith("https://allowed.test/") });
    await expect(reader.read("https://blocked.test/spec.json")).rejects.toThrow(
      /refused by allowUri/,
    );
    expect(spy).not.toHaveBeenCalled();
    await expect(reader.read("https://allowed.test/spec.json")).resolves.toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("maxBytes rejects an oversized body", async () => {
    stubFetch(`{"pad":"${"x".repeat(200)}"}`);
    const reader = createHttpReader({ maxBytes: 64 });
    await expect(reader.read("https://host.test/spec.json")).rejects.toThrow(
      /exceeds maxBytes \(64\)/,
    );
  });

  it("maxBytes stops reading once the streamed response exceeds the limit", async () => {
    const streamed = streamingBody([`{"pad":"`, "xxxxx", `","tail":"unread"}`]);
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(streamed.body))) as typeof fetch;
    const reader = createHttpReader({ maxBytes: 10 });
    await expect(reader.read("https://host.test/spec.json")).rejects.toThrow(
      /exceeds maxBytes \(10\)/,
    );
    expect(streamed.closed()).toBe(false);
    expect(streamed.pulls()).toBeLessThan(4);
  });

  it("maxBytes counts UTF-8 bytes, not string length", async () => {
    // 10 code points, 30 UTF-8 bytes inside the JSON string.
    stubFetch(`{"s":"${"é".repeat(10)}"}`);
    await expect(createHttpReader({ maxBytes: 18 }).read("https://host.test/s")).rejects.toThrow(
      /exceeds maxBytes/,
    );
    await expect(createHttpReader({ maxBytes: 64 }).read("https://host.test/s")).resolves.toEqual({
      s: "é".repeat(10),
    });
  });

  it("passes no init argument at all when no control is set", async () => {
    const spy = stubFetch(`{"ok":true}`);
    await createHttpReader().read("https://host.test/a");
    expect(spy).toHaveBeenCalledWith("https://host.test/a");
  });

  it("passes redirect: error to fetch only when asked", async () => {
    const spy = stubFetch(`{"ok":true}`);
    await createHttpReader({ redirects: "error" }).read("https://host.test/b");
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init).toMatchObject({ redirect: "error" });

    await createHttpReader({ redirects: "follow" }).read("https://host.test/c");
    expect(spy.mock.calls[1]?.[1]).toBeUndefined();
  });

  it("passes an abort signal only when timeoutMs is set", async () => {
    const spy = stubFetch(`{"ok":true}`);
    await createHttpReader({ timeoutMs: 5000 }).read("https://host.test/b");
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("options is optional and every control is inert by default", async () => {
    stubFetch(`{"pad":"${"x".repeat(500)}"}`);
    const reader = createHttpReader();
    await expect(reader.read("https://anything.test/spec.json")).resolves.toBeDefined();
    const explicitlyEmpty: HttpReaderOptions = {};
    await expect(
      createHttpReader(explicitlyEmpty).read("https://anything.test/spec.json"),
    ).resolves.toBeDefined();
  });
});

describe("default construction is unchanged", () => {
  it("still reads through ../ when confine is not set", async () => {
    const { root } = scratch();
    await expect(createFileReader(root).read("../outside.json")).resolves.toEqual({
      in: "outside",
    });
    expect(createFileReaderSync(root).read("../outside.json")).toEqual({ in: "outside" });
  });

  it("still honors an absolute path when confine is not set", async () => {
    const { root, sibling } = scratch();
    await expect(createFileReader(root).read(join(sibling, "other.json"))).resolves.toEqual({
      in: "sibling",
    });
  });
});

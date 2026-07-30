import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSmartHttpReader, createYamlFileReader } from "../src/index.js";

/**
 * The YAML readers compose ahead of the JSON-only ones, so whichever
 * claims the URI first is the one whose controls apply. If these
 * mirrors are missing, hardening the core readers is bypassed by
 * putting a `.yaml` extension on the ref.
 *
 * Mirrors `packages/spec/test/reader-containment.test.ts`.
 */

function scratch(): { root: string; sibling: string } {
  const base = mkdtempSync(join(tmpdir(), "oav-yaml-confine-"));
  const root = join(base, "spec");
  const sibling = join(base, "spec-other");
  mkdirSync(root);
  mkdirSync(sibling);
  writeFileSync(join(root, "main.yaml"), "in: root\n");
  writeFileSync(join(base, "outside.yaml"), "in: outside\n");
  writeFileSync(join(sibling, "other.yaml"), "in: sibling\n");
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

describe("createYamlFileReader confine", () => {
  it("rejects a ../ escape", async () => {
    const { root } = scratch();
    const reader = createYamlFileReader(root, { confine: true });
    await expect(reader.read("../outside.yaml")).rejects.toThrow(/refusing to read outside/);
  });

  it("does not admit a sibling directory whose name extends the root", async () => {
    const { root, sibling } = scratch();
    const reader = createYamlFileReader(root, { confine: true });
    await expect(reader.read(join(sibling, "other.yaml"))).rejects.toThrow(
      /refusing to read outside/,
    );
  });

  it("still accepts a file inside the root", async () => {
    const { root } = scratch();
    const reader = createYamlFileReader(root, { confine: true });
    await expect(reader.read("main.yaml")).resolves.toEqual({ in: "root" });
  });

  it("rejects a symlink that resolves outside the root", async () => {
    const { root } = scratch();
    symlinkSync(join(root, "..", "outside.yaml"), join(root, "outside-link.yaml"));
    const reader = createYamlFileReader(root, { confine: true });
    await expect(reader.read("outside-link.yaml")).rejects.toThrow(/refusing to read outside/);
  });

  it("accepts a symlink that resolves inside the root", async () => {
    const { root } = scratch();
    symlinkSync(join(root, "main.yaml"), join(root, "main-link.yaml"));
    const reader = createYamlFileReader(root, { confine: true });
    await expect(reader.read("main-link.yaml")).resolves.toEqual({ in: "root" });
  });

  it("reads through ../ by default", async () => {
    const { root } = scratch();
    await expect(createYamlFileReader(root).read("../outside.yaml")).resolves.toEqual({
      in: "outside",
    });
  });
});

describe("createSmartHttpReader controls", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(body: string, contentType: string): ReturnType<typeof vi.fn> {
    const spy = vi.fn(() =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": contentType } }),
      ),
    );
    globalThis.fetch = spy as unknown as typeof fetch;
    return spy;
  }

  it("allowUri returning false prevents the request entirely", async () => {
    const spy = stubFetch("in: remote\n", "application/yaml");
    const reader = createSmartHttpReader({ allowUri: (uri) => uri.startsWith("https://ok.test/") });
    await expect(reader.read("https://blocked.test/spec.yaml")).rejects.toThrow(
      /refused by allowUri/,
    );
    expect(spy).not.toHaveBeenCalled();
    await expect(reader.read("https://ok.test/spec.yaml")).resolves.toEqual({ in: "remote" });
  });

  it("maxBytes rejects an oversized body", async () => {
    stubFetch(`in: ${"x".repeat(200)}\n`, "application/yaml");
    await expect(
      createSmartHttpReader({ maxBytes: 32 }).read("https://host.test/spec.yaml"),
    ).rejects.toThrow(/exceeds maxBytes \(32\)/);
  });

  it("maxBytes stops reading once the streamed response exceeds the limit", async () => {
    const streamed = streamingBody(["in: ", "xxxxxxxx", "\ntail: unread\n"]);
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(streamed.body, {
          status: 200,
          headers: { "content-type": "application/yaml" },
        }),
      ),
    ) as typeof fetch;
    await expect(
      createSmartHttpReader({ maxBytes: 8 }).read("https://host.test/spec.yaml"),
    ).rejects.toThrow(/exceeds maxBytes \(8\)/);
    expect(streamed.closed()).toBe(false);
    expect(streamed.pulls()).toBeLessThan(4);
  });

  it("passes redirect: error to fetch only when asked", async () => {
    const spy = stubFetch("in: remote\n", "application/yaml");
    await createSmartHttpReader().read("https://host.test/a.yaml");
    expect(spy).toHaveBeenCalledWith("https://host.test/a.yaml");

    await createSmartHttpReader({ redirects: "error" }).read("https://host.test/b.yaml");
    expect(spy.mock.calls[1]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("every control is inert by default", async () => {
    stubFetch(`in: ${"x".repeat(500)}\n`, "application/yaml");
    await expect(
      createSmartHttpReader().read("https://anything.test/spec.yaml"),
    ).resolves.toBeDefined();
  });
});

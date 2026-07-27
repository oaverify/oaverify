import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { composeReaders, createFileReader, resolveSpec } from "@oav/spec";
import { createSmartHttpReader, createYamlFileReader, parseYamlString } from "../src/index.js";

describe("createYamlFileReader", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oav-loaders-"));
    writeFileSync(join(dir, "plain.yaml"), "a: 1\nb:\n  - 2");
    writeFileSync(join(dir, "has space.yaml"), "x: 1");
    writeFileSync(join(dir, "has+plus.yml"), "x: 2");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("claims only yaml extensions", () => {
    const r = createYamlFileReader(dir);
    expect(r.canRead("x.yaml")).toBe(true);
    expect(r.canRead("x.yml")).toBe(true);
    expect(r.canRead("x.json")).toBe(false);
    expect(r.canRead("http://example.com/x.yaml")).toBe(false);
  });

  it("reads .yaml and .yml files", async () => {
    const r = createYamlFileReader(dir);
    expect(await r.read("plain.yaml")).toEqual({ a: 1, b: [2] });
    expect(await r.read("has+plus.yml")).toEqual({ x: 2 });
  });

  it("decodes percent-escaped spaces and `+` in paths (#37)", async () => {
    const r = createYamlFileReader(dir);
    expect(await r.read("has%20space.yaml")).toEqual({ x: 1 });
    expect(await r.read("has%2Bplus.yml")).toEqual({ x: 2 });
  });

  it("accepts file:// URIs", async () => {
    const r = createYamlFileReader(dir);
    expect(await r.read("file://plain.yaml")).toEqual({ a: 1, b: [2] });
  });
});

describe("createSmartHttpReader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: string, contentType: string | null, status = 200): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status,
            headers: contentType === null ? {} : { "Content-Type": contentType },
          }),
      ),
    );
  }

  it("claims any http(s) URI regardless of extension", () => {
    const r = createSmartHttpReader();
    expect(r.canRead("https://example.com/spec.yaml")).toBe(true);
    expect(r.canRead("http://example.com/spec.json")).toBe(true);
    expect(r.canRead("https://api.example.com/openapi")).toBe(true);
    expect(r.canRead("file:///x.yaml")).toBe(false);
    expect(r.canRead("memory:spec")).toBe(false);
  });

  it("parses as YAML when Content-Type advertises yaml (any of the usual spellings)", async () => {
    for (const ct of [
      "application/yaml",
      "application/x-yaml",
      "text/yaml",
      "text/x-yaml",
      "application/yaml; charset=utf-8",
    ]) {
      stubFetch("openapi: 3.1.0\ninfo: { title: X, version: '1' }", ct);
      const r = createSmartHttpReader();
      // URL has no yaml extension on purpose; Content-Type drives the pick.
      expect(await r.read("https://api.example.com/openapi"), `ct=${ct}`).toEqual({
        openapi: "3.1.0",
        info: { title: "X", version: "1" },
      });
    }
  });

  it("parses as JSON when Content-Type advertises json, including +json suffixes", async () => {
    for (const ct of [
      "application/json",
      "text/json",
      "application/vnd.openapi+json",
      "application/json; charset=utf-8",
    ]) {
      stubFetch('{"openapi":"3.1.0"}', ct);
      const r = createSmartHttpReader();
      expect(await r.read("https://api.example.com/openapi"), `ct=${ct}`).toEqual({
        openapi: "3.1.0",
      });
    }
  });

  it("prefers Content-Type over a conflicting URL extension", async () => {
    // URL ends in .yaml but server advertises JSON → parse as JSON.
    // A misconfigured URL (e.g. a content-management system serving a
    // JSON API at a .yaml alias) shouldn't break the reader.
    stubFetch('{"openapi":"3.1.0"}', "application/json");
    let r = createSmartHttpReader();
    expect(await r.read("https://example.com/spec.yaml")).toEqual({ openapi: "3.1.0" });

    // URL ends in .json but server advertises YAML → parse as YAML.
    stubFetch("openapi: 3.1.0", "application/yaml");
    r = createSmartHttpReader();
    expect(await r.read("https://example.com/spec.json")).toEqual({ openapi: "3.1.0" });
  });

  it("falls back to URL extension when Content-Type is ambiguous", async () => {
    // text/plain + .yaml extension → YAML.
    stubFetch("openapi: 3.1.0", "text/plain");
    let r = createSmartHttpReader();
    expect(await r.read("https://example.com/spec.yaml")).toEqual({ openapi: "3.1.0" });

    // text/plain + no extension → defaults to JSON.
    stubFetch('{"openapi":"3.1.0"}', "text/plain");
    r = createSmartHttpReader();
    expect(await r.read("https://api.example.com/openapi")).toEqual({ openapi: "3.1.0" });

    // Missing Content-Type + .yml extension → YAML.
    stubFetch("openapi: 3.1.0", null);
    r = createSmartHttpReader();
    expect(await r.read("https://example.com/spec.yml")).toEqual({ openapi: "3.1.0" });
  });

  it("throws when the response is non-ok, including the status in the message", async () => {
    stubFetch("nope", "application/json", 404);
    const r = createSmartHttpReader();
    await expect(r.read("https://example.com/missing.json")).rejects.toThrow(
      /HTTP 404 fetching https:\/\/example\.com\/missing\.json/,
    );
  });
});

describe("composed with the main-package JSON readers", () => {
  it("resolveSpec works against a YAML-fronted compose chain", async () => {
    const { readFile: readFileSync, writeFile: writeFileSync2 } = await import("node:fs/promises");
    const d = mkdtempSync(join(tmpdir(), "oav-loaders-compose-"));
    try {
      await writeFileSync2(
        join(d, "main.yaml"),
        "openapi: 3.1.0\ninfo:\n  title: X\n  version: '1'\npaths:\n  /x: { get: { responses: { '200': { description: ok } } } }",
      );
      const reader = composeReaders([createYamlFileReader(d), createFileReader(d)]);
      const { document } = await resolveSpec({ reader, entry: "main.yaml" });
      expect(document.info.title).toBe("X");
      // sanity: readFileSync import used above as part of the setup chain
      void readFileSync;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("parseYamlString", () => {
  it("parses a YAML source to a JSON-compatible value", () => {
    expect(parseYamlString("a: 1\nb: [2, 3]")).toEqual({ a: 1, b: [2, 3] });
    expect(parseYamlString("42")).toBe(42);
  });
});

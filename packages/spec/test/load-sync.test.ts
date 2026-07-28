import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSpecSync } from "../src/load.js";
import { createFileReaderSync } from "../src/reader.js";

/**
 * Narrow past a `$ref` union. OpenAPI containers type most members as
 * `ReferenceObject | T`; these specs are already resolved, so the ref
 * branch is unreachable -- but say so explicitly rather than casting,
 * so a genuinely unresolved ref fails loudly here.
 */
function notRef<T extends object>(node: T): Exclude<T, { $ref: string }> {
  if ("$ref" in node) {
    throw new Error(`expected a resolved object, got $ref ${String(node.$ref)}`);
  }
  return node as Exclude<T, { $ref: string }>;
}

// End-to-end against the real filesystem (the boot-time case loadSpecSync
// exists for): a multi-file $ref graph on disk, plus the failure modes a
// load-at-boot caller has to reason about.

describe("loadSpecSync on disk", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oav-loadsync-"));
    mkdirSync(join(dir, "schemas"));
    writeFileSync(
      join(dir, "openapi.json"),
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Disk", version: "1" },
        paths: {
          "/pets": {
            post: {
              requestBody: {
                content: { "application/json": { schema: { $ref: "schemas/pet.json" } } },
              },
              responses: { "201": { description: "created" } },
            },
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "schemas", "pet.json"),
      JSON.stringify({
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a multi-file $ref graph from local files (default reader)", () => {
    const { document, sources } = loadSpecSync({ entry: join(dir, "openapi.json") });
    const schema = (
      notRef(document.paths?.["/pets"]?.post?.requestBody ?? {}) as {
        content?: Record<string, { schema?: unknown }>;
      }
    ).content?.["application/json"]?.schema;
    expect(schema).toEqual({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    });
    expect(sources.some((s) => s.endsWith("pet.json"))).toBe(true);
  });

  it("throws a useful error when the entry file is missing", () => {
    expect(() => loadSpecSync({ entry: join(dir, "does-not-exist.json") })).toThrow(
      /does-not-exist\.json/,
    );
  });

  it("throws when a spec file is malformed JSON", () => {
    writeFileSync(join(dir, "broken.json"), "{ not json");
    expect(() => loadSpecSync({ entry: join(dir, "broken.json") })).toThrow();
  });

  it("the unreadable-spec-disables-validation policy is expressible by the caller", () => {
    // loadSpecSync throws rather than guessing; the 'disable, don't crash
    // boot' policy is the caller's, expressed with their own try/catch.
    const loadOrDisable = (entry: string): unknown => {
      try {
        return loadSpecSync({ entry }).document;
      } catch {
        return null;
      }
    };
    expect(loadOrDisable(join(dir, "openapi.json"))).not.toBeNull();
    expect(loadOrDisable(join(dir, "nope.json"))).toBeNull();
  });
});

describe("createFileReaderSync", () => {
  it("throws the YAML install hint for .yaml paths (JSON-only)", () => {
    const reader = createFileReaderSync("/tmp");
    expect(() => reader.read("openapi.yaml")).toThrow(/does not parse YAML directly/);
  });
});

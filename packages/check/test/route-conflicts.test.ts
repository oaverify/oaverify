import { describe, expect, it } from "vitest";
import { createValidator } from "@oaverify/internal-validator";
import { createMemoryReader, loadSpec } from "@oaverify/internal-spec";
import { CheckAbortedError, checkSpec } from "../src/check.js";
import { parseFindingTerms, resolveFindingSelection } from "../src/selection.js";
import { parseSeverityMap } from "../src/severity.js";

const operation = {
  responses: {
    "200": {
      description: "ok",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/Summary" },
          example: { status: 7 },
        },
      },
    },
  },
};

function document(paths: Record<string, unknown>) {
  return {
    openapi: "3.1.0",
    info: { title: "Overlap", version: "1" },
    paths,
    components: {
      schemas: {
        Summary: {
          type: "object",
          required: ["status", "missing"],
          properties: { status: { type: "string" } },
        },
      },
    },
  };
}

async function resolved(doc: unknown) {
  return loadSpec({
    entry: "entry.json",
    reader: createMemoryReader(new Map([["entry.json", doc]])),
    provenance: true,
  });
}

const pointer = (path: string) => `/paths/${path.replace(/~/g, "~0").replace(/\//g, "~1")}`;

describe("route conflicts in check", () => {
  it.each([
    ["/pets/{id}", "/pets/{name}"],
    ["/files/{id}.json", "/files/{name}.json"],
    ["/a", "/a/"],
    ["/bad%zz", "/bad%25zz"],
    ["/a~b", "/a%7Eb"],
  ])("reports %s and %s while completing other passes", async (first, second) => {
    const spec = await resolved(
      document({ [first]: { get: operation }, [second]: { get: operation } }),
    );
    const findings = checkSpec(spec);
    const conflicts = findings.filter((f) => f.code === "route-conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      class: "hygiene",
      severity: "error",
      location: pointer(second),
      target: { pointer: pointer(second), anchor: "node", source: { pointer: pointer(second) } },
      contributors: [
        { pointer: pointer(first), anchor: "node", source: { pointer: pointer(first) } },
      ],
    });
    expect(conflicts[0]?.message).toContain("GET");
    expect(findings.some((f) => f.code === "example-invalid")).toBe(true);
    expect(findings.some((f) => f.code === "silent-rewrite/required-not-in-properties")).toBe(true);
    expect(() => createValidator(spec.document)).toThrow(/createRouter: path templates/);
  });

  it("groups methods by conflicting path pair and reports later conflicts", async () => {
    const spec = await resolved(
      document({
        "/pets/{a}": { get: operation, post: operation },
        "/pets/{b}": { get: operation, post: operation },
        "/pets/{c}": { get: operation, head: operation },
        "/other": { get: operation },
        "/other/": { get: operation },
      }),
    );
    const findings = checkSpec(spec).filter((f) => f.code === "route-conflict");
    expect(findings.map((f) => f.target?.pointer)).toEqual([
      pointer("/pets/{b}"),
      pointer("/pets/{c}"),
      pointer("/other/"),
    ]);
    expect(findings[0]?.message).toContain("POST");
    expect(findings[1]?.message).toContain("GET");
    expect(findings[1]?.message).toContain("HEAD");
    expect(findings.slice(0, 2).map((f) => f.contributors?.[0]?.pointer)).toEqual([
      pointer("/pets/{a}"),
      pointer("/pets/{a}"),
    ]);
  });

  it("keeps disjoint methods and ordinary route ambiguity unchanged", async () => {
    const spec = await resolved(
      document({
        "/pets/{a}": { get: operation },
        "/pets/{b}": { post: operation },
        "/{entity}/me": { get: operation },
        "/books/{id}": { get: operation },
      }),
    );
    expect(checkSpec(spec).filter((f) => f.code === "route-conflict")).toEqual([]);
    expect(() => createValidator(spec.document)).not.toThrow();
  });

  it("honors finding selection and severity overrides", async () => {
    const spec = await resolved(document({ "/a": { get: operation }, "/a/": { get: operation } }));
    const only = checkSpec(spec, {
      findings: resolveFindingSelection(parseFindingTerms("route-conflict")),
      severity: parseSeverityMap(["route-conflict=warning"]),
    });
    expect(only).toHaveLength(1);
    expect(only[0]?.severity).toBe("warning");
    const examples = checkSpec(spec, {
      findings: resolveFindingSelection(parseFindingTerms("examples")),
    });
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.every((f) => f.class === "examples")).toBe(true);
  });

  it("attributes path names to the declaring file when Path Item values are external", async () => {
    const spec = await loadSpec({
      entry: "entry.json",
      reader: createMemoryReader(
        new Map<string, unknown>([
          [
            "entry.json",
            document({
              "/a": { $ref: "items.json#/first" },
              "/a/": { $ref: "items.json#/second" },
            }),
          ],
          [
            "items.json",
            {
              first: { get: { responses: { "200": { description: "ok" } } } },
              second: { get: { responses: { "200": { description: "ok" } } } },
            },
          ],
        ]),
      ),
      provenance: true,
    });
    const conflict = checkSpec(spec).find((f) => f.code === "route-conflict");
    expect(conflict?.target?.source).toMatchObject({ uri: "entry.json", pointer: pointer("/a/") });
    expect(conflict?.contributors?.[0]?.source).toMatchObject({
      uri: "entry.json",
      pointer: pointer("/a"),
    });
    const changed = {
      ...spec,
      regions: [...spec.regions!, { kind: "synthetic" as const, at: pointer("/a/") }],
    };
    expect(
      checkSpec(changed).find((f) => f.code === "route-conflict")?.target?.source,
    ).toBeUndefined();
  });

  it("still rejects a non-OpenAPI document after finding a collision", async () => {
    const spec = await resolved(document({ "/a": { get: operation }, "/a/": { get: operation } }));
    spec.document.openapi = "2.0";
    try {
      checkSpec(spec);
      expect.unreachable("expected an abort");
    } catch (error) {
      expect(error).toBeInstanceOf(CheckAbortedError);
      expect((error as Error).message).toContain("openapi");
      expect((error as CheckAbortedError).findings.some((f) => f.code === "route-conflict")).toBe(
        true,
      );
    }
  });

  it("still reports an unresolved schema reference after finding a collision", async () => {
    const spec = await resolved(document({ "/a": { get: operation }, "/a/": { get: operation } }));
    spec.document.components!.schemas!.Summary = { $ref: "#/components/schemas/Missing" };
    const findings = checkSpec(spec);
    expect(findings.some((f) => f.code === "route-conflict")).toBe(true);
    expect(findings.find((f) => f.class === "malformed")?.message).toContain("Missing");
  });
});

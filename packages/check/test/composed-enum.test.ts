import { describe, expect, it } from "vitest";
import { createMemoryReader, loadSpec } from "@oaverify/internal-spec";
import { checkSpec } from "../src/check.js";
import {
  parseFindingTerms,
  resolveFindingSelection,
  selectionForClasses,
} from "../src/selection.js";
import { applySkip } from "../src/skip.js";
import { parseSeverityMap } from "../src/severity.js";
import { renderSarif } from "../src/sarif.js";
import { spanRequestsFor } from "../src/span-target.js";

const CODE = "unsatisfiable/composed-enum-members";
const crossing = { allOf: [{ enum: ["A", "B"] }, { enum: ["B", "C"] }] };
const document = (schemas: unknown) => ({
  openapi: "3.1.0",
  info: { title: "T", version: "1" },
  paths: {},
  components: { schemas },
});
const resolved = (doc: unknown, other: Record<string, unknown> = {}) =>
  loadSpec({
    entry: "spec.json",
    reader: createMemoryReader(new Map(Object.entries({ "spec.json": doc, ...other })) as never),
    provenance: true,
  });
const schemaOnly = { findings: selectionForClasses(["schema"]) };

describe("composed enum document diagnostics", () => {
  it("checks unused components with complete contributor source addresses", async () => {
    const spec = await resolved(document({ X: crossing }));
    const issues = checkSpec(spec, schemaOnly);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue).toMatchObject({
      code: CODE,
      severity: "warning",
      target: { pointer: "/components/schemas/X", anchor: "node" },
    });
    expect(issue.contributors?.map((c) => [c.pointer, c.source?.pointer, c.source?.uri])).toEqual([
      ["/components/schemas/X/allOf/0/enum", "/components/schemas/X/allOf/0/enum", "spec.json"],
      ["/components/schemas/X/allOf/1/enum", "/components/schemas/X/allOf/1/enum", "spec.json"],
    ]);
    expect(JSON.parse(JSON.stringify(issues))).toEqual(issues);
  });

  it("attributes hoisted external contributors to the source file", async () => {
    const spec = await resolved(
      document({ X: { allOf: [{ $ref: "base.json" }, { enum: ["B", "C"] }] } }),
      { "base.json": { enum: ["A", "B"] } },
    );
    const issue = checkSpec(spec, schemaOnly).find((f) => f.code === CODE)!;
    expect(issue.target?.pointer).toBe("/components/schemas/X");
    expect(issue.contributors).toHaveLength(2);
    expect(
      issue.contributors?.some(
        (c) => c.source?.uri === "base.json" && c.source.pointer === "/enum",
      ),
    ).toBe(true);
    for (const c of issue.contributors!) {
      const value = c.pointer
        .split("/")
        .slice(1)
        .reduce(
          (node: unknown, key) =>
            (node as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")],
          spec.document,
        );
      expect(Array.isArray(value)).toBe(true);
    }
  });

  it("resolves nested resource pointers in the referring resource", async () => {
    const spec = await resolved(
      document({
        X: {
          $defs: { A: { const: "wrong-resource" } },
          properties: {
            nested: {
              $id: "https://example.test/nested",
              $defs: { A: { enum: ["A", "B"] } },
              $ref: "#/$defs/A",
              enum: ["B", "C"],
            },
          },
        },
      }),
    );
    const issues = checkSpec(spec, schemaOnly).filter((f) =>
      f.code.startsWith("unsatisfiable/composed-enum"),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe(CODE);
    expect(issues[0]?.contributors?.map((c) => c.pointer)).toContain(
      "/components/schemas/X/properties/nested/$defs/A/enum",
    );
  });

  it("keeps separate use sites and counts repeated definition occurrences", async () => {
    const spec = await resolved(
      document({
        Base: { enum: ["A", "B"] },
        X: {
          properties: {
            a: { $ref: "#/components/schemas/Base", enum: ["B", "C"] },
            b: { $ref: "#/components/schemas/Base", enum: ["B", "C"] },
          },
        },
        Conflict: crossing,
        Use: { $ref: "#/components/schemas/Conflict" },
      }),
    );
    const issues = checkSpec(spec, schemaOnly).filter((f) => f.code === CODE);
    expect(issues.map((f) => f.target?.pointer)).toEqual([
      "/components/schemas/X/properties/a",
      "/components/schemas/X/properties/b",
      "/components/schemas/Conflict",
    ]);
    expect(issues[2]?.occurrences).toBe(2);
    expect(issues[2]?.contributors).toHaveLength(2);
  });

  it("preserves independent code selection and severity mapping", async () => {
    const spec = await resolved(
      document({ X: crossing, Empty: { allOf: [{ const: "A" }, { const: "B" }] } }),
    );
    const findings = resolveFindingSelection(parseFindingTerms(`schema,-${CODE}`));
    const { findings: issues } = applySkip(
      checkSpec(spec, {
        findings,
        severity: parseSeverityMap(["unsatisfiable/composed-enum-empty=error"]),
      }),
      findings.excludeKeys,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "unsatisfiable/composed-enum-empty",
      severity: "error",
    });
    expect(
      checkSpec(spec, { findings: selectionForClasses(["hygiene"]) }).every(
        (f) => f.class !== "schema",
      ),
    ).toBe(true);
  });

  it("withholds secondary diagnostics for malformed or unsupported schema resources", async () => {
    const spec = await resolved(
      document({
        Bad: { allOf: [...crossing.allOf, { enum: "B" }] },
        Unsupported: { $schema: "https://example.test/unknown", ...crossing },
      }),
    );
    const issues = checkSpec(spec, schemaOnly);
    expect(issues.some((f) => f.code === "malformed-schema")).toBe(true);
    expect(issues.some((f) => f.code === "unsupported-schema-dialect")).toBe(true);
    expect(issues.some((f) => f.code.startsWith("unsatisfiable/composed-enum"))).toBe(false);
  });

  it("requests and renders separately attributed contributor spans", async () => {
    const issues = checkSpec(await resolved(document({ X: crossing })), schemaOnly);
    const requests = spanRequestsFor(issues);
    expect(requests.map((r) => r.pointer)).toContain("/components/schemas/X/allOf/0/enum");
    const log = JSON.parse(
      renderSarif(issues, {
        classes: ["schema"],
        spanOf: (request) =>
          requests.some((r) => r.pointer === request.pointer)
            ? { start: { line: 2, column: 1, offset: 3 }, end: { line: 2, column: 5, offset: 7 } }
            : undefined,
      }),
    );
    const related = log.runs[0].results[0].relatedLocations;
    expect(related.map((r: { properties: unknown }) => r.properties)).toEqual([
      { "oaverify:kind": "contributor", "oaverify:contributorIndex": 0 },
      { "oaverify:kind": "contributor", "oaverify:contributorIndex": 1 },
    ]);
    const unlocated = JSON.parse(renderSarif(issues, { classes: ["schema"] }));
    expect(unlocated.runs[0].results[0].relatedLocations).toBeUndefined();
    const synthetic = [{ ...issues[0]!, target: { pointer: "/new", anchor: "node" as const } }];
    expect(spanRequestsFor(synthetic)).toEqual([]);
  });
});

import { expect, it } from "vitest";
import { createMemoryReader, loadSpec } from "@oaverify/internal-spec";
import { checkDocumentExamples } from "@oaverify/internal-validator";
import { checkSpec } from "../src/check.js";
import { parseFindingTerms, resolveFindingSelection } from "../src/selection.js";

it("keeps standalone compile failures distinct from checker-owned withholding", async () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "examples", version: "1" },
    paths: {},
    components: {
      schemas: {
        Malformed: { type: "nonsense", example: 1 },
        Unsupported: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "nonsense",
          example: 1,
        },
        Invalid: { type: "string", example: 1 },
        Valid: { type: "string", example: "ok" },
      },
    },
  };
  const resolved = await loadSpec({
    entry: "entry.json",
    reader: createMemoryReader(new Map([["entry.json", document]])),
  });
  expect(checkDocumentExamples(resolved.document).map((i) => [i.code, i.pointer])).toEqual([
    ["example-uncheckable", "/components/schemas/Malformed/example"],
    ["example-uncheckable", "/components/schemas/Unsupported/example"],
    ["example-invalid", "/components/schemas/Invalid/example"],
  ]);
  const selected = (terms: string) =>
    checkSpec(resolved, { findings: resolveFindingSelection(parseFindingTerms(terms)) });
  expect(
    selected("schema,examples")
      .map((i) => i.code)
      .sort(),
  ).toEqual(["example-invalid", "malformed-schema", "unsupported-schema-dialect"]);
  // Without the compile prepass nothing else reports the malformed schema,
  // so its example says it went unchecked (#1131). The unsupported-dialect
  // unit is still withheld, and the invalid example is reported as before.
  const examplesOnly = selected("examples");
  expect(examplesOnly.map((i) => [i.code, i.target?.pointer, i.severity])).toEqual([
    ["example-uncheckable", "/components/schemas/Malformed/example", "warning"],
    ["example-invalid", "/components/schemas/Invalid/example", "warning"],
  ]);
  expect(examplesOnly[0]?.message).toMatch(/^example could not be checked .*compilation failed: /);
  // A selection that compiles keeps the single malformed-schema report.
  expect(
    selected("examples,unknown-keyword")
      .map((i) => i.code)
      .sort(),
  ).toEqual(["example-invalid", "malformed-schema"]);
});

it("withholds an uncompilable example exactly when the malformed finding survives selection (#1131)", async () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "examples", version: "1" },
    paths: {},
    components: {
      schemas: {
        Malformed: { type: "nonsense", example: 1 },
        Unsupported: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "nonsense",
          example: 1,
        },
        Invalid: { type: "string", example: 1 },
      },
    },
  };
  const resolved = await loadSpec({
    entry: "entry.json",
    reader: createMemoryReader(new Map([["entry.json", document]])),
  });
  const run = (terms: string | undefined) => {
    const findings =
      terms === undefined
        ? checkSpec(resolved)
        : checkSpec(resolved, { findings: resolveFindingSelection(parseFindingTerms(terms)) });
    return {
      uncheckable: findings
        .filter((f) => f.code === "example-uncheckable")
        .map((f) => f.target?.pointer),
      malformed: findings.filter((f) => f.code === "malformed-schema").length,
      invalid: findings.some((f) => f.code === "example-invalid"),
    };
  };
  const reported = {
    uncheckable: ["/components/schemas/Malformed/example"],
    malformed: 0,
    invalid: true,
  };
  const withheld = { uncheckable: [], malformed: 1, invalid: true };

  // Schema-class codes that do not compile leave nothing to report it.
  expect(run("examples,format-not-validated")).toEqual(reported);
  expect(run("examples,unsupported-schema-dialect")).toEqual(reported);
  // A compiling base reports the schema once, whatever is excluded.
  expect(run(undefined)).toEqual(withheld);
  expect(run("-hygiene")).toEqual(withheld);
  expect(run("examples,schema,-unknown-keyword")).toEqual(withheld);
  // Exclusion keys apply after the passes (applySkip), so they never
  // change whether compilation runs.
  expect(run("examples,unknown-keyword,-example-invalid")).toEqual(withheld);
});

it("refuses an unsafe pattern before reporting a compile failure (#1131)", async () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "examples", version: "1" },
    paths: {},
    components: {
      schemas: {
        Both: { type: "nonsense", pattern: "^(a+)+$", example: "aaaaaaaaaaaaaaaaaaaaaaaa!" },
      },
    },
  };
  const resolved = await loadSpec({
    entry: "entry.json",
    reader: createMemoryReader(new Map([["entry.json", document]])),
  });
  const [finding, ...rest] = checkSpec(resolved, {
    findings: resolveFindingSelection(parseFindingTerms("examples")),
  });
  expect(rest).toEqual([]);
  expect(finding?.code).toBe("example-uncheckable");
  expect(finding?.message).toContain("superlinear");
  expect(finding?.message).not.toContain("compilation failed");
});

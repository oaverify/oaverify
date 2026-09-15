import { createMemoryReader, loadSpec } from "@oaverify/internal-spec";
import { describe, expect, it } from "vitest";
import { CheckAbortedError, checkSpec } from "../src/check.js";
import { parseFindingTerms, resolveFindingSelection } from "../src/selection.js";
import { parseSeverityMap } from "../src/severity.js";
import { applySkip } from "../src/skip.js";

async function resolve(openapi: unknown) {
  return loadSpec({
    reader: createMemoryReader(
      new Map([
        [
          "entry.json",
          {
            openapi,
            info: { title: "t", version: "1" },
            paths: {},
          },
        ],
      ]),
    ),
    entry: "entry.json",
    provenance: true,
  });
}

const select = (terms: string) => resolveFindingSelection(parseFindingTerms(terms));

describe("unsupported OpenAPI versions", () => {
  it("discloses skipped conformance and fallback semantics at the version", async () => {
    const findings = checkSpec(await resolve("3.7.0"));
    expect(findings).toEqual([
      expect.objectContaining({
        code: "unsupported-openapi-version",
        class: "hygiene",
        severity: "warning",
        location: "/openapi",
        target: expect.objectContaining({
          pointer: "/openapi",
          anchor: "node",
          source: expect.any(Object),
        }),
      }),
    ]);
    expect(findings[0]!.message).toContain('"3.7.0"');
    expect(findings[0]!.message).toContain("conformance is skipped");
    expect(findings[0]!.message).toContain("OpenAPI 3.1");
  });

  it.each(["3.0.4", "3.1.0", "3.2.0"])("accepts the supported line %s", async (version) => {
    expect(checkSpec(await resolve(version))).toEqual([]);
  });

  it("supports code selection, severity remapping and exclusion", async () => {
    const resolved = await resolve("3.7.0");
    const findings = checkSpec(resolved, {
      findings: select("unsupported-openapi-version"),
      severity: parseSeverityMap(["unsupported-openapi-version=error"]),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    for (const cls of ["schema", "conformance"]) {
      expect(checkSpec(resolved, { findings: select(cls) })).toEqual([]);
    }
    const selection = select("-unsupported-openapi-version");
    expect(
      applySkip(checkSpec(resolved, { findings: selection }), selection.excludeKeys).findings,
    ).toEqual([]);
  });

  it.each([undefined, 3, "garbage", "2.0.0", "4.0.0"])(
    "preserves the gradeability abort for %s",
    async (version) => {
      expect(() =>
        checkSpec({
          document: { openapi: version, info: { title: "t", version: "1" }, paths: {} },
        } as never),
      ).toThrow(CheckAbortedError);
    },
  );
});

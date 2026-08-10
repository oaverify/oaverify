import { describe, expect, it } from "vitest";
import type { SourceSpan } from "@oaverify/internal-spec";
import type { CheckFinding } from "../src/finding.js";
import { renderSarif } from "../src/sarif.js";

/**
 * SARIF `region`, which arrives from a caller's span lookup rather than
 * from the finding (#610). What matters here is that an unwired caller
 * emits exactly what it emitted before, and a wired one emits a region
 * in SARIF's units.
 */

const BASE = "/repo";

interface SarifRegion {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  charOffset: number;
  charLength: number;
}
interface SarifLoc {
  physicalLocation: { artifactLocation: { uri: string }; region?: SarifRegion };
}
interface SarifLog {
  runs: { results: { locations: SarifLoc[]; relatedLocations?: SarifLoc[] }[] }[];
}

const FINDING: CheckFinding = {
  code: "unused-component",
  class: "hygiene",
  severity: "warning",
  message: "component is not referenced",
  location: "components.schemas.Order",
  target: {
    pointer: "/components/schemas/Order",
    anchor: "definition",
    source: {
      uri: "order.yaml",
      pointer: "/components/schemas/Order",
      via: [{ uri: "entry.yaml", pointer: "/paths/~1orders/get/responses/200/$ref" }],
    },
  },
};

function span(line: number, offset: number): SourceSpan {
  return {
    start: { line, column: 3, offset },
    end: { line: line + 1, column: 7, offset: offset + 42 },
  };
}

const render = (options: Parameters<typeof renderSarif>[1]): SarifLog =>
  JSON.parse(renderSarif([FINDING], options)) as SarifLog;

const only = (log: SarifLog) => log.runs[0]?.results[0];

describe("renderSarif emits a region only when a caller supplies one", () => {
  it("emits no region key at all with no lookup wired", () => {
    const result = only(render({ base: BASE, classes: ["hygiene"] }));

    expect(result?.locations[0]?.physicalLocation.artifactLocation.uri).toBe("order.yaml");
    expect(result?.locations[0]?.physicalLocation).not.toHaveProperty("region");
    expect(result?.relatedLocations?.[0]?.physicalLocation).not.toHaveProperty("region");
  });

  it("emits no region for an address its lookup cannot answer", () => {
    const result = only(render({ base: BASE, classes: ["hygiene"], spanOf: () => undefined }));

    // The distinction #610 asks for: the location still names the file,
    // so "no position available" does not degrade into "no source".
    expect(result?.locations[0]?.physicalLocation.artifactLocation.uri).toBe("order.yaml");
    expect(result?.locations[0]?.physicalLocation).not.toHaveProperty("region");
  });

  it("renames a span into SARIF's units without converting anything", () => {
    const result = only(render({ base: BASE, classes: ["hygiene"], spanOf: () => span(13, 220) }));

    expect(result?.locations[0]?.physicalLocation.region).toEqual({
      startLine: 13,
      startColumn: 3,
      endLine: 14,
      endColumn: 7,
      charOffset: 220,
      // `end` is exclusive, so the length is the difference.
      charLength: 42,
    });
  });

  it("asks with the address and with each hop, and puts each answer in its own location", () => {
    const asked: string[] = [];
    const result = only(
      render({
        base: BASE,
        classes: ["hygiene"],
        spanOf: (of) => {
          asked.push(`${of.uri}${of.pointer}`);
          return of.uri === "order.yaml" ? span(13, 220) : span(4, 60);
        },
      }),
    );

    // One lookup per location, with the address and the hop, which is
    // what makes a `SpanRequest`-shaped parameter serve both.
    expect(asked).toEqual([
      "entry.yaml/paths/~1orders/get/responses/200/$ref",
      "order.yaml/components/schemas/Order",
    ]);
    expect(result?.locations[0]?.physicalLocation.region?.startLine).toBe(13);
    expect(result?.relatedLocations?.[0]?.physicalLocation.region?.startLine).toBe(4);
  });

  it("emits a region for the hop even where the address has none", () => {
    const result = only(
      render({
        base: BASE,
        classes: ["hygiene"],
        // An entry the caller holds text for, and an external it does not.
        spanOf: (of) => (of.uri === "entry.yaml" ? span(4, 60) : undefined),
      }),
    );

    expect(result?.locations[0]?.physicalLocation).not.toHaveProperty("region");
    expect(result?.relatedLocations?.[0]?.physicalLocation.region?.startLine).toBe(4);
  });

  it("asks nothing about a finding with no source address", () => {
    const asked: string[] = [];
    const log = JSON.parse(
      renderSarif([{ ...FINDING, target: { pointer: "/x", anchor: "node" } }], {
        base: BASE,
        classes: ["hygiene"],
        spanOf: (of) => {
          asked.push(of.uri);
          return span(1, 0);
        },
      }),
    ) as SarifLog;

    expect(asked).toEqual([]);
    expect(only(log)?.locations).toEqual([]);
  });
});

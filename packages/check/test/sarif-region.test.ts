import { describe, expect, it } from "vitest";
import {
  createMemoryReader,
  createSourceSpanResolver,
  loadSpec,
  type SourceSpan,
} from "@oaverify/internal-spec";
import { createJsonSpanBackend, createYamlSpanBackend, parseYamlString } from "@oaverify/syntax";
import type { CheckFinding } from "../src/finding.js";
import { renderSarif } from "../src/sarif.js";
import { checkSpec } from "../src/check.js";
import { spanRequestsFor } from "../src/span-target.js";

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
  runs: {
    columnKind: string;
    results: { locations: SarifLoc[]; relatedLocations?: SarifLoc[] }[];
  }[];
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

it.each(["json", "yaml"] as const)(
  "highlights both conflicting path keys in %s source",
  async (syntax) => {
    const yaml = `openapi: 3.1.0
info: { title: Routes, version: '1' }
paths:
  /a:
    $ref: items.json#/first
  /a/:
    $ref: items.json#/second
`;
    const document = parseYamlString(yaml);
    const text = syntax === "yaml" ? yaml : JSON.stringify(document, null, 2);
    const uri = `entry.${syntax}`;
    const operation = { get: { responses: { "200": { description: "ok" } } } };
    const resolved = await loadSpec({
      entry: uri,
      provenance: true,
      reader: createMemoryReader(
        new Map<string, unknown>([
          [uri, document],
          ["items.json", { first: operation, second: operation }],
        ]),
      ),
    });
    const findings = checkSpec(resolved).filter((f) => f.code === "route-conflict");
    const resolver = createSourceSpanResolver({
      texts: { textFor: (source) => (source === uri ? { text, syntax } : undefined) },
      backends: [createJsonSpanBackend(), createYamlSpanBackend()],
    });
    const requests = spanRequestsFor(findings);
    const spans = resolver.spansFor(requests);
    const log = JSON.parse(
      renderSarif(findings, {
        classes: ["hygiene"],
        spanOf: (request) =>
          spans[
            requests.findIndex(
              (candidate) =>
                candidate.uri === request.uri &&
                candidate.pointer === request.pointer &&
                candidate.want === request.want,
            )
          ],
      }),
    ) as SarifLog;
    const result = only(log)!;
    const locations = [...result.locations, ...result.relatedLocations!];
    expect(locations).toHaveLength(2);
    expect(
      locations.map((location) => {
        expect(location.physicalLocation.artifactLocation.uri).toBe(uri);
        const region = location.physicalLocation.region!;
        return text.slice(region.charOffset, region.charOffset + region.charLength);
      }),
    ).toEqual(syntax === "yaml" ? ["/a/", "/a"] : ['"/a/"', '"/a"']);
  },
);

it.each(["json", "yaml"] as const)(
  "highlights each undeclared required entry in %s source",
  async (syntax) => {
    const yaml = `openapi: 3.1.0
info: { title: Required, version: '1' }
paths: {}
components:
  schemas:
    Summary:
      type: object
      required:
        - id
        - signedDate
        - isActionNeeded
      properties:
        id: { type: string }
`;
    const document = parseYamlString(yaml);
    const text = syntax === "yaml" ? yaml : JSON.stringify(document, null, 2);
    const uri = `entry.${syntax}`;
    const resolved = await loadSpec({
      entry: uri,
      provenance: true,
      reader: createMemoryReader(new Map([[uri, document]])),
    });
    const findings = checkSpec(resolved).filter(
      (f) => f.code === "silent-rewrite/required-not-in-properties",
    );
    const pointers = [
      "/components/schemas/Summary/required/1",
      "/components/schemas/Summary/required/2",
    ];
    expect(findings.map((f) => f.target?.pointer)).toEqual(pointers);
    expect(findings.map((f) => f.target?.source?.pointer)).toEqual(pointers);
    const resolver = createSourceSpanResolver({
      texts: { textFor: (source) => (source === uri ? { text, syntax } : undefined) },
      backends: [createJsonSpanBackend(), createYamlSpanBackend()],
    });
    const log = JSON.parse(
      renderSarif(findings, {
        classes: ["schema"],
        spanOf: (request) => resolver.spansFor([request])[0],
      }),
    ) as SarifLog;
    const highlighted = log.runs[0]!.results.map((result) => {
      const region = result.locations[0]?.physicalLocation.region;
      expect(region).toBeDefined();
      return text.slice(region!.charOffset, region!.charOffset + region!.charLength);
    });
    expect(highlighted).toEqual(
      syntax === "yaml" ? ["signedDate", "isActionNeeded"] : ['"signedDate"', '"isActionNeeded"'],
    );
  },
);

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

describe("renderSarif declares UTF-16 column units", () => {
  it.each([
    { name: "unwired", spanOf: undefined },
    { name: "empty", spanOf: () => undefined },
    { name: "wired", spanOf: () => span(13, 220) },
  ])("declares units with $name span lookup", ({ spanOf }) => {
    const log = render({ base: BASE, classes: ["hygiene"], spanOf });
    expect(log.runs[0]?.columnKind).toBe("utf16CodeUnits");
  });

  it("declares units for findings without source addresses", () => {
    const log = JSON.parse(
      renderSarif([{ ...FINDING, target: undefined }], { classes: ["hygiene"] }),
    ) as SarifLog;
    expect(log.runs[0]?.columnKind).toBe("utf16CodeUnits");
    expect(only(log)?.locations).toEqual([]);
  });

  it("declares units for an empty run", () => {
    const log = JSON.parse(renderSarif([], { classes: ["hygiene"] })) as SarifLog;
    expect(log.runs[0]?.columnKind).toBe("utf16CodeUnits");
    expect(log.runs[0]?.results).toEqual([]);
  });

  it("preserves source positions after an astral character", () => {
    const text = '{"emoji":"😀","components":{"schemas":{"Order":false}}}';
    const resolver = createSourceSpanResolver({
      texts: { textFor: () => ({ text, syntax: "json" }) },
      backends: [createJsonSpanBackend()],
    });
    const log = render({
      base: BASE,
      classes: ["hygiene"],
      spanOf: (request) => resolver.spansFor([request])[0],
    });
    const offset = text.indexOf('"Order"');
    expect(log.runs[0]?.columnKind).toBe("utf16CodeUnits");
    expect(only(log)?.locations[0]?.physicalLocation.region).toEqual({
      startLine: 1,
      startColumn: offset + 1,
      endLine: 1,
      endColumn: offset + 8,
      charOffset: offset,
      charLength: 7,
    });
  });
});

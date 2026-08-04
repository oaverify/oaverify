import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { createMemoryReader, loadSpec } from "@oaverify/internal-spec";
import { checkSpec } from "../src/check.js";
import type { CheckFinding } from "../src/finding.js";
import { artifactLocation, renderSarif } from "../src/sarif.js";

const BASE = "/repo";

/** Only the parts these tests read; the whole log is validated against
 * the published SARIF schema separately (see the PR). */
interface SarifArtifact {
  uri: string;
  uriBaseId?: string;
}
interface SarifLoc {
  physicalLocation: { artifactLocation: SarifArtifact };
  message?: { text: string };
}
interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: string;
  message: { text: string };
  locations: SarifLoc[];
  relatedLocations?: SarifLoc[];
  codeFlows?: unknown;
  partialFingerprints: Record<string, string>;
  properties: Record<string, unknown>;
}
interface SarifLog {
  version: string;
  $schema: string;
  runs: {
    tool: { driver: { name: string; version: string; rules: { id: string }[] } };
    properties: Record<string, unknown>;
    results: SarifResult[];
  }[];
}

const render = (findings: CheckFinding[]): SarifLog =>
  JSON.parse(
    renderSarif(findings, { version: "9.9.9", base: BASE, classes: ["schema"] }),
  ) as SarifLog;

const finding = (over: Partial<CheckFinding> = {}): CheckFinding => ({
  class: "schema",
  severity: "warning",
  code: "unsatisfiable/pattern-length",
  location: "POST /x request body",
  message: "no string validates here",
  target: {
    pointer: "/components/schemas/X_a1b2/pattern",
    anchor: "definition",
    source: {
      uri: "schemas/x.yaml",
      pointer: "/pattern",
      via: [{ uri: "openapi.yaml", pointer: "/paths/~1x/post" }],
    },
  },
  ...over,
});

describe("the log envelope", () => {
  it("declares 2.1.0 and names the tool and its version", () => {
    const log = render([finding()]);
    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toContain("sarif-schema-2.1.0");
    expect(log.runs[0]?.tool.driver.name).toBe("oaverify");
    expect(log.runs[0]?.tool.driver.version).toBe("9.9.9");
  });

  it("records which classes ran, so a partial run is not read as a clean one", () => {
    const log = render([]);
    expect(log.runs[0]?.properties["oaverify:classes"]).toEqual(["schema"]);
    expect(log.runs[0]?.results).toEqual([]);
  });

  it("derives rule metadata from the findings, once per code", () => {
    const log = render([finding(), finding(), finding({ code: "unknown-keyword" })]);
    expect(log.runs[0]?.tool.driver.rules.map((r) => r.id)).toEqual([
      "unsatisfiable/pattern-length",
      "unknown-keyword",
    ]);
    expect(log.runs[0]?.results.map((r) => r.ruleIndex)).toEqual([0, 0, 1]);
  });
});

describe("level, which is where fatal has nowhere to go", () => {
  it("maps warning and error directly", () => {
    expect(render([finding({ severity: "warning" })]).runs[0]?.results[0]?.level).toBe("warning");
    expect(render([finding({ severity: "error" })]).runs[0]?.results[0]?.level).toBe("error");
  });

  it("collapses fatal to error and keeps it in properties", () => {
    // SARIF has no `fatal`. Losing the distinction entirely would be
    // worse than collapsing it, so it survives where a consumer can
    // read it back.
    const result = render([finding({ severity: "fatal" })]).runs[0]?.results[0];
    expect(result?.level).toBe("error");
    expect(result?.properties["oaverify:severity"]).toBe("fatal");
  });
});

describe("locations come from the source file, never the resolved pointer", () => {
  it("anchors the result at the file the author wrote", () => {
    // `target.pointer` names `X_a1b2`, a position no file contains.
    const result = render([finding()]).runs[0]?.results[0];
    expect(result?.locations[0]?.physicalLocation.artifactLocation).toEqual({
      uri: "schemas/x.yaml",
      uriBaseId: "%SRCROOT%",
    });
    // Kept, but as data rather than as a place on disk.
    expect(result?.properties["oaverify:pointer"]).toBe("/components/schemas/X_a1b2/pattern");
  });

  it("emits no location at all when no source corresponds", () => {
    // An overlay-added node has no position in any file. Attributing it
    // to the entry document would be a guess.
    const result = render([finding({ target: { pointer: "/x", anchor: "node" } })]).runs[0]
      ?.results[0];
    expect(result?.locations).toEqual([]);
    expect(result?.properties["oaverify:pointer"]).toBe("/x");
  });

  it("carries the reference chain as relatedLocations, not a code flow", () => {
    // `via` is the resolver's route to the document, not the route this
    // finding took, so it cannot claim to be a path taken.
    const result = render([finding()]).runs[0]?.results[0];
    expect(result?.relatedLocations).toHaveLength(1);
    const hop = result?.relatedLocations?.[0];
    expect(hop?.physicalLocation.artifactLocation.uri).toBe("openapi.yaml");
    expect(hop?.message?.text).toContain("/paths/~1x/post");
    expect(result?.codeFlows).toBeUndefined();
  });

  it("omits relatedLocations entirely when the chain is empty", () => {
    const single = finding();
    single.target = { ...single.target!, source: { uri: "openapi.yaml", pointer: "/x", via: [] } };
    expect(render([single]).runs[0]?.results[0]?.relatedLocations).toBeUndefined();
  });
});

describe("artifactLocation", () => {
  it("relativises a path under the base and declares %SRCROOT%", () => {
    expect(artifactLocation("schemas/x.yaml", BASE)).toEqual({
      uri: "schemas/x.yaml",
      uriBaseId: "%SRCROOT%",
    });
    expect(artifactLocation("/repo/schemas/x.yaml", BASE)).toEqual({
      uri: "schemas/x.yaml",
      uriBaseId: "%SRCROOT%",
    });
  });

  it("uses an absolute file URL for a path outside the base", () => {
    // A `../` traversal is rejected by code scanning, so the honest
    // answer is an absolute URI with no base and no diff annotation.
    expect(artifactLocation("/elsewhere/x.yaml", BASE)).toEqual({
      uri: pathToFileURL("/elsewhere/x.yaml").href,
    });
  });

  it("passes an http spec through with no base", () => {
    expect(artifactLocation("https://example.com/openapi.yaml", BASE)).toEqual({
      uri: "https://example.com/openapi.yaml",
    });
  });

  it("accepts a file: URL as input", () => {
    expect(artifactLocation("file:///repo/schemas/x.yaml", BASE)).toEqual({
      uri: "schemas/x.yaml",
      uriBaseId: "%SRCROOT%",
    });
  });
});

describe("partialFingerprints", () => {
  it("keys on the code and the source address, not on file content", () => {
    // The default keys on the line's text, which churns on reformatting
    // and on the file moving. This survives both.
    const result = render([finding()]).runs[0]?.results[0];
    expect(result?.partialFingerprints.oaverifyFindingV1).toBe(
      "unsatisfiable/pattern-length schemas/x.yaml/pattern",
    );
  });

  it("falls back to the resolved pointer, then the message", () => {
    const noSource = render([finding({ target: { pointer: "/x", anchor: "node" } })]).runs[0]
      ?.results[0];
    expect(noSource?.partialFingerprints.oaverifyFindingV1).toBe("unsatisfiable/pattern-length /x");

    const noTarget = render([finding({ target: undefined })]).runs[0]?.results[0];
    expect(noTarget?.partialFingerprints.oaverifyFindingV1).toContain("no string validates here");
  });
});

describe("properties", () => {
  it("carries the class, the anchor and the occurrence count", () => {
    const result = render([finding({ occurrences: 4 })]).runs[0]?.results[0];
    expect(result?.properties["oaverify:class"]).toBe("schema");
    expect(result?.properties["oaverify:anchor"]).toBe("definition");
    expect(result?.properties["oaverify:sourcePointer"]).toBe("/pattern");
    // SARIF has no count on a result, so one result plus the number
    // matches what the text and JSON renderers already do.
    expect(result?.properties["oaverify:occurrences"]).toBe(4);
  });

  it("omits occurrences when a defect was reported once", () => {
    expect(render([finding()]).runs[0]?.results[0]?.properties).not.toHaveProperty(
      "oaverify:occurrences",
    );
  });
});

// Locations come from `target.source` alone, so whether a SARIF run can
// annotate a file is decided by how the spec was loaded, not by the
// findings. Both halves are pinned: without provenance every result is
// still a complete result and simply has nowhere on disk to point.
describe("locations track the spec's provenance", () => {
  const spec: Array<[string, unknown]> = [
    [
      "entry.json",
      {
        openapi: "3.1.0",
        info: { title: "t", version: "1.0.0" },
        paths: { "/t": { get: { responses: { "200": { description: "ok" } } } } },
        components: { schemas: { Orphan: { type: "object" } } },
      },
    ],
  ];

  const runWith = async (provenance: boolean): Promise<Record<string, unknown>> => {
    const resolved = await loadSpec({
      reader: createMemoryReader(new Map(spec)),
      entry: "entry.json",
      ...(provenance && { provenance: true }),
    });
    const findings = checkSpec(resolved, { only: ["hygiene"] });
    expect(findings.length).toBeGreaterThan(0);
    return JSON.parse(
      renderSarif(findings, { version: "1.2.3", base: "/repo", classes: ["hygiene"] }),
    ) as Record<string, unknown>;
  };

  const resultsOf = (log: Record<string, unknown>): Array<Record<string, unknown>> =>
    (log["runs"] as Array<Record<string, unknown>>)[0]!["results"] as Array<
      Record<string, unknown>
    >;

  it("carries a physicalLocation when the spec was loaded with provenance", async () => {
    const results = resultsOf(await runWith(true));
    expect(results[0]?.["locations"]).toEqual([
      {
        physicalLocation: {
          artifactLocation: expect.objectContaining({ uri: expect.any(String) }),
        },
      },
    ]);
  });

  it("emits an empty locations array without it, and a complete result otherwise", async () => {
    const results = resultsOf(await runWith(false));
    expect(results[0]?.["locations"]).toEqual([]);
    // The result is not degraded beyond the location: a consumer reading
    // rules and severities gets everything it would have got.
    expect(results[0]?.["ruleId"]).toBe("unused-component");
    expect(results[0]?.["level"]).toBe("warning");
    expect(results[0]?.["message"]).toEqual({ text: expect.any(String) });
    expect(results[0]?.["partialFingerprints"]).toEqual({
      oaverifyFindingV1: expect.any(String),
    });
  });
});

// A library caller that does not care about tool metadata should not
// have to invent it. The CLI still passes its own values. `classes`
// has no default, because the log asserts it as `oaverify:classes`
// and a guess of all five would label a partial run complete.
describe("option defaults for a caller that supplies only classes", () => {
  const finding: CheckFinding = {
    class: "hygiene",
    severity: "warning",
    code: "unused-component",
    location: "/components/schemas/Orphan",
    message: "declared but unreached",
  };

  it("names the tool 0.0.0 and asserts the classes it was given, sorted", () => {
    const log = JSON.parse(renderSarif([finding], { classes: ["redos", "hygiene"] })) as Record<
      string,
      unknown
    >;
    const run = (log["runs"] as Array<Record<string, unknown>>)[0]!;
    const driver = (run["tool"] as Record<string, Record<string, unknown>>)["driver"]!;
    expect(driver["version"]).toBe("0.0.0");
    expect((run["properties"] as Record<string, unknown>)["oaverify:classes"]).toEqual([
      "hygiene",
      "redos",
    ]);
  });
});

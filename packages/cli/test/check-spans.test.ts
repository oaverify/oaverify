import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeReaders } from "@oaverify/internal-spec";
import { createYamlFileReader } from "@oaverify/syntax";
import { checkCommand, defaultCommandIo, type CommandIo } from "../src/commands.js";

/**
 * `oaverify check --format sarif` end to end, with a region (#610).
 *
 * The claim under test is that a location's region names the same text
 * the location's file does. Asserted by slicing the file with the
 * region's own offsets, which fails if either the offsets or the file
 * attribution is wrong, where a line number alone could be right about
 * the wrong file.
 */

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
    results: {
      ruleId: string;
      locations: SarifLoc[];
      relatedLocations?: SarifLoc[];
      properties: Record<string, unknown>;
    }[];
  }[];
}

/** A spec with an unused component, in both syntaxes. */
const YAML_SPEC = `openapi: 3.1.0
info:
  title: Widgets
  version: "1"
paths:
  /orders/{id}:
    get:
      responses:
        "200":
          description: ok
components:
  schemas:
    Unused:
      type: object
`;

const JSON_SPEC = `{
  "openapi": "3.1.0",
  "info": { "title": "Widgets", "version": "1" },
  "paths": {
    "/orders/{id}": {
      "get": { "responses": { "200": { "description": "ok" } } }
    }
  },
  "components": {
    "schemas": {
      "Unused": { "type": "object" }
    }
  }
}
`;

describe("check --format sarif carries a region", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oav-cli-span-"));
    writeFileSync(join(dir, "spec.yaml"), YAML_SPEC);
    writeFileSync(join(dir, "spec.json"), JSON_SPEC);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The real filesystem IO, with stdout captured. */
  const captureIo = (over: Partial<CommandIo> = {}) => {
    const out: string[] = [];
    const base = defaultCommandIo();
    const io: CommandIo = {
      ...base,
      // `@oaverify/core` parses JSON only, so the YAML reader composes
      // ahead of the default chain, the way `packages/oav` does for the
      // shipped binary.
      reader: (policy) => composeReaders([createYamlFileReader(), base.reader(policy)]),
      stdout: (chunk) => out.push(chunk),
      stderr: (chunk) => out.push(chunk),
      ...over,
    };
    return { io, out };
  };

  const run = async (file: string, format: "sarif" | "json" = "sarif") => {
    const { io, out } = captureIo();
    const result = await checkCommand(
      { spec: join(dir, file), format, cwd: dir, overlays: [], options: { quiet: false } },
      io,
    );
    return { result, out: out.join("") };
  };

  const resultsOf = (out: string) => (JSON.parse(out) as SarifLog).runs[0]?.results ?? [];

  it.each([
    // `unused-component` is about the name, so the region covers the
    // key rather than the schema under it. Both syntaxes land on the
    // line the name is written on. See `spanTargetFor` for which codes
    // ask for a key and what happens where a node has none.
    { file: "spec.yaml", text: YAML_SPEC, expected: "Unused", keyLineOffset: 0 },
    { file: "spec.json", text: JSON_SPEC, expected: '"Unused"', keyLineOffset: 0 },
  ])(
    "addresses the node the author wrote in $file",
    async ({ file, text, expected, keyLineOffset }) => {
      const { out } = await run(file);
      const results = resultsOf(out);
      expect(results.length).toBeGreaterThan(0);

      const unused = results.find((r) => r.ruleId === "unused-component");
      const region = unused?.locations[0]?.physicalLocation.region;
      expect(region).toBeDefined();

      // The region and the file it names agree: slicing the file the
      // location names, at the offsets the region gives, is the node. A
      // line number alone could be right about the wrong file.
      const onDisk = readFileSync(join(dir, file), "utf8");
      const sliced = onDisk.slice(
        region?.charOffset,
        (region?.charOffset ?? 0) + (region?.charLength ?? 0),
      );
      expect(sliced.trim()).toBe(expected);

      const keyLine = text.slice(0, text.indexOf("Unused")).split("\n").length;
      expect(region?.startLine).toBe(keyLine + keyLineOffset);
      expect(region?.endLine).toBeGreaterThanOrEqual(region?.startLine ?? 0);
    },
  );

  it("emits no region for a document it cannot re-read", async () => {
    // The file is gone by the time the log is rendered, which is the
    // same shape as stdin and HTTP: no text, so no region, and the
    // location still names the file.
    const spec = join(dir, "spec.yaml");
    const real = defaultCommandIo();
    const { io, out } = captureIo({
      readText: (path) => (path === spec ? Promise.reject(new Error("gone")) : real.readText(path)),
    });
    await checkCommand(
      { spec, format: "sarif", cwd: dir, overlays: [], options: { quiet: false } },
      io,
    );

    const results = resultsOf(out.join(""));
    const unused = results.find((r) => r.ruleId === "unused-component");
    expect(unused?.locations[0]?.physicalLocation.artifactLocation.uri).toBeDefined();
    expect(unused?.locations[0]?.physicalLocation).not.toHaveProperty("region");
  });

  it("leaves the json format untouched, since it has nowhere to put a region", async () => {
    const { out } = await run("spec.yaml", "json");
    expect(out).not.toContain("region");
    expect(out).toContain("unused-component");
  });
});

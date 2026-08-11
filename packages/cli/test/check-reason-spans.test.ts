import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeReaders } from "@oaverify/internal-spec";
import { createYamlFileReader } from "@oaverify/syntax";
import { checkCommand, defaultCommandIo, type CommandIo } from "../src/commands.js";

/**
 * `oaverify check --format sarif` end to end, with one located item per
 * sub-rejection of an invalid example (#773).
 *
 * `packages/check/test/sarif-reasons.test.ts` pins the policy against a
 * lookup that answers whatever it is asked. This file is the half that
 * cannot be faked: the pointers meet a real parser, over both syntaxes,
 * across a file boundary, and every region is checked by slicing the
 * file it names at its own offsets. A pointer that is subtly wrong comes
 * back with no span or with somebody else's text, and neither shows up
 * in a test that supplies its own spans.
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
  id?: number;
  physicalLocation: { artifactLocation: { uri: string }; region?: SarifRegion };
  message?: { text: string };
  properties?: Record<string, unknown>;
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

/**
 * One schema and one example that fails it four ways: a leaf of the
 * wrong type, a nested object missing a required member, a failure
 * inside an array element, and a property whose name needs pointer
 * escaping.
 */
const JSON_SPEC = `{
  "openapi": "3.1.0",
  "info": { "title": "Orders", "version": "1" },
  "paths": {
    "/orders": {
      "get": {
        "responses": {
          "200": {
            "description": "ok",
            "content": {
              "application/json": {
                "schema": { "$ref": "#/components/schemas/Order" },
                "examples": {
                  "one": {
                    "value": {
                      "id": "not-an-integer",
                      "customer": { "name": "Ada" },
                      "items": [{ "price": "free" }],
                      "a/b": 7
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "Order": {
        "type": "object",
        "required": ["id", "customer"],
        "properties": {
          "id": { "type": "integer" },
          "customer": {
            "type": "object",
            "required": ["name", "email"],
            "properties": { "name": { "type": "string" }, "email": { "type": "string" } }
          },
          "items": {
            "type": "array",
            "items": { "type": "object", "properties": { "price": { "type": "number" } } }
          },
          "a/b": { "type": "string" }
        }
      }
    }
  }
}
`;

/** The same document in YAML, so both span backends are exercised. */
const YAML_SPEC = `openapi: 3.1.0
info:
  title: Orders
  version: "1"
paths:
  /orders:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Order"
              examples:
                one:
                  value:
                    id: not-an-integer
                    customer:
                      name: Ada
                    items:
                      - price: free
                    a/b: 7
components:
  schemas:
    Order:
      type: object
      required: [id, customer]
      properties:
        id:
          type: integer
        customer:
          type: object
          required: [name, email]
          properties:
            name:
              type: string
            email:
              type: string
        items:
          type: array
          items:
            type: object
            properties:
              price:
                type: number
        a/b:
          type: string
`;

/**
 * An example value assembled by a YAML alias. The value the checker
 * grades holds `price: free`; the text at that position is `*shared`,
 * and the property is written somewhere else entirely.
 *
 * This is the one shape that can produce a reason whose position is not
 * in the file and whose code is not `required`, which is the case the
 * `reasonTargetFor` table deliberately does not answer. What the test
 * pins is that the answer is an absence.
 */
const YAML_ALIAS_SPEC = `openapi: 3.1.0
info:
  title: Orders
  version: "1"
x-defaults: &shared
  price: free
paths:
  /orders:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  item:
                    type: object
                    properties:
                      price:
                        type: number
              examples:
                one:
                  value:
                    item: *shared
`;

/** Entry plus a second file holding the response, so `via` is non-empty. */
const MULTI_ENTRY = `{
  "openapi": "3.1.0",
  "info": { "title": "Orders", "version": "1" },
  "paths": {
    "/orders": {
      "get": { "responses": { "200": { "$ref": "shared.json#/components/responses/Ok" } } }
    }
  }
}
`;

const MULTI_SHARED = `{
  "components": {
    "responses": {
      "Ok": {
        "description": "ok",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "required": ["id"],
              "properties": {
                "id": { "type": "integer" },
                "customer": {
                  "type": "object",
                  "required": ["email"],
                  "properties": { "email": { "type": "string" } }
                }
              }
            },
            "examples": {
              "one": { "value": { "id": "nope", "customer": { "name": "Ada" } } }
            }
          }
        }
      }
    }
  }
}
`;

describe("check --format sarif locates each sub-rejection", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oav-cli-reason-span-"));
    writeFileSync(join(dir, "spec.json"), JSON_SPEC);
    writeFileSync(join(dir, "spec.yaml"), YAML_SPEC);
    writeFileSync(join(dir, "alias.yaml"), YAML_ALIAS_SPEC);
    writeFileSync(join(dir, "entry.json"), MULTI_ENTRY);
    writeFileSync(join(dir, "shared.json"), MULTI_SHARED);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (file: string) => {
    const out: string[] = [];
    const base = defaultCommandIo();
    const io: CommandIo = {
      ...base,
      reader: (policy) => composeReaders([createYamlFileReader(), base.reader(policy)]),
      stdout: (chunk) => out.push(chunk),
      stderr: (chunk) => out.push(chunk),
    };
    await checkCommand(
      { spec: join(dir, file), format: "sarif", cwd: dir, overlays: [], options: { quiet: false } },
      io,
    );
    const log = JSON.parse(out.join("")) as SarifLog;
    const result = (log.runs[0]?.results ?? []).find((r) => r.ruleId === "example-invalid");
    const related = result?.relatedLocations ?? [];
    return {
      result,
      related,
      reasons: related.filter((l) => l.properties?.["oaverify:kind"] === "reason"),
      via: related.filter((l) => l.properties?.["oaverify:kind"] === "via"),
    };
  };

  /** What the region actually covers, read out of the file it names. */
  const sliced = (file: string, loc: SarifLoc | undefined): string => {
    const region = loc?.physicalLocation.region;
    expect(region).toBeDefined();
    const text = readFileSync(
      join(dir, loc?.physicalLocation.artifactLocation.uri ?? file),
      "utf8",
    );
    return text.slice(region?.charOffset, (region?.charOffset ?? 0) + (region?.charLength ?? 0));
  };

  const byPath = (items: SarifLoc[], path: readonly (string | number)[]) =>
    items.find(
      (l) => JSON.stringify(l.properties?.["oaverify:reasonPath"]) === JSON.stringify(path),
    );

  it.each(["spec.json", "spec.yaml"])(
    "names the text the author wrote, in %s (row 14)",
    async (file) => {
      const { reasons } = await run(file);

      // Four sub-rejections, four positions. The two `type` leaves and the
      // escaped name address their own values; the missing `email`
      // addresses the object that should have held it.
      expect(reasons.length).toBe(4);

      expect(sliced(file, byPath(reasons, ["id"]))).toContain("not-an-integer");
      expect(sliced(file, byPath(reasons, ["items", 0, "price"]))).toContain("free");
      expect(sliced(file, byPath(reasons, ["a/b"]))).toContain("7");

      // The container case, against a real file: the region covers the
      // `customer` object, and `email` appears nowhere inside it.
      const missing = byPath(reasons, ["customer", "email"]);
      expect(missing?.properties?.["oaverify:at"]).toBe("container");
      const customer = sliced(file, missing);
      expect(customer).toContain("Ada");
      expect(customer).not.toContain("email");
    },
  );

  it.each(["spec.json", "spec.yaml"])(
    "narrows each item to less than the whole example, in %s (rows 2 and 3)",
    async (file) => {
      const { result, reasons } = await run(file);
      // The point of the exercise: an editor squiggles the offending
      // value rather than the whole example the primary location covers.
      const example = result?.locations[0]?.physicalLocation.region;
      expect(example).toBeDefined();
      for (const item of reasons) {
        const region = item.physicalLocation.region;
        expect(region?.charLength).toBeLessThan(example?.charLength ?? 0);
        // And inside it, so an item never wanders out of the example it
        // is a sub-rejection of.
        expect(region?.charOffset).toBeGreaterThanOrEqual(example?.charOffset ?? 0);
      }
      expect(byPath(reasons, ["items", 0, "price"])?.properties?.["oaverify:at"]).toBe("self");
    },
  );

  it("carries via hops and reason items in one array, told apart by kind (row 9)", async () => {
    const { result, related, via, reasons } = await run("entry.json");

    // The example lives in the second file and the resolver crossed a
    // reference to reach it, so both kinds are present at once. This is
    // the case the real-world corpus does not contain.
    expect(via.length).toBeGreaterThan(0);
    expect(reasons.length).toBe(2);
    expect(related.map((l) => l.properties?.["oaverify:kind"])).toEqual([
      ...via.map(() => "via"),
      "reason",
      "reason",
    ]);

    // Ids are unique across both kinds, which is what SARIF asks of
    // them, and what lets message text reference one.
    expect(new Set(related.map((l) => l.id)).size).toBe(related.length);

    // One of each semantics in the same result.
    expect(byPath(reasons, ["id"])?.properties?.["oaverify:at"]).toBe("self");
    expect(byPath(reasons, ["customer", "email"])?.properties?.["oaverify:at"]).toBe("container");

    // The hops address the entry file and the reasons address the file
    // the example is written in. Conflating the two is the failure this
    // whole arrangement is guarding against.
    expect(via[0]?.physicalLocation.artifactLocation.uri).toBe("entry.json");
    for (const item of reasons) {
      expect(item.physicalLocation.artifactLocation.uri).toBe("shared.json");
    }
    expect(result?.locations[0]?.physicalLocation.artifactLocation.uri).toBe("shared.json");

    // Unchanged, so a reader with tooling keyed to the sentence keeps it.
    expect(via[0]?.message?.text).toMatch(
      /^reference 1 of \d+ the resolver followed to reach this document: /,
    );
  });

  it("emits no located item for a position a YAML alias moved", async () => {
    const { result, reasons } = await run("alias.yaml");

    // The finding is unaffected: it is reported, it keeps its own
    // location, and its structured causes are complete.
    expect(result).toBeDefined();
    expect(result?.locations[0]?.physicalLocation.region).toBeDefined();
    expect(result?.properties["oaverify:reasons"]).toHaveLength(1);

    // The sub-rejection is at `item.price`, and the text at that
    // position is an alias rather than a mapping, so no span answers for
    // it. An absence, not a walk up to `item`: the code is `type`, and
    // nothing licences moving it.
    expect(reasons).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { createMemoryReader, loadSpec } from "@oaverify/internal-spec";
import { createValidator } from "@oaverify/internal-validator";
import { emitSpec } from "../../cli/src/emit-spec.js";
import { checkSpec } from "../src/check.js";

const unserved = { name: "q", in: "querystring", content: { "text/plain": { schema: {} } } };
const operation = { responses: { "200": { description: "ok" } } };

async function resolveChain(mid: object, final: object) {
  return loadSpec({
    entry: "entry.json",
    provenance: true,
    reader: createMemoryReader(
      new Map([
        [
          "entry.json",
          {
            openapi: "3.2.0",
            info: { title: "t", version: "1" },
            paths: { "/p": { $ref: "#/x-items/First" } },
            "x-items": {
              First: { $ref: "#/x-items/Mid%20item" },
              "Mid item": { $ref: "#/x-items/Final", ...mid },
              Final: final,
            },
          },
        ],
      ]),
    ),
  });
}

describe("unserved parameter findings use effective Path Item fields (#1290)", () => {
  it.each([
    [{ parameters: [unserved] }, { get: operation }, ["/x-items/Mid item/parameters/0"]],
    [
      { get: operation },
      { parameters: [unserved], post: operation },
      ["/x-items/Final/parameters/0"],
    ],
    [
      { get: { ...operation, parameters: [unserved] } },
      { post: operation },
      ["/x-items/Mid item/get/parameters/0"],
    ],
    [
      { get: operation },
      { post: { ...operation, parameters: [unserved] } },
      ["/x-items/Final/post/parameters/0"],
    ],
    [
      { parameters: [unserved], get: operation },
      { post: { ...operation, parameters: [unserved] } },
      ["/x-items/Mid item/parameters/0", "/x-items/Final/post/parameters/0"],
    ],
  ] as const)("reports the winning field at its actual hop: %j", async (mid, final, pointers) => {
    const resolved = await resolveChain(mid, final);
    const findings = checkSpec(resolved).filter((f) => f.code === "unserved-parameter-location");
    expect(findings.map((f) => f.location)).toEqual(pointers);
    expect(findings.map((f) => f.target?.pointer)).toEqual(pointers);
    expect(findings.map((f) => f.target?.source?.pointer)).toEqual(pointers);
    expect(findings.every((f) => f.target?.anchor === "scoped-definition")).toBe(true);
    expect(() => emitSpec(resolved.document)).toThrow(/querystring/);
    expect(() => createValidator(resolved.document)).not.toThrow();
  });

  it.each([
    [
      { parameters: [], get: operation },
      { parameters: [unserved], post: operation },
    ],
    [
      { parameters: [{ name: "served", in: "query", schema: {} }] },
      { parameters: [unserved], get: operation },
    ],
    [{ get: operation }, { get: { ...operation, parameters: [unserved] } }],
  ])("skips shadowed declarations: %j", async (mid, final) => {
    const resolved = await resolveChain(mid, final);
    expect(checkSpec(resolved).filter((f) => f.code === "unserved-parameter-location")).toEqual([]);
    expect(() => emitSpec(resolved.document)).not.toThrow();
  });
});

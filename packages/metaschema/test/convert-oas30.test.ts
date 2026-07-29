import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = new URL("../scripts/convert-oas30.mjs", import.meta.url).pathname;
const UPSTREAM = new URL("../scripts/oas-3.0-upstream.json", import.meta.url).pathname;
const VENDORED = new URL("../src/vendor/oas-3.0.json", import.meta.url).pathname;

const scratch = mkdtempSync(join(tmpdir(), "oav-convert-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Run the transform over `doc`, returning the converted document. */
function convert(doc: unknown): Record<string, unknown> {
  const inPath = join(scratch, `in-${Math.random().toString(36).slice(2)}.json`);
  const outPath = `${inPath}.out`;
  writeFileSync(inPath, JSON.stringify(doc));
  execFileSync(process.execPath, [SCRIPT, inPath, outPath], { stdio: "pipe" });
  return JSON.parse(readFileSync(outPath, "utf8"));
}

/** Run the transform expecting it to refuse. Returns stderr. */
function convertExpectingFailure(doc: unknown): string {
  const inPath = join(scratch, `bad-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(inPath, JSON.stringify(doc));
  try {
    execFileSync(process.execPath, [SCRIPT, inPath, `${inPath}.out`], { stdio: "pipe" });
  } catch (err) {
    return String((err as { stderr?: Buffer }).stderr ?? "");
  }
  throw new Error("expected the transform to refuse this document");
}

describe("convert-oas30: the draft-04 translation", () => {
  it("renames the draft-04 identifier", () => {
    const out = convert({ id: "https://example.test/s", $schema: "x" });
    expect(out["$id"]).toBe("https://example.test/s");
    expect(out["id"]).toBeUndefined();
  });

  it("declares the dialect the compiler actually implements", () => {
    const out = convert({ $schema: "http://json-schema.org/draft-04/schema#" });
    expect(out["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("converts a draft-04 exclusive bound to the 2020-12 numeric form", () => {
    // draft-04: `exclusiveMinimum: true` modifies a sibling `minimum`.
    // 2020-12: `exclusiveMinimum` *is* the bound.
    const out = convert({
      properties: { n: { type: "number", minimum: 0, exclusiveMinimum: true } },
    });
    const n = (out["properties"] as Record<string, Record<string, unknown>>)["n"]!;
    expect(n["exclusiveMinimum"]).toBe(0);
    expect(n["minimum"]).toBeUndefined();
  });
});

describe("convert-oas30: schema versus data", () => {
  // The regression this file exists for. The OAS 3.0 document does two
  // things at once: it *is* a schema, and it *describes* OpenAPI's own
  // Schema Object, which has boolean `exclusiveMinimum` /
  // `exclusiveMaximum` fields of its own. A transform that rewrites
  // every boolean `exclusiveMinimum` corrupts those descriptions into
  // numeric bounds, and the corruption sits in a branch ordinary
  // fixtures never reach, so it would not surface as a test failure.
  //
  // The discriminator is a sibling numeric `minimum`: that marks a
  // keyword in use. A `type: boolean` node is a field description.

  it("leaves OpenAPI's own boolean exclusiveMinimum field alone", () => {
    const out = convert({
      properties: {
        exclusiveMinimum: { type: "boolean", default: false },
        exclusiveMaximum: { type: "boolean", default: false },
      },
    });
    const props = out["properties"] as Record<string, Record<string, unknown>>;
    expect(props["exclusiveMinimum"]).toEqual({ type: "boolean", default: false });
    expect(props["exclusiveMaximum"]).toEqual({ type: "boolean", default: false });
  });

  it("survives the real document: the described fields keep their boolean type", () => {
    const vendored = JSON.parse(readFileSync(VENDORED, "utf8")) as {
      definitions: { Schema: { properties: Record<string, { type?: string }> } };
    };
    const props = vendored.definitions.Schema.properties;
    expect(props["exclusiveMinimum"]?.type).toBe("boolean");
    expect(props["exclusiveMaximum"]?.type).toBe("boolean");
  });

  it("still converts the real document's one genuine keyword use", () => {
    const vendored = JSON.parse(readFileSync(VENDORED, "utf8")) as {
      definitions: { Schema: { properties: Record<string, Record<string, unknown>> } };
    };
    const multipleOf = vendored.definitions.Schema.properties["multipleOf"]!;
    expect(multipleOf["exclusiveMinimum"]).toBe(0);
    expect(multipleOf["minimum"]).toBeUndefined();
  });
});

describe("convert-oas30: refusing what it does not understand", () => {
  // Silence on an unhandled construct would mean shipping a schema
  // nobody read. Each of these changes meaning or disappears in
  // 2020-12, so encountering one means the transform is no longer
  // sufficient for the upstream document.

  it("refuses array-form items", () => {
    expect(convertExpectingFailure({ properties: { a: { items: [{ type: "string" }] } } })).toMatch(
      /array-form items/,
    );
  });

  it("refuses dependencies", () => {
    expect(convertExpectingFailure({ dependencies: { a: ["b"] } })).toMatch(/dependencies/);
  });

  it("refuses additionalItems", () => {
    expect(convertExpectingFailure({ additionalItems: false })).toMatch(/additionalItems/);
  });

  it("refuses a boolean exclusive bound with no numeric sibling to attach to", () => {
    // Neither a keyword use (no sibling `minimum`) nor a field
    // description (not `type: boolean`). Ambiguous, so it stops.
    expect(convertExpectingFailure({ properties: { a: { exclusiveMinimum: true } } })).toMatch(
      /unpaired boolean exclusiveMinimum/,
    );
  });
});

describe("convert-oas30: reproducibility", () => {
  it("regenerates the checked-in file byte for byte", () => {
    // The vendored schema is a build product of a checked-in input and
    // a checked-in script. If this drifts, someone hand-edited the
    // output, and the property that makes this route trustworthy (the
    // rules come from OpenAPI, not from us) is gone.
    const out = join(scratch, "regenerated.json");
    execFileSync(process.execPath, [SCRIPT, UPSTREAM, out], { stdio: "pipe" });
    expect(readFileSync(out, "utf8")).toBe(readFileSync(VENDORED, "utf8"));
  });
});

import { describe, expect, it } from "vitest";
import { resolveSpec, type DocumentReader } from "@oaverify/internal-spec";
import { checkSpec, CheckAbortedError } from "../src/check.js";
import { selectionForClasses } from "../src/selection.js";
import type { CheckFinding } from "../src/finding.js";

/**
 * Which findings survive a document that is missing pieces.
 *
 * The model. An incomplete document is not one document, it is the set
 * of every document you could get by filling its holes. A finding is
 * trustworthy exactly when it holds for every member of that set, so
 * the question per finding is whether supplying what is missing could
 * make it go away. A finding that could is an artefact of the failure:
 * it is what an editor would draw, and what a reader would then go
 * looking for and not find.
 *
 * The test. Run the same document twice, once with every file readable
 * and once with one file unreadable, and compare. A finding the holed
 * run produces and the whole run does not is an artefact. That is a
 * sampled check of the model rather than a proof of it: it asks whether
 * *this* filling removes the finding, and the model asks whether *any*
 * filling does. A code this suite clears is therefore not proved
 * monotone, it is un-refuted, and a code it catches is refuted by a
 * witness.
 */

const info = { title: "X", version: "1" };
const okResponse = { description: "ok" };

function readerOver(sources: Map<string, unknown>, missing: string | null): DocumentReader {
  return {
    canRead: (uri) => sources.has(uri),
    read: async (uri) => {
      if (uri === missing) throw new Error(`no entry for ${uri}`);
      if (!sources.has(uri)) throw new Error(`no entry for ${uri}`);
      return structuredClone(sources.get(uri));
    },
  };
}

/**
 * A finding's identity across two runs of one document.
 *
 * Code plus address. The message is left out because a hoisted
 * component's derived name appears in some of them, and that name
 * differs between the two runs by construction.
 */
function key(finding: CheckFinding): string {
  return `${finding.code} ${finding.target?.pointer ?? finding.location}`;
}

async function findingsFor(
  sources: Map<string, unknown>,
  missing: string | null,
): Promise<CheckFinding[]> {
  const resolved = await resolveSpec({
    reader: readerOver(sources, missing),
    entry: "main.json",
    provenance: true,
    ...(missing !== null && { onUnresolved: "record" as const }),
  });
  try {
    return checkSpec(resolved);
  } catch (err) {
    if (err instanceof CheckAbortedError) return [...err.findings];
    throw err;
  }
}

/** Codes the holed run reports and the whole run does not. */
async function artefactCodes(sources: Map<string, unknown>): Promise<string[]> {
  const whole = await findingsFor(sources, null);
  const holed = await findingsFor(sources, "ext.json");
  const known = new Set(whole.map(key));
  return [...new Set(holed.filter((f) => !known.has(key(f))).map((f) => f.code))].sort();
}

const map = (entries: [string, unknown][]): Map<string, unknown> => new Map(entries);

describe("findings a hole in the document can invent", () => {
  it("unused-component: the only reference to it was inside the missing file", async () => {
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          paths: { "/p": { get: { responses: { "200": { $ref: "ext.json#/Ok" } } } } },
          components: { schemas: { Order: { type: "object" } } },
        },
      ],
      [
        "ext.json",
        {
          Ok: {
            ...okResponse,
            content: {
              "application/json": { schema: { $ref: "main.json#/components/schemas/Order" } },
            },
          },
        },
      ],
    ]);
    expect(await artefactCodes(sources)).toContain("unused-component");
  });

  it("unused-tag: the operation carrying the tag was inside the missing file", async () => {
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          tags: [{ name: "orders" }],
          paths: { "/p": { $ref: "ext.json#/PathItem" } },
        },
      ],
      ["ext.json", { PathItem: { get: { tags: ["orders"], responses: { "200": okResponse } } } }],
    ]);
    expect(await artefactCodes(sources)).toContain("unused-tag");
  });

  it("path-param-undeclared: the parameter was coming from the missing file", async () => {
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          paths: {
            "/p/{id}": {
              get: {
                parameters: [{ $ref: "ext.json#/Id" }],
                responses: { "200": okResponse },
              },
            },
          },
        },
      ],
      ["ext.json", { Id: { name: "id", in: "path", required: true, schema: { type: "string" } } }],
    ]);
    expect(await artefactCodes(sources)).toContain("path-param-undeclared");
  });

  it("malformed-schema: the hole itself, reported a second time by the compiler", async () => {
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          paths: {
            "/p": {
              get: {
                responses: {
                  "200": {
                    ...okResponse,
                    content: { "application/json": { schema: { $ref: "ext.json#/Order" } } },
                  },
                },
              },
            },
          },
        },
      ],
      ["ext.json", { Order: { type: "object" } }],
    ]);
    expect(await artefactCodes(sources)).toContain("malformed-schema");
  });
});

describe("findings a hole in the document cannot invent", () => {
  /**
   * A document whose findings all rest on what is written in the entry,
   * with one reference into a file that will be taken away. Nothing the
   * missing file could have said removes any of them.
   */
  const localOnly = map([
    [
      "main.json",
      {
        openapi: "3.1.0",
        info,
        paths: {
          "/p/{id}": {
            get: {
              // Declared in the template and nowhere else: a finding
              // about the entry's own text.
              responses: {
                "200": {
                  ...okResponse,
                  content: {
                    "application/json": {
                      schema: {
                        type: "string",
                        // Catastrophic backtracking, and a format the
                        // compiler does not validate: both local.
                        pattern: "^(a+)+$",
                        format: "not-a-real-format",
                      },
                    },
                  },
                },
              },
            },
          },
          "/q": { get: { responses: { "200": { $ref: "ext.json#/Ok" } } } },
        },
      },
    ],
    ["ext.json", { Ok: okResponse }],
  ]);

  it("keeps every finding that rests on the entry's own text", async () => {
    const whole = await findingsFor(localOnly, null);
    const holed = await findingsFor(localOnly, "ext.json");
    const wholeCodes = new Set(whole.map((f) => f.code));
    const holedCodes = new Set(holed.map((f) => f.code));
    // Sanity: the fixture produces the findings it is here to test.
    expect(wholeCodes.has("path-param-undeclared")).toBe(true);
    expect(wholeCodes.has("ambiguous-pattern")).toBe(true);
    expect(wholeCodes.has("format-not-validated")).toBe(true);
    for (const code of ["path-param-undeclared", "ambiguous-pattern", "format-not-validated"]) {
      expect(holedCodes.has(code)).toBe(true);
    }
  });

  it("invents nothing on a document whose findings are all local, bar the hole's own echo", async () => {
    // `malformed-schema` is here because the hole *is* a dangling
    // reference and the compiler says so. See the suite below: it is a
    // true statement about the document and still not a finding to
    // trust, because it is the failure being reported a second time.
    expect(await artefactCodes(localOnly)).toEqual(["malformed-schema"]);
  });
});

describe("the hole's own echo", () => {
  /**
   * `malformed-schema` appears on every holed document that compiles
   * schemas, because a hole is a reference that does not resolve and
   * that is exactly what the compiler reports.
   *
   * It is an artefact by the model's test (filling the hole removes it)
   * while being a true statement about the document as it stands. Both
   * are right, and the reason they do not conflict is that the failure
   * already has a channel: `ResolvedSpec.unresolved` names the file, the
   * referrer and the position. The compiler's copy says the same thing
   * a second time, in the vocabulary of schemas rather than of files,
   * and without the reason. Reporting the failure once, from the place
   * that knows why it happened, is the answer; treating this code as
   * trustworthy on a partial document is not.
   */
  it("appears wherever a hole does, and duplicates what the resolution record already said", async () => {
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          paths: {
            "/p": {
              get: {
                responses: {
                  "200": {
                    ...okResponse,
                    content: { "application/json": { schema: { $ref: "ext.json#/Order" } } },
                  },
                },
              },
            },
          },
        },
      ],
      ["ext.json", { Order: { type: "object" } }],
    ]);
    const resolved = await resolveSpec({
      reader: readerOver(sources, "ext.json"),
      entry: "main.json",
      provenance: true,
      onUnresolved: "record",
    });
    const findings = checkSpec(resolved);

    expect(findings.map((f) => f.code)).toEqual(["malformed-schema"]);
    expect(resolved.unresolved).toHaveLength(1);
    // The two describe the same failure. Only one of them says why.
    expect(findings[0]!.message).not.toContain("failed to read");
    expect(resolved.unresolved![0]!.message).toContain("failed to read ext.json");
  });

  it("is absent when the selection does not compile schemas, leaving the record as the only signal", async () => {
    const sources = map([
      [
        "main.json",
        {
          openapi: "3.1.0",
          info,
          paths: {
            "/p": {
              get: {
                responses: {
                  "200": {
                    ...okResponse,
                    content: { "application/json": { schema: { $ref: "ext.json#/Order" } } },
                  },
                },
              },
            },
          },
        },
      ],
      ["ext.json", { Order: { type: "object" } }],
    ]);
    const resolved = await resolveSpec({
      reader: readerOver(sources, "ext.json"),
      entry: "main.json",
      provenance: true,
      onUnresolved: "record",
    });
    // What a per-keystroke caller runs: the compile is the expense
    // (#624), so it is the first thing to drop.
    const findings = checkSpec(resolved, { findings: selectionForClasses(["hygiene"]) });
    expect(findings).toEqual([]);
    expect(resolved.unresolved).toHaveLength(1);
  });
});
// The two describes that stood here priced the design options and are
// gone with the spike: they asserted on this package's exact finding
// set and hard-coded the absence-based codes, so a new lint code would
// invalidate their premise without failing them. The numbers they
// produced are recorded on #877, which is where the design decision
// they argue for lives.

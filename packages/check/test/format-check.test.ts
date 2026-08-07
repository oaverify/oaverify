import { describe, expect, it } from "vitest";
import { checkDocumentFormats, KNOWN_FORMATS } from "../src/format-check.js";

const doc = (schema: unknown, second?: unknown) =>
  ({
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/a": {
        get: {
          parameters: [{ name: "q", in: "query", schema }],
          responses: {
            "200": {
              description: "ok",
              ...(second === undefined
                ? {}
                : { content: { "application/json": { schema: second } } }),
            },
          },
        },
      },
    },
  }) as never;

const check = (d: unknown) => checkDocumentFormats(d as never, KNOWN_FORMATS);

describe("a format check cannot validate", () => {
  it("reports one, naming it", () => {
    const [issue, ...rest] = check(doc({ type: "string", format: "iban" }));
    expect(rest).toEqual([]);
    expect(issue?.code).toBe("format-not-validated");
    expect(issue?.message).toContain('"iban" is not a format oaverify validates');
    expect(issue?.pointer).toBe("/paths/~1a/get/parameters/0/schema/format");
  });

  it("says nothing about a format it does validate", () => {
    expect(check(doc({ type: "string", format: "uri-reference" }))).toEqual([]);
    expect(check(doc({ type: "string", format: "date-time" }))).toEqual([]);
  });

  it("says nothing when there is no format at all", () => {
    expect(check(doc({ type: "string" }))).toEqual([]);
  });

  // The reported incident: the spec moves a field to a format the tool
  // does not carry, and nothing else in `check` notices.
  it("catches a rename from a known format to an unknown one", () => {
    expect(check(doc({ type: "string", format: "uri" }))).toEqual([]);
    expect(check(doc({ type: "string", format: "uri-refrence" }))).toHaveLength(1);
  });
});

describe("one finding per name, not per position", () => {
  it("collapses repeats and counts them", () => {
    const issues = check(
      doc({ type: "string", format: "iban" }, { type: "string", format: "iban" }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("(2 positions use it)");
  });

  it("omits the count when a name is used once", () => {
    expect(check(doc({ type: "string", format: "iban" }))[0]?.message).not.toContain("positions");
  });

  it("reports each distinct name", () => {
    const issues = check(
      doc({ type: "string", format: "iban" }, { type: "string", format: "isbn" }),
    );
    expect(issues.map((i) => i.code)).toEqual(["format-not-validated", "format-not-validated"]);
    expect(issues).toHaveLength(2);
  });
});

describe("an OAS-defined format reads differently from a vendor one", () => {
  // Every real 3.0 document carries several of these, and the author did
  // not invent the name: the spec gave it to them and nothing enforces
  // the range. Same code, different claim.
  it("separates the unassertable from the merely unimplemented", () => {
    // float and friends will never be asserted, so the message says so
    // rather than implying a later release will cover them.
    for (const format of ["float", "double", "binary", "password", "commonmark", "html"]) {
      const message = check(doc({ type: "string", format }))[0]?.message ?? "";
      expect(message).toContain(`OpenAPI defines "${format}", and no validator can assert it`);
      expect(message).not.toContain("does not assert it yet");
    }
  });

  it("names OpenAPI as the definer for a registry format not yet asserted", () => {
    // The whole registry, not the 3.0 shortlist: a 3.1 document using
    // decimal or sf-token got the vendor wording until #695. This list
    // shrinks each time #696 lands a validator, and a name that leaves
    // it should join the asserted list below.
    for (const format of ["sf-token", "decimal"]) {
      const message = check(doc({ type: "string", format }))[0]?.message ?? "";
      expect(message).toContain(`OpenAPI defines "${format}" but oaverify does not assert it yet`);
    }
  });

  it("says nothing at all about the formats it does assert", () => {
    // These were reported until validators landed. The walk skips
    // anything KNOWN_FORMATS holds, so the OAS-defined wording for them
    // is now unreachable rather than merely unused.
    for (const format of ["int32", "int64", "int8", "uint32", "uint64", "double-int", "unixtime"]) {
      expect(check(doc({ type: "integer", format }))).toEqual([]);
    }
    for (const format of [
      "byte",
      "base64url",
      "char",
      "http-date",
      "date-time-local",
      "time-local",
      "ipv4-cidr",
      "ipv6-cidr",
      "language",
      "media-range",
    ]) {
      expect(check(doc({ type: "string", format }))).toEqual([]);
    }
  });

  it("does not claim OpenAPI defined a vendor name", () => {
    const message = check(doc({ type: "string", format: "twiml" }))[0]?.message ?? "";
    expect(message).toContain('"twiml" is not a format oaverify validates');
    expect(message).not.toContain("OpenAPI defines");
  });
});

describe("the finding is advice, and says so", () => {
  // OAS 3.0.4 / 3.1.1 Data Type Format: a tool may fall back to `type`
  // alone for a format it does not recognise, and support for a
  // registered format is optional. A vendor format is legal, so the
  // message cannot read as a defect.
  it("states the document is legal and names the remedy", () => {
    const message = check(doc({ type: "string", format: "x-internal-id" }))[0]?.message ?? "";
    expect(message).toContain("This is legal");
    expect(message).toContain("formats option");
    expect(message).toContain('checked against "type" alone');
  });
});

describe("nested schema positions", () => {
  it("finds a format below a composition branch", () => {
    const issues = check(doc({ oneOf: [{ type: "integer" }, { type: "string", format: "iban" }] }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.pointer).toBe("/paths/~1a/get/parameters/0/schema/oneOf/1/format");
  });

  it("finds a format on an object property", () => {
    const issues = check(doc({ type: "object", properties: { x: { format: "iban" } } }));
    expect(issues[0]?.pointer).toBe("/paths/~1a/get/parameters/0/schema/properties/x/format");
  });
});

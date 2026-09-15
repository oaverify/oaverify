import { type OpenAPIDocument } from "@oaverify/internal-core";
import { createMemoryReader, loadSpec } from "@oaverify/internal-spec";
import { expect, it } from "vitest";
import { checkSpec } from "../src/check.js";
import { parseFindingTerms, resolveFindingSelection } from "../src/selection.js";
import { parseSeverityMap } from "../src/severity.js";
import { applySkip } from "../src/skip.js";

const DRAFT7 = "http://json-schema.org/draft-07/schema#";
const JSON_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const OAS = "https://spec.openapis.org/oas/3.1/dialect/base";
const select = (terms: string) => resolveFindingSelection(parseFindingTerms(terms));

function document(schemas: Record<string, unknown> = {}, extra = {}): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {},
    components: { schemas },
    ...extra,
  } as OpenAPIDocument;
}

async function resolved(doc: OpenAPIDocument) {
  return loadSpec({
    entry: "entry.json",
    reader: createMemoryReader(new Map([["entry.json", doc]])),
    provenance: true,
  });
}

it.each(["document", "schema"])("withholds the draft-07 ref-sibling verdict (%s)", async (at) => {
  const schema = {
    $ref: "#/components/schemas/Base",
    maxLength: 1,
    ...(at === "schema" ? { $schema: DRAFT7 } : {}),
  };
  const doc = document(
    { Base: { type: "string" } },
    {
      ...(at === "document" ? { jsonSchemaDialect: DRAFT7 } : {}),
      paths: {
        "/a": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema, example: "hello" },
                },
              },
            },
          },
        },
      },
    },
  );
  const findings = checkSpec(await resolved(doc));
  expect(findings.map((f) => f.code)).toEqual(["unsupported-schema-dialect"]);
  expect(findings[0]).toMatchObject({
    class: "schema",
    severity: "warning",
    target: {
      pointer:
        at === "document"
          ? "/jsonSchemaDialect"
          : "/paths/~1a/get/responses/200/content/application~1json/schema/$schema",
      anchor: "node",
      source: expect.any(Object),
    },
  });
});

it("withholds unsupported compiler and local observations while retaining independent checks", async () => {
  const doc = document({
    Unknown: {
      $schema: DRAFT7,
      minLength: -1,
      format: "vendor",
      pattern: "^(a+)+$",
      typo: true,
      examples: [1],
    },
    Supported: { type: "string", typo: true, examples: [1] },
  });
  const findings = checkSpec(await resolved(doc), { findings: select("schema,examples,redos") });
  expect(findings.map((f) => f.code).sort()).toEqual([
    "example-invalid",
    "unknown-keyword",
    "unsupported-schema-dialect",
  ]);
});

it("keeps withholding independent of selection and severity", async () => {
  const spec = await resolved(
    document({ Unknown: { $schema: DRAFT7, minLength: -1, examples: [1] } }),
  );
  const selection = select("schema,examples,-unsupported-schema-dialect");
  expect(
    applySkip(checkSpec(spec, { findings: selection }), selection.excludeKeys).findings,
  ).toEqual([]);
  expect(checkSpec(spec, { findings: select("examples") })).toEqual([]);
  expect(
    checkSpec(spec, {
      findings: select("unsupported-schema-dialect"),
      severity: parseSeverityMap(["unsupported-schema-dialect=error"]),
    }),
  ).toEqual([expect.objectContaining({ code: "unsupported-schema-dialect", severity: "error" })]);
  expect(select("unsupported-schema-dialect").compileSchemas).toBe(false);
});

it.each([OAS, "https://spec.openapis.org/oas/3.2/dialect/base", JSON_SCHEMA, `${JSON_SCHEMA}#`])(
  "recognizes %s and uses its format semantics",
  async (uri) => {
    const findings = checkSpec(
      await resolved(
        document(
          { A: { type: "string", format: "email", examples: ["invalid"] } },
          { jsonSchemaDialect: uri },
        ),
      ),
      { findings: select("schema,examples") },
    );
    expect(findings.map((f) => f.code)).toEqual(
      uri.startsWith("https://json-schema.org/") ? [] : ["example-invalid"],
    );
  },
);

it("uses root overrides and inherits the resource dialect across ordinary nested schemas", async () => {
  const doc = document(
    {
      Override: {
        $schema: OAS,
        type: "object",
        properties: {
          ordinary: { $schema: DRAFT7, type: "string", examples: [1] },
          inherited: { $id: "https://example.test/inherited", type: "string", examples: [1] },
        },
      },
      Unknown: { type: "string", examples: [1] },
    },
    { jsonSchemaDialect: DRAFT7 },
  );
  const findings = checkSpec(await resolved(doc), { findings: select("schema,examples") });
  expect(
    findings.filter((f) => f.code === "unsupported-schema-dialect").map((f) => f.target?.pointer),
  ).toEqual(["/jsonSchemaDialect"]);
  expect(
    findings.filter((f) => f.code === "example-invalid").map((f) => f.target?.pointer),
  ).toEqual([
    "/components/schemas/Override/properties/ordinary/examples/0",
    "/components/schemas/Override/properties/inherited/examples/0",
  ]);
});

it("discovers supported embedded resources inside unsupported schemas", async () => {
  const doc = document({
    Unknown: {
      $schema: DRAFT7,
      $defs: {
        Supported: {
          $id: "https://example.test/supported",
          $schema: OAS,
          type: "string",
          typo: true,
          examples: [1],
          format: "vendor",
          pattern: "^(a+)+$",
        },
      },
    },
  });
  const findings = checkSpec(await resolved(doc), { findings: select("schema,examples,redos") });
  expect(findings.map((f) => f.code).sort()).toEqual([
    "ambiguous-pattern",
    "example-uncheckable",
    "format-not-validated",
    "unknown-keyword",
    "unsupported-schema-dialect",
  ]);
  expect(findings.find((f) => f.code === "unknown-keyword")?.target?.pointer).toBe(
    "/components/schemas/Unknown/$defs/Supported",
  );
});

it.each(["$ref", "$dynamicRef"])(
  "withholds supported units reaching an unsupported target through %s",
  async (key) => {
    const doc = document({
      Use: { [key]: "#/components/schemas/Unknown", required: ["missing"], examples: [{}] },
      Unknown: { $schema: DRAFT7, type: "object" },
      Good: { type: "string", examples: [1] },
    });
    const findings = checkSpec(await resolved(doc), { findings: select("schema,examples") });
    expect(findings.map((f) => f.code).sort()).toEqual([
      "example-invalid",
      "unsupported-schema-dialect",
    ]);
    expect(findings.find((f) => f.code === "example-invalid")?.target?.pointer).toBe(
      "/components/schemas/Good/examples/0",
    );
  },
);

it.each(["$ref", "$dynamicRef"])("checks examples through scoped %s references", async (key) => {
  const doc = document({
    A: {
      $id: "https://example.test/a",
      $defs: { Value: { $anchor: "value", type: "string" } },
      properties: { x: { [key]: "#value", examples: [1] } },
    },
    B: {
      $id: "https://example.test/b",
      $defs: { Value: { $anchor: "value", type: "number" } },
      properties: { x: { [key]: "#value", examples: [1] } },
    },
  });
  const findings = checkSpec(await resolved(doc), { findings: select("examples") });
  expect(findings).toEqual([
    expect.objectContaining({
      code: "example-invalid",
      target: expect.objectContaining({ pointer: "/components/schemas/A/properties/x/examples/0" }),
      reasons: [
        expect.objectContaining({
          code: "type",
          params: { expected: ["string"], actual: "integer" },
        }),
      ],
    }),
  ]);
});

it("withholds mixed supported closures while checking each independent supported resource", async () => {
  const doc = document({
    Mixed: { $ref: "#/components/schemas/JSON", required: ["missing"], examples: ["invalid"] },
    JSON: { $schema: JSON_SCHEMA, type: "string", format: "email", examples: ["invalid"] },
    OAS: { $schema: OAS, type: "string", format: "email", examples: ["invalid"] },
  });
  const findings = checkSpec(await resolved(doc), { findings: select("schema,examples") });
  expect(findings.map((f) => f.code).sort()).toEqual([
    "example-invalid",
    "unsupported-schema-dialect",
  ]);
  expect(findings.find((f) => f.code === "unsupported-schema-dialect")).toMatchObject({
    target: { pointer: "/components/schemas/Mixed" },
    message: expect.stringContaining("different semantics"),
  });
  expect(
    checkSpec(await resolved(doc), { findings: select("unsupported-schema-dialect") }),
  ).toHaveLength(1);
});

it("finds mixed embedded resources without reference edges", async () => {
  const doc = document({
    Mixed: {
      type: "object",
      typo: true,
      properties: {
        value: {
          $id: "https://example.test/json",
          $schema: JSON_SCHEMA,
          type: "string",
          typo: true,
          format: "email",
          examples: ["invalid"],
        },
      },
      examples: [{ value: "invalid" }],
    },
  });
  const findings = checkSpec(await resolved(doc), { findings: select("schema,examples") });
  expect(findings.map((f) => f.code).sort()).toEqual([
    "unknown-keyword",
    "unsupported-schema-dialect",
  ]);
  expect(findings.find((f) => f.code === "unknown-keyword")?.target?.pointer).toBe(
    "/components/schemas/Mixed/properties/value",
  );
});

it("includes unsupported dynamic binding candidates in eligibility", async () => {
  const doc = document({
    Root: { $dynamicRef: "https://example.test/base#node", required: ["missing"], examples: [{}] },
    Base: { $id: "https://example.test/base", $dynamicAnchor: "node", type: "object" },
    Override: { $schema: DRAFT7, $dynamicAnchor: "node", type: "object" },
  });
  const findings = checkSpec(await resolved(doc), { findings: select("schema,examples") });
  expect(findings.map((f) => f.code)).toEqual(["unsupported-schema-dialect"]);
});

it.each(["$ref", "$dynamicRef"])(
  "screens scoped pattern targets reached by %s before running examples",
  async (key) => {
    const doc = document({
      Root: {
        $id: "https://example.test/root",
        $defs: {
          Bad: { $anchor: "bad", pattern: "^(a+)+$" },
        },
        properties: { value: { [key]: "#bad", examples: ["aaa!"] } },
      },
    });
    expect(checkSpec(await resolved(doc), { findings: select("examples") })).toEqual([
      expect.objectContaining({ code: "example-uncheckable" }),
    ]);
  },
);

it("screens patterns in dynamic binding candidates", async () => {
  const doc = document({
    Root: { $dynamicRef: "https://example.test/base#node", examples: ["aaa!"] },
    Base: { $id: "https://example.test/base", $dynamicAnchor: "node", type: "string" },
    Override: { $dynamicAnchor: "node", pattern: "^(a+)+$" },
  });
  expect(checkSpec(await resolved(doc), { findings: select("examples") })).toEqual([
    expect.objectContaining({ code: "example-uncheckable" }),
  ]);
});

it("keeps data-valued dialect declarations out of the inventory", async () => {
  const data = {
    $schema: DRAFT7,
    $id: "https://example.test/data",
    properties: { value: { $schema: DRAFT7 } },
  };
  const doc = document({
    A: { enum: [data], const: data, default: data, examples: [data], example: data },
  });
  expect(
    checkSpec(await resolved(doc), { findings: select("unsupported-schema-dialect") }),
  ).toEqual([]);
});

it("preserves OAS 3.0 dialect policy and ignored ref siblings", async () => {
  const doc = document(
    {
      Base: { type: "string", example: 1 },
      Use: {
        $ref: "#/components/schemas/Base",
        $schema: DRAFT7,
        $defs: { Bad: { $schema: DRAFT7, minLength: -1 } },
      },
    },
    { openapi: "3.0.3", jsonSchemaDialect: DRAFT7 },
  );
  const findings = checkSpec(await resolved(doc), {
    findings: select("examples,unsupported-schema-dialect"),
  });
  expect(findings.map((f) => f.code)).toEqual(["example-invalid"]);
});

it("does not report annotation-only formats as unvalidated assertions", async () => {
  const doc = document({ A: { $schema: JSON_SCHEMA, format: "vendor" } });
  expect(checkSpec(await resolved(doc), { findings: select("format-not-validated") })).toEqual([]);
});

it.each([false, true, null, 7, []])(
  "withholds references to unsupported primitive schema slots (%j)",
  async (target) => {
    const doc = document(
      {
        Unknown: target,
        Supported: { $schema: OAS, $ref: "#/components/schemas/Unknown", examples: [1] },
        Independent: { $schema: OAS, type: "string", examples: [1] },
      },
      { jsonSchemaDialect: DRAFT7 },
    );
    const findings = checkSpec(await resolved(doc), { findings: select("schema,examples") });
    expect(findings.map((f) => f.code).sort()).toEqual([
      "example-invalid",
      "unsupported-schema-dialect",
    ]);
    expect(findings.find((f) => f.code === "example-invalid")?.target?.pointer).toBe(
      "/components/schemas/Independent/examples/0",
    );
  },
);

it.each(["$ref", "$dynamicRef"])(
  "discovers dialects at schema targets outside document slots (%s)",
  async (key) => {
    const doc = document(
      {
        Base: { type: "string" },
        Supported: { [key]: "#/x-unknown", examples: ["hello"] },
      },
      { "x-unknown": { $schema: DRAFT7, $ref: "#/components/schemas/Base", maxLength: 1 } },
    );
    const findings = checkSpec(await resolved(doc), { findings: select("schema,examples") });
    expect(findings).toEqual([
      expect.objectContaining({
        code: "unsupported-schema-dialect",
        target: expect.objectContaining({ pointer: "/x-unknown/$schema" }),
      }),
    ]);
    expect(
      checkSpec(await resolved(doc), { findings: select("unsupported-schema-dialect") }),
    ).toHaveLength(1);
  },
);

it("registers resource scope at newly discovered reference targets", async () => {
  const doc = document(
    { Use: { $schema: JSON_SCHEMA, $ref: "#/x-schema", examples: [1] } },
    {
      "x-schema": {
        $id: "https://example.test/extension",
        $schema: JSON_SCHEMA,
        $ref: "#value",
        $defs: { Value: { $anchor: "value", type: "string" } },
      },
    },
  );
  const findings = checkSpec(await resolved(doc), { findings: select("schema,examples") });
  expect(findings).toEqual([
    expect.objectContaining({
      code: "example-invalid",
      reasons: [expect.objectContaining({ code: "type" })],
    }),
  ]);
});

it.each([DRAFT7, JSON_SCHEMA])(
  "inherits %s for references into unrecognized subschema positions",
  async (uri) => {
    const doc = document({
      Root: {
        $schema: uri,
        "x-schema": { type: "string", format: "email", examples: ["invalid"] },
      },
      Use: { $schema: uri, $ref: "#/components/schemas/Root/x-schema", examples: [1, "invalid"] },
    });
    const findings = checkSpec(await resolved(doc), {
      findings: select("examples,unsupported-schema-dialect"),
    });
    expect(findings.map((f) => f.code)).toEqual(
      uri === DRAFT7
        ? ["unsupported-schema-dialect", "unsupported-schema-dialect"]
        : ["example-invalid"],
    );
  },
);

it("retains enclosing base URI when registering a referenced subschema", async () => {
  const doc = document({
    Root: {
      $id: "https://example.test/root",
      $schema: JSON_SCHEMA,
      $defs: { Value: { $anchor: "value", type: "string" } },
      "x-schema": { $ref: "#value", examples: [1] },
    },
    Use: { $schema: JSON_SCHEMA, $ref: "#/components/schemas/Root/x-schema", examples: [1] },
  });
  const findings = checkSpec(await resolved(doc), {
    findings: select("examples,unsupported-schema-dialect"),
  });
  expect(findings.map((f) => f.code)).toEqual(["example-invalid", "example-invalid"]);
});

it("does not let an ordinary reference target's $schema override its resource", async () => {
  const doc = document({
    Root: { $schema: DRAFT7, "x-schema": { $schema: OAS, type: "string" } },
    Use: { $ref: "#/components/schemas/Root/x-schema", examples: [1] },
  });
  expect(
    checkSpec(await resolved(doc), { findings: select("schema,examples") }).map((f) => f.code),
  ).toEqual(["unsupported-schema-dialect"]);
});

it("reports local observations at discovered schema targets under code-only selections", async () => {
  const doc = document(
    { Use: { $ref: "#/x-schema", examples: [1] } },
    {
      "x-schema": { type: "string", format: "vendor", pattern: "^(a+)+$" },
    },
  );
  for (const code of ["format-not-validated", "ambiguous-pattern"]) {
    const findings = checkSpec(await resolved(doc), { findings: select(code) });
    expect(findings).toEqual([
      expect.objectContaining({
        code,
        target: expect.objectContaining({
          pointer: code === "format-not-validated" ? "/x-schema/format" : "/x-schema/pattern",
        }),
      }),
    ]);
  }
  expect(
    checkSpec(await resolved(doc), { findings: select("schema,examples,redos") })
      .map((f) => f.code)
      .sort(),
  ).toEqual(["ambiguous-pattern", "example-uncheckable", "format-not-validated"]);
});

it.each([DRAFT7, JSON_SCHEMA])(
  "makes ancestor discovery independent of reference order (%s)",
  async (uri) => {
    const child = { $schema: uri, $ref: "#/x-parent/properties/value", examples: ["invalid"] };
    const parent = { $schema: uri, $ref: "#/x-parent" };
    const extra = {
      "x-parent": { $schema: uri, properties: { value: { type: "string", format: "email" } } },
    };
    const run = async (schemas: Record<string, unknown>) =>
      checkSpec(await resolved(document(schemas, extra)), {
        findings: select("examples,unsupported-schema-dialect"),
      });
    const first = await run({ Child: child, Parent: parent });
    const second = await run({ Parent: parent, Child: child });
    expect(first.filter((f) => f.code === "example-invalid")).toEqual([]);
    expect(first.map((f) => f.target?.pointer ?? "").sort()).toEqual(
      second.map((f) => f.target?.pointer ?? "").sort(),
    );
    if (uri === JSON_SCHEMA) expect(first).toEqual([]);
  },
);

it.each(["x-chain", "x-very-very-very-very-long-chain"])(
  "drops targets discovered under superseded resource scope (%s)",
  async (chain) => {
    const doc = document(
      {
        Child: { $ref: "#/x-parent/properties/value", examples: [1] },
        Chain: { $ref: `#/${chain}` },
      },
      {
        [chain]: { $ref: "#/x-parent" },
        "x-parent": {
          $id: "https://example.test/root",
          properties: { value: { $ref: "#/x-target" } },
          "x-target": { type: "string" },
        },
        "x-target": { $schema: DRAFT7, type: "number" },
      },
    );
    const findings = checkSpec(await resolved(doc), {
      findings: select("examples,unsupported-schema-dialect"),
    });
    expect(findings).toEqual([expect.objectContaining({ code: "example-invalid" })]);
  },
);

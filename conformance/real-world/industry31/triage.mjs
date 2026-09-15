import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { loadSpec, createMemoryReader } from "../../../dist/spec.js";
import { createValidator } from "../../../dist/index.js";
import { compileSchema, openapi31Dialect } from "../../../dist/schema.js";
import { checkSpec } from "../../../packages/check/dist/index.js";

const manifest = JSON.parse(await readFile(new URL("manifest.json", import.meta.url), "utf8"));
async function source(suffix) {
  const matches = manifest.resources.filter((resource) => resource.url.endsWith(suffix));
  assert.equal(matches.length, 1);
  return parse(
    await readFile(
      new URL(`../specs/industry31/blobs/${matches[0].sha256}`, import.meta.url),
      "utf8",
    ),
  );
}

const event = await source("/models/modes/car-share/event.yaml");
assert.ok(Array.isArray(event.if.properties.event_types.contains));
assert.throws(
  () => compileSchema({ type: "array", contains: ["trip_start"] }, { dialect: openapi31Dialect }),
  /contains.*must be an object or boolean/,
);

const pact = await source("/spec/v3/openapi.yaml");
assert.equal(
  pact.components.schemas.RequestCreatedEvent.properties.$ref,
  "#/components/schemas/BaseEvent/properties",
);
assert.throws(
  () =>
    compileSchema(
      { type: "object", properties: { $ref: "#/components/schemas/BaseEvent/properties" } },
      { dialect: openapi31Dialect },
    ),
  /properties\.\$ref.*must be an object or boolean/,
);

const rail = await source("/specification/OSDM-online-webhook.yml");
const baseEvent = rail.components.schemas.AbstractEvent;
assert.ok(baseEvent.required.includes("revision"));
assert.equal(Object.hasOwn(baseEvent.properties, "revision"), false);
const validator = createValidator(rail);
// A required undeclared field is legal JSON Schema, with no type constraint.
const railSchema = compileSchema(
  {
    ...baseEvent,
    components: { schemas: { Resource: rail.components.schemas.Resource } },
  },
  { dialect: openapi31Dialect },
);
assert.equal(
  railSchema.validate({ objectType: "Event", summary: "Changed", resources: [] }).valid,
  false,
);
assert.equal(
  railSchema.validate({ objectType: "Event", summary: "Changed", revision: {}, resources: [] })
    .valid,
  true,
);
assert.equal(validator.validateRequest({ method: "GET", path: "/ping" }).valid, true);

// Same authored constraint, once in the document and once in an external file.
// Both forms must retain reachability after external targets are hoisted.
const externalSchema = {
  type: "object",
  $defs: { Code: { type: "string" } },
  properties: { code: { $ref: "#/$defs/Code" } },
};
for (const external of [false, true]) {
  const schema = external
    ? { $ref: "body.json" }
    : {
        ...externalSchema,
        properties: { code: { $ref: "#/components/schemas/Probe/$defs/Code" } },
      };
  const doc = {
    openapi: "3.1.0",
    info: { title: "Used external definition", version: "1" },
    paths: {
      "/probe": {
        post: {
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Probe" } } },
          },
          responses: { 200: { description: "OK" } },
        },
      },
    },
    components: { schemas: { Probe: schema } },
  };
  const resolved = await loadSpec({
    entry: "root.json",
    reader: createMemoryReader(
      new Map([
        ["root.json", doc],
        ["body.json", externalSchema],
      ]),
    ),
    provenance: true,
  });
  const findings = checkSpec(resolved).filter((finding) => finding.code === "unreachable-defs");
  assert.equal(findings.length, 0);
  const runtime = createValidator(resolved.document);
  for (const code of ["ok", 42]) {
    const result = runtime.validateRequest({
      method: "POST",
      path: "/probe",
      contentType: "application/json",
      body: { code },
    });
    assert.equal(result.valid, typeof code === "string");
  }
  console.log(
    JSON.stringify({ external, unreachableDefs: findings.length, runtimeEnforcesCodeType: true }),
  );
}
console.log(
  "Confirmed MDS and PACT malformed shapes, UIC unconstrained required field, and external-$defs reachability.",
);

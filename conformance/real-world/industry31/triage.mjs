/**
 * Source-shape assertions behind the findings written up in README.md.
 * These read the pinned corpus bytes, so they cannot live in the unit
 * suite. The compiler rejections they once duplicated now sit in
 * packages/schema/test/well-formed.test.ts, and external-$defs
 * reachability in packages/check/test/external-defs.test.ts.
 *
 * Usage (from repo root, after fetch.mjs):
 *   node conformance/real-world/industry31/triage.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { createValidator } from "../../../dist/index.js";
import { compileSchema, openapi31Dialect } from "../../../dist/schema.js";

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

const pact = await source("/spec/v3/openapi.yaml");
assert.equal(
  pact.components.schemas.RequestCreatedEvent.properties.$ref,
  "#/components/schemas/BaseEvent/properties",
);

const rail = await source("/specification/OSDM-online-webhook.yml");
const baseEvent = rail.components.schemas.AbstractEvent;
assert.ok(baseEvent.required.includes("revision"));
assert.equal(Object.hasOwn(baseEvent.properties, "revision"), false);
const validator = createValidator(rail);
// Carrying `components` lets the event's own `#/components/...` references
// resolve while the schema is compiled outside its document.
const railSchema = compileSchema(
  {
    ...baseEvent,
    components: { schemas: { Resource: rail.components.schemas.Resource } },
  },
  { dialect: openapi31Dialect },
);
// A required undeclared field is legal JSON Schema, with no type constraint.
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

console.log("Confirmed MDS and PACT malformed shapes and the UIC unconstrained required field.");

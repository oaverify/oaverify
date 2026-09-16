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

const appStatus = await source("/docs/specs/appstatusv1.yaml");
const cusip = appStatus.components.parameters.cusip.schema;
// `(9)` is a group matching the literal digit, where `{9}` was meant, so the
// pattern matches length 2 and minLength 9 can never hold.
assert.equal(cusip.pattern, "(^[a-zA-Z0-9](9)$)");
assert.equal(cusip.minLength, 9);
assert.equal(
  compileSchema(cusip, { dialect: openapi31Dialect }).validate("037833100").valid,
  false,
);

const notifications = await source("/docs/specs/appstatuspushNotifications_1.1.1.yaml");
const funding = notifications.components.schemas.FundingReceivedNotification.allOf[1];
const notification = funding.properties.notification;
assert.equal(notification.allOf[0].$ref, "#/components/schemas/TransferNotificationBase");
// The two spellings of the same state are what leave one legal value.
assert.deepEqual(notification.properties.status.enum, ["inProgress", "complete"]);
assert.deepEqual(notifications.components.schemas.TransferNotificationBase.properties.status.enum, [
  "awaitingReview",
  "inProgress",
  "completed",
]);

const withdrawal = await source("/docs/specs/onetimewithdrawal_1.0.1.yaml");
const branch = withdrawal.components.schemas.TransactionAmounts.allOf[2];
// `properties` sits at the same indentation as `if`, so `if` parses as null
// and its intended condition becomes a sibling keyword.
assert.ok(Object.hasOwn(branch, "if"));
assert.equal(branch.if, null);
assert.ok(Object.hasOwn(branch, "properties"));

console.log(
  "Confirmed MDS, PACT and IRI malformed shapes, the IRI unsatisfiable pattern and enum\n" +
    "composition, and the UIC unconstrained required field.",
);

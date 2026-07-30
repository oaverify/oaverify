/**
 * One gateway fronting several services, each with its own spec.
 *
 * `combineValidators` builds a composite that dispatches each request to
 * the member owning its route. The composite is itself a `Validator`, so
 * it drops into the same middleware slot as a single one.
 *
 * Two decisions worth making explicitly:
 *
 * - `onOverlap`. Default `"first-match"` lets the earliest member win and
 *   silently shadows the rest. `"error"` asserts disjointness at assembly
 *   time, which is what you want when the members are supposed to own
 *   separate route space and an overlap means someone made a mistake.
 * - `ignoreUndocumented` on the composite governs routes NO member owns.
 *   A member's own `ignoreUndocumented` governs only its owned routes,
 *   reached through delegation. The two are separate knobs.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/combine-validators.ts
 */

import { fileURLToPath } from "node:url";
import { createYamlFileReader } from "../packages/yaml/src/index.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { combineValidators, createValidator } from "../packages/validator/src/index.ts";

const load = async (name: string) => {
  const entry = fileURLToPath(new URL(`./specs/${name}`, import.meta.url));
  const { document } = await loadSpec({ reader: createYamlFileReader(), entry });
  return createValidator(document);
};

const pets = await load("petstore.yaml"); // owns /pets
const items = await load("items.yaml"); // owns /items

// "error" surfaces a route clash at assembly time instead of letting
// first-match shadow it at request time. These two are disjoint, so it
// builds; a third spec also declaring /pets would throw here.
const gateway = combineValidators([pets, items], { onOverlap: "error" });

const show = (label: string, req: Parameters<typeof gateway.validateRequest>[0]): void => {
  const result = gateway.validateRequest(req);
  const detail = result.valid ? "" : `  ${result.errors[0]?.code}: ${result.errors[0]?.message}`;
  console.log(`${label.padEnd(34)} valid=${result.valid}${detail}`);
};

// Routed to the member that owns each path.
show("POST /pets (valid)", {
  method: "POST",
  path: "/pets",
  contentType: "application/json",
  body: { id: 1, name: "Fido" },
});
show("POST /items (valid)", {
  method: "POST",
  path: "/items",
  contentType: "application/json",
  body: [{ id: 1, name: "widget" }],
});

// Delegation is real: the member's own schema rejects this, not the composite.
show("POST /items (missing id)", {
  method: "POST",
  path: "/items",
  contentType: "application/json",
  body: [{ name: "widget" }],
});

// No member owns /billing. Default: a route error from the composite.
show("GET /billing (no owner)", { method: "GET", path: "/billing" });

// Same request against a composite that passes unowned routes through,
// the shape a gateway uses when it fronts unvalidated services too.
const permissive = combineValidators([pets, items], { ignoreUndocumented: true });
const passthrough = permissive.validateRequest({ method: "GET", path: "/billing" });
console.log(`${"GET /billing (ignoreUndocumented)".padEnd(34)} valid=${passthrough.valid}`);

/**
 * Guarding a recursive schema against stack exhaustion.
 *
 * A self-referential `$ref` compiles to a recursive JS call, so a payload
 * nested deeply enough exhausts the native call stack and throws
 * `RangeError` before validation finishes. Client-controlled nesting
 * depth turns that into a denial-of-service handle: the crash happens
 * inside the validator, so the request never reaches the handler that
 * would have rejected it.
 *
 * `maxDepth` bounds the recursion and reports a `depth` error leaf
 * instead, which the HTTP layer maps to a 400. Unset, codegen is
 * byte-identical to the un-instrumented path, so the guard costs nothing
 * until it is asked for.
 *
 * See docs/configuration.md "Guarding against deeply nested payloads".
 * Note `maxDepth` in examples/stream-limits.ts is a different bound (the
 * stream engine's), not this compiler recursion guard.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/max-depth.ts
 */

import { fileURLToPath } from "node:url";
import { createYamlFileReader } from "../packages/yaml/src/index.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { createValidator, type Validator } from "../packages/validator/src/index.ts";

const specPath = fileURLToPath(new URL("./specs/tree.yaml", import.meta.url));
const { document } = await loadSpec({ reader: createYamlFileReader(), entry: specPath });

/** A comment nested `depth` levels deep, the shape an attacker controls. */
const nest = (depth: number): unknown => {
  let node: Record<string, unknown> = { text: "leaf" };
  for (let i = 0; i < depth; i++) node = { text: `level ${i}`, replies: [node] };
  return node;
};

const post = (v: Validator, body: unknown) =>
  v.validateRequest({
    method: "POST",
    path: "/comments",
    contentType: "application/json",
    body,
  });

const shallow = nest(10);
const deep = nest(20_000);

// Unguarded: fine on a normal payload, RangeError on a hostile one.
const unguarded = createValidator(document);
console.log("unguarded, depth 10:    ", post(unguarded, shallow).valid);
try {
  post(unguarded, deep);
  console.log("unguarded, depth 20000: completed (stack was deep enough here)");
} catch (err) {
  console.log(`unguarded, depth 20000: threw ${(err as Error).constructor.name}`);
}

// Guarded: the same hostile payload is a normal validation failure the
// caller can turn into a 400.
const guarded = createValidator(document, { maxDepth: 100 });
console.log("guarded,   depth 10:    ", post(guarded, shallow).valid);

const result = post(guarded, deep);
console.log("guarded,   depth 20000: ", result.valid);
const first = result.valid ? undefined : result.errors[0];
if (first !== undefined) {
  // The path is as deep as the guard allowed, so print only its ends.
  const path = first.path;
  const shown =
    path.length > 6
      ? `${path.slice(0, 3).join(".")} ... ${path.slice(-2).join(".")} (${path.length} segments)`
      : path.join(".") || "(root)";
  console.log(`  code=${first.code} path=${shown}`);
  console.log(`  ${first.message}`);
}

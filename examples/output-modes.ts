/**
 * The three output shapes, on one invalid request.
 *
 * `output` selects what a failed validation hands back. It changes the
 * shape only; the verdict is identical across all three.
 *
 * - `"flat"` (default): a flat list of leaf errors. Pairs with
 *   `maxErrors` for Ajv-style fast-fail. Best for rendering a 400 body.
 * - `"tree"`: the nested `ValidationError` tree, with branch nodes
 *   preserved. Best when you need the structure (which parameter group
 *   failed, which `oneOf` branch) rather than a flat list.
 * - `"predicate"`: a bare boolean. Best on a hot path that only gates,
 *   since nothing is allocated to describe the failure.
 *
 * v5 removed the `flat` / `predicate` boolean aliases (#497); this is
 * the replacement surface. See docs/migration-v5.md.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/output-modes.ts
 */

import { fileURLToPath } from "node:url";
import { createYamlFileReader } from "../packages/syntax/src/index.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { createValidator } from "../packages/validator/src/index.ts";
import type { ValidationError } from "../packages/core/src/index.ts";

const specPath = fileURLToPath(new URL("./specs/items.yaml", import.meta.url));
const { document } = await loadSpec({ reader: createYamlFileReader(), entry: specPath });

// Three items, each missing the required `id`.
const request = {
  method: "POST",
  path: "/items",
  contentType: "application/json",
  body: Array.from({ length: 3 }, (_, i) => ({ name: `item ${i}` })),
} as const;

// flat: leaf list. maxErrors raised so the shapes are comparable; the
// zero-config default is maxErrors: 1.
const flat = createValidator(document, { maxErrors: 10 });
const flatResult = flat.validateRequest({ ...request });
console.log(`flat       valid=${flatResult.valid}`);
if (!flatResult.valid) {
  for (const e of flatResult.errors) {
    console.log(`  ${e.code.padEnd(10)} ${e.path.join(".")}: ${e.message}`);
  }
}

// tree: branch nodes retained, so the nesting is walkable.
const tree = createValidator(document, { output: "tree", maxErrors: 10 });
const treeResult = tree.validateRequest({ ...request });
console.log(`\ntree       valid=${treeResult.valid}`);
if (!treeResult.valid) {
  const walk = (node: ValidationError, depth: number): void => {
    const n = node.children?.length ?? 0;
    const kind = n === 0 ? "leaf" : `branch(${n})`;
    console.log(`${"  ".repeat(depth + 1)}${kind} ${node.code} ${node.path.join(".") || "(root)"}`);
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  walk(treeResult.error, 0);
}

// predicate: verdict only, nothing allocated to describe it.
const predicate = createValidator(document, { output: "predicate" });
console.log(`\npredicate  valid=${predicate.validateRequest({ ...request })}`);

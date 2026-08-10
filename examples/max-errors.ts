/**
 * Bounded error collection: run the same invalid payload at the default
 * fast-fail (`maxErrors: 1`), bounded budgets (`maxErrors: 3` and `10`),
 * and uncapped (`Infinity`). Hot loops short-circuit once the budget is
 * spent, so a huge invalid array doesn't cost proportional CPU.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/max-errors.ts
 */

import { fileURLToPath } from "node:url";
import { createYamlFileReader } from "../packages/syntax/src/index.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { createValidator } from "../packages/validator/src/index.ts";

const specPath = fileURLToPath(new URL("./specs/items.yaml", import.meta.url));
const { document } = await loadSpec({ reader: createYamlFileReader(), entry: specPath });

// 50 array items, all missing the required `id` field.
const bulk = Array.from({ length: 50 }, () => ({ name: "whatever" }));

const runAndCount = (label: string, maxErrors: number | undefined): void => {
  const v = createValidator(document, maxErrors === undefined ? {} : { maxErrors });
  const start = performance.now();
  const err = v.validateRequest({
    method: "POST",
    path: "/items",
    contentType: "application/json",
    body: bulk,
  });
  const ms = performance.now() - start;
  const leafCount = err.valid ? 0 : err.errors.length;
  console.log(
    `${label.padEnd(20)} leaves=${String(leafCount).padStart(3)}  time=${ms.toFixed(2)}ms`,
  );
};

runAndCount("fast-fail (default)", undefined);
runAndCount("bounded (3)", 3);
runAndCount("bounded (10)", 10);
runAndCount("uncapped (Infinity)", Number.POSITIVE_INFINITY);

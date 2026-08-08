/**
 * Drive the parameter grid through a build of oaverify and record what
 * happened for every case.
 *
 * Runs against the *public* `@oaverify/core` surface and the built `dist`,
 * never `packages/*\/src`. Two reasons. A revision this is diffed against
 * may not share our module layout, so the public API is the only stable
 * handle across revisions. And the same script then drives any other
 * OpenAPI validator through its own public API with the wire format
 * unchanged, which is what the cross-library corpus needs.
 *
 * Usage:
 *   node scripts/grid/dump.mjs <out.json> [--root <repo root>]
 *
 * `--root` names the checkout to load oaverify from, so the runner can
 * point this at a worktree of another revision without that revision
 * needing to contain this file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { declarations, gridSize, requests, OAS_VERSION } from "./cases.mjs";

function parseArgs(argv) {
  const positional = [];
  let root = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      root = argv[i + 1];
      i += 1;
    } else positional.push(argv[i]);
  }
  if (positional.length !== 1) {
    console.error("usage: node scripts/grid/dump.mjs <out.json> [--root <repo root>]");
    process.exit(2);
  }
  return { out: positional[0], root: resolve(root) };
}

/**
 * A verdict, flattened to something two revisions can be compared on.
 *
 * `value` is the `returnValues` channel, which is present whatever the
 * verdict and carries every parameter that passed. It is what makes the
 * "both valid, different value" bucket visible; without it a silent
 * change in how a value is read looks identical to no change at all.
 */
function record(validator, request) {
  let result;
  try {
    result = validator.validateRequest(request);
  } catch (err) {
    return { verdict: "throw", error: `${err?.name}: ${err?.message}` };
  }
  if (result === null) return { verdict: "valid", value: null };
  if (result.valid) return { verdict: "valid", value: result.value ?? null };
  return {
    verdict: "invalid",
    codes: leafCodes(result).sort(),
    value: result.value ?? null,
  };
}

/** Every leaf error code in a flat result, for a coarse failure identity. */
function leafCodes(result) {
  const errors = result.errors ?? [];
  return errors.map((e) => e.code ?? "?");
}

async function main() {
  const { out, root } = parseArgs(process.argv.slice(2));
  const entry = pathToFileURL(resolve(root, "dist/index.js")).href;

  let createValidator;
  try {
    ({ createValidator } = await import(entry));
  } catch (err) {
    console.error(`cannot load oaverify from ${entry}`);
    console.error(`did you run "pnpm build" in ${root}?`);
    console.error(String(err?.message ?? err));
    process.exit(2);
  }

  const results = {};
  let built = 0;
  let failedBuilds = 0;

  for (const decl of declarations()) {
    let validator;
    try {
      validator = createValidator(decl.doc, { returnValues: true });
      built += 1;
    } catch (err) {
      // A declaration the validator refuses to build is itself a datum:
      // a revision that starts or stops refusing one is a real change.
      failedBuilds += 1;
      for (const { wireId } of requests(decl.location)) {
        results[`${decl.id}::${wireId}`] = {
          verdict: "build-error",
          error: `${err?.name}: ${err?.message}`,
        };
      }
      continue;
    }
    for (const { wireId, request } of requests(decl.location)) {
      results[`${decl.id}::${wireId}`] = record(validator, request);
    }
  }

  const dump = {
    meta: {
      root,
      oasVersion: OAS_VERSION,
      cases: gridSize(),
      declarations: built + failedBuilds,
      failedBuilds,
      node: process.version,
    },
    results,
  };

  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(dump, null, 2)}\n`);
  console.error(
    `grid: ${Object.keys(results).length} cases from ${dump.meta.declarations} declarations` +
      `${failedBuilds > 0 ? ` (${failedBuilds} refused to build)` : ""} -> ${out}`,
  );
}

await main();

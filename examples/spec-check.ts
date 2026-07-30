/**
 * Check a spec instead of checking traffic: validate every example in a
 * document against the schema it illustrates, at startup or in CI.
 *
 * `checkDocumentExamples` is the one check class available as a library
 * call. The other four (`hygiene`, `schema`, `conformance`, `redos`) are
 * composed only by the `oaverify check` command, deliberately: the
 * conformance meta-schemas and the ReDoS detector are both heavyweight
 * dependencies that `@oaverify/core` does not carry. So the recipe is a
 * library call for examples, and the CLI for a full pre-deploy gate.
 *
 * Run from the repo root:
 *   pnpm dlx tsx examples/spec-check.ts
 */

import { fileURLToPath } from "node:url";
import { createYamlFileReader } from "../packages/yaml/src/index.ts";
import { loadSpec } from "../packages/spec/src/index.ts";
import { checkDocumentExamples } from "../packages/validator/src/index.ts";

const specPath = fileURLToPath(new URL("./specs/catalog.yaml", import.meta.url));
const { document } = await loadSpec({ reader: createYamlFileReader(), entry: specPath });

const issues = checkDocumentExamples(document);

if (issues.length === 0) {
  console.log("examples: ok");
} else {
  console.log(`examples: ${issues.length} problem(s)\n`);
  for (const issue of issues) {
    // `pointer` is an RFC 6901 pointer at the offending example value,
    // so it addresses the exact node to fix rather than the operation.
    console.log(`  ${issue.pointer}`);
    console.log(`    ${issue.message}\n`);
  }
}

// A build script gates on the count. Nothing here throws: a bad example
// is a finding about the document, not an exception.
const exitCode = issues.length === 0 ? 0 : 1;
console.log(`would exit ${exitCode}`);

// For the remaining four classes, shell out to the CLI, which owns the
// composition and the exit-code taxonomy:
//
//   oaverify check examples/specs/catalog.yaml
//   oaverify check examples/specs/catalog.yaml --only examples --format json
//   oaverify check examples/specs/catalog.yaml --fail-on warning
//
// `--only examples` runs the same pass this file calls directly, and on
// this spec both report the same three pointers.
//
// Note the threshold: an invalid example is a `warning`, so `--fail-on
// warning` is what gates it. `--fail-on error` exits 0 here, because it
// gates specification violations and an example that contradicts its
// schema is not one. See docs/strictness.md for the classes and
// packages/cli/README.md for the exit codes.

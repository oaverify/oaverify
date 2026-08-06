/**
 * Dump the JS source that ajv and oav generate for each benchmark schema,
 * so we can eyeball structural and allocation differences.
 *
 *   tsx dump-compiled.ts                  # writes to ./compiled-dump/
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import { compileSchema, jsonSchemaDialect } from "../packages/schema/src/index.ts";
import { builtInFormats } from "../packages/formats/src/index.ts";
import { perfSchemas } from "./schemas.ts";

const OUT = new URL("./compiled-dump/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

for (const s of perfSchemas) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const ajvFn = ajv.compile(s.schema);
  writeFileSync(
    join(OUT, `${s.name}.ajv.js`),
    "// ajv (allErrors: true)\n" + ajvFn.toString() + "\n",
  );

  const ajvFast = new Ajv({ allErrors: false, strict: false });
  const ajvFastFn = ajvFast.compile(s.schema);
  writeFileSync(
    join(OUT, `${s.name}.ajv-fast.js`),
    "// ajv (allErrors: false)\n" + ajvFastFn.toString() + "\n",
  );

  const oav = compileSchema(s.schema, {
    dialect: jsonSchemaDialect,
    formats: builtInFormats,
    retainSource: true,
  });
  writeFileSync(
    join(OUT, `${s.name}.oav-flat.js`),
    "// oav (flat, maxErrors: 1)\n" + oav.source + "\n",
  );

  const oavAll = compileSchema(s.schema, {
    dialect: jsonSchemaDialect,
    formats: builtInFormats,
    retainSource: true,
    maxErrors: Number.POSITIVE_INFINITY,
  });
  writeFileSync(
    join(OUT, `${s.name}.oav-all.js`),
    "// oav (flat, all errors)\n" + oavAll.source + "\n",
  );

  const oavTree = compileSchema(s.schema, {
    dialect: jsonSchemaDialect,
    formats: builtInFormats,
    retainSource: true,
    output: "tree",
  });
  writeFileSync(join(OUT, `${s.name}.oav-tree.js`), "// oav (tree)\n" + oavTree.source + "\n");

  const oavPred = compileSchema(s.schema, {
    dialect: jsonSchemaDialect,
    formats: builtInFormats,
    retainSource: true,
    output: "predicate",
  });
  writeFileSync(
    join(OUT, `${s.name}.oav-predicate.js`),
    "// oav (predicate mode)\n" + oavPred.source + "\n",
  );

  console.log(
    `${s.name}: ajv ${ajvFn.toString().length} B, ajv-fast ${ajvFastFn.toString().length} B, ` +
      `oav-flat ${oav.source.length} B, oav-all ${oavAll.source.length} B, ` +
      `oav-tree ${oavTree.source.length} B, oav-pred ${oavPred.source.length} B`,
  );
}

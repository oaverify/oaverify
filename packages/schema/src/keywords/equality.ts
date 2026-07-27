import { NAMES, quoteString } from "../codegen/index.js";
import type { JsonValue } from "@oaverify/internal-core";
import type { KeywordCompileContext, KeywordDefinition } from "./types.js";
import { CORE_VALIDATION_VOCAB } from "./vocabulary-uris.js";

function isJsonPrimitive(v: JsonValue): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * The JSON Schema 2020-12 `enum` keyword. Data must be deep-equal to one of
 * the listed values.
 *
 * @public
 */
export const enumKeyword: KeywordDefinition = {
  keyword: "enum",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const values = ctx.schema as JsonValue[];
    const valuesLit = JSON.stringify(values);
    const prims = values.filter(isJsonPrimitive);
    const objs = values.filter((v) => !isJsonPrimitive(v));

    const emitMismatch = (): void => {
      ctx.emitError(
        "leaf",
        ctx.leafErrorExpr(
          quoteString("enum"),
          `"must be one of the allowed values"`,
          `{ allowed: ${valuesLit}, actual: ${ctx.data} }`,
        ),
      );
    };

    if (objs.length === 0) {
      const setVar = ctx.hoistConstant(`new Set(${JSON.stringify(prims)})`, "enumSet");
      ctx.gen.if(`!${setVar}.has(${ctx.data})`, emitMismatch);
      return;
    }

    const matched = ctx.gen.scope.name("matched");
    const objsVar = ctx.hoistConstant(JSON.stringify(objs), "enumObjs");
    const loopBody = (g: typeof ctx.gen) => {
      g.forOf("candidate", objsVar, (gi) => {
        gi.if(`${NAMES.DEPS}.deepEqual(${ctx.data}, candidate)`, (gii) => {
          gii.line(`${matched} = true;`);
          gii.line("break;");
        });
      });
    };
    if (prims.length > 0) {
      const setVar = ctx.hoistConstant(`new Set(${JSON.stringify(prims)})`, "enumSet");
      ctx.gen.let(matched, `${setVar}.has(${ctx.data})`);
      ctx.gen.if(`!${matched}`, loopBody);
    } else {
      ctx.gen.let(matched, "false");
      loopBody(ctx.gen);
    }
    ctx.gen.if(`!${matched}`, emitMismatch);
  },
};

/**
 * The JSON Schema 2020-12 `const` keyword. Data must be deep-equal to the
 * provided constant.
 *
 * @public
 */
export const constKeyword: KeywordDefinition = {
  keyword: "const",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const value = ctx.schema as JsonValue;
    const valueLit = JSON.stringify(value);
    const checkExpr = isJsonPrimitive(value)
      ? `${ctx.data} !== ${valueLit}`
      : `!${NAMES.DEPS}.deepEqual(${ctx.data}, ${valueLit})`;
    ctx.gen.if(checkExpr, () => {
      ctx.emitError(
        "leaf",
        ctx.leafErrorExpr(
          quoteString("const"),
          `"must equal the expected constant"`,
          `{ expected: ${valueLit}, actual: ${ctx.data} }`,
        ),
      );
    });
  },
};

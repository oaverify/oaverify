import { isObjectPrototypePropertyName } from "@oaverify/internal-core/prototype-properties";
import {
  checkStringArray,
  nonNegativeIntegerLiteral,
  quoteString,
  stringArrayValue,
} from "../codegen/index.js";
import type { KeywordCompileContext, KeywordDefinition } from "./types.js";
import { CORE_VALIDATION_VOCAB } from "./vocabulary-uris.js";

function isObjectGuard(dataExpr: string): string {
  return `typeof ${dataExpr} === "object" && ${dataExpr} !== null && !Array.isArray(${dataExpr})`;
}

/**
 * JS expression: property `keyExpr` is present on `dataExpr`.
 *
 * When the literal name is known and safe, uses `!== undefined` rather
 * than `Object.prototype.hasOwnProperty.call`: the JSON data model has no
 * `undefined`, so for parsed wire data the two are equivalent, and for
 * in-memory objects an `undefined`-valued property is dropped by
 * `JSON.stringify` anyway (so "absent" matches the wire). This is ajv's
 * default and is markedly cheaper than a `hasOwnProperty` call on every
 * check. Falls back to `hasOwnProperty` when the name is omitted (a
 * runtime key) or is an inherited `Object.prototype` name, where
 * `!== undefined` would wrongly report an inherited member as present.
 * The single source of truth for presence so a future
 * `ownProperties`-style strict option has one place to switch.
 */
export function propertyPresent(dataExpr: string, keyExpr: string, keyName?: string): string {
  if (keyName === undefined || isObjectPrototypePropertyName(keyName)) {
    return `Object.prototype.hasOwnProperty.call(${dataExpr}, ${keyExpr})`;
  }
  return `${dataExpr}[${keyExpr}] !== undefined`;
}

/** Negation of {@link propertyPresent}: property `keyExpr` is absent. */
export function propertyAbsent(dataExpr: string, keyExpr: string, keyName?: string): string {
  if (keyName === undefined || isObjectPrototypePropertyName(keyName)) {
    return `!Object.prototype.hasOwnProperty.call(${dataExpr}, ${keyExpr})`;
  }
  return `${dataExpr}[${keyExpr}] === undefined`;
}

/**
 * The object-shape guard, computed once per validator-function scope and
 * shared across every object keyword on the same schema (`type`,
 * `required`, `properties`, `additionalProperties`, ...). Without this
 * each keyword re-emits the guard inline, repeating the `Array.isArray`
 * call per keyword on every object that reaches them. See
 * {@link KeywordCompileContext.scopeLocal}.
 */
function objectGuardVar(ctx: KeywordCompileContext): string {
  return ctx.scopeLocal(`isObject:${ctx.data}`, isObjectGuard(ctx.data), "obj");
}

function keyCountExpr(dataExpr: string): string {
  return `Object.keys(${dataExpr}).length`;
}

/**
 * The JSON Schema `maxProperties` keyword.
 *
 * @public
 */
export const maxPropertiesKeyword: KeywordDefinition = {
  keyword: "maxProperties",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const limit = nonNegativeIntegerLiteral(ctx.schema, "maxProperties");
    const count = ctx.gen.scope.name("count");
    ctx.gen.if(objectGuardVar(ctx), (g) => {
      g.const(count, keyCountExpr(ctx.data));
      g.if(`${count} > ${limit}`, () => {
        ctx.emitError(
          "leaf",
          ctx.leafErrorExpr(
            quoteString("maxProperties"),
            `\`must have at most ${limit} properties\``,
            `{ maxProperties: ${limit}, actual: ${count} }`,
          ),
        );
      });
    });
  },
};

/**
 * The JSON Schema `minProperties` keyword.
 *
 * @public
 */
export const minPropertiesKeyword: KeywordDefinition = {
  keyword: "minProperties",
  vocabulary: CORE_VALIDATION_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const limit = nonNegativeIntegerLiteral(ctx.schema, "minProperties");
    const count = ctx.gen.scope.name("count");
    ctx.gen.if(objectGuardVar(ctx), (g) => {
      g.const(count, keyCountExpr(ctx.data));
      g.if(`${count} < ${limit}`, () => {
        ctx.emitError(
          "leaf",
          ctx.leafErrorExpr(
            quoteString("minProperties"),
            `\`must have at least ${limit} properties\``,
            `{ minProperties: ${limit}, actual: ${count} }`,
          ),
        );
      });
    });
  },
};

/**
 * The JSON Schema `required` keyword. Object data must declare every name
 * in the array. Produces one error per missing property so consumers see a
 * complete report.
 *
 * @public
 */
export const requiredKeyword: KeywordDefinition = {
  keyword: "required",
  vocabulary: CORE_VALIDATION_VOCAB,
  validateKeywordValue: (value) => checkStringArray(value),
  compile(ctx: KeywordCompileContext): void {
    const required = stringArrayValue(ctx.schema, "required");
    if (required.length === 0) return;
    if (required.length <= 8) {
      const emitCheck = (name: string): void => {
        const keyLit = quoteString(name);
        ctx.gen.if(propertyAbsent(ctx.data, keyLit, name), () => {
          ctx.emitError(
            "leaf",
            ctx.leafErrorExpr(
              quoteString("required"),
              JSON.stringify(`must have required property "${name}"`),
              `{ missing: ${keyLit} }`,
              [keyLit],
            ),
          );
          ctx.emitBudgetBreak();
        });
      };
      ctx.gen.if(objectGuardVar(ctx), (g) => {
        if (ctx.predicate) {
          for (const name of required) emitCheck(name);
          return;
        }
        // Keep emitBudgetBreak() valid without paying iterator/dynamic
        // lookup overhead for the common small fixed-list case.
        g.line("do {");
        g.indent();
        for (const name of required) emitCheck(name);
        g.dedent();
        g.line("} while (false);");
      });
      return;
    }
    const requiredVar = ctx.hoistConstant(JSON.stringify(required), "required");
    // The loop variable is dynamic, but the set of names is fixed at
    // compile time: if none of them is an inherited `Object.prototype`
    // name, every iteration is safe to check with the cheap
    // `data[_req] === undefined`; otherwise fall back to `hasOwnProperty`
    // for the whole loop. Keeps `required` consistent with `properties`
    // (an `undefined`-valued safe property is "absent" in both).
    const absent = required.every((k) => !isObjectPrototypePropertyName(k))
      ? `${ctx.data}[_req] === undefined`
      : `!Object.prototype.hasOwnProperty.call(${ctx.data}, _req)`;
    if (ctx.predicate) {
      ctx.gen.if(objectGuardVar(ctx), (g) => {
        g.forOf("_req", requiredVar, (gi) => {
          gi.line(`if (${absent}) return false;`);
        });
      });
      return;
    }
    // Single pass: emit one leaf per missing key directly from the
    // membership scan. The loop is kept so `emitBudgetBreak` can `break`
    // out of it on budget exhaustion; error order and the truncation
    // flag are unchanged.
    ctx.gen.if(objectGuardVar(ctx), (g) => {
      g.forOf("_req", requiredVar, (gi) => {
        gi.if(absent, () => {
          ctx.emitError(
            "leaf",
            ctx.leafErrorExpr(
              quoteString("required"),
              `\`must have required property "\${_req}"\``,
              `{ missing: _req }`,
              ["_req"],
            ),
          );
          ctx.emitBudgetBreak();
        });
      });
    });
  },
};

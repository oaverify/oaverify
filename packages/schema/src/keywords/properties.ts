import { NAMES, quoteString } from "../codegen/index.js";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { propertyPresent } from "./object-validation.js";
import type { KeywordCompileContext, KeywordDefinition } from "./types.js";
import { APPLICATOR_VOCAB } from "./vocabulary-uris.js";

function isObjectGuard(dataExpr: string): string {
  return `typeof ${dataExpr} === "object" && ${dataExpr} !== null && !Array.isArray(${dataExpr})`;
}

/**
 * Shared object-shape guard for this scope. Same cache key as the
 * object-validation keywords, so `properties` and `required` on one
 * schema reference a single emitted `const`. See
 * {@link KeywordCompileContext.scopeLocal}.
 */
function objectGuardVar(ctx: KeywordCompileContext): string {
  return ctx.scopeLocal(`isObject:${ctx.data}`, isObjectGuard(ctx.data), "obj");
}

/**
 * Whether it pays to bind a property's value to a local before
 * validating it. Object subschemas read the value (often several
 * times, and across opaque helper calls V8 can't see through, which
 * would otherwise force re-reads of `data[key]`); booleans and the
 * empty schema never touch it, so binding there would just add a dead
 * property read per key.
 */
function bindsValue(sub: SchemaOrBoolean): boolean {
  return typeof sub === "object" && sub !== null && Object.keys(sub).length > 0;
}

/**
 * The `properties` keyword. For each named property present in the data,
 * validate its value against the corresponding subschema.
 *
 * @public
 */
export const propertiesKeyword: KeywordDefinition = {
  keyword: "properties",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  compile(ctx: KeywordCompileContext): void {
    const props = ctx.schema as Record<string, SchemaOrBoolean>;
    ctx.gen.if(objectGuardVar(ctx), (g) => {
      for (const name of Object.keys(props)) {
        const subSchema = props[name];
        if (subSchema === undefined) continue;
        const keyLit = quoteString(name);
        g.if(propertyPresent(ctx.data, keyLit, name), (gi) => {
          let dataExpr = `${ctx.data}[${keyLit}]`;
          if (bindsValue(subSchema)) {
            const valueVar = gi.scope.name("v");
            gi.const(valueVar, dataExpr);
            dataExpr = valueVar;
          }
          ctx.validateSubschema(subSchema, dataExpr, { segment: keyLit });
          if (ctx.evaluatedPropertiesVar !== null) {
            gi.line(`${ctx.evaluatedPropertiesVar}.add(${keyLit});`);
          }
        });
      }
    });
  },
  evaluates: { properties: true },
};

/**
 * The `patternProperties` keyword. Keys matching each regex are validated
 * against the corresponding subschema. A single key may match multiple
 * patterns and be validated against each.
 *
 * @public
 */
export const patternPropertiesKeyword: KeywordDefinition = {
  keyword: "patternProperties",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  compile(ctx: KeywordCompileContext): void {
    const patterns = ctx.schema as Record<string, SchemaOrBoolean>;
    const entries = Object.keys(patterns);
    if (entries.length === 0) return;
    const subs: Array<{ regex: string; sub: SchemaOrBoolean | undefined }> = entries.map(
      (pattern) => {
        const subSchema = patterns[pattern];
        const patternLit = quoteString(pattern);
        const regexVar = ctx.hoistConstant(`${NAMES.DEPS}.compilePattern(${patternLit})`, "re");
        return { regex: regexVar, sub: subSchema };
      },
    );
    ctx.gen.if(objectGuardVar(ctx), (g) => {
      const keyVar = g.scope.name("key");
      g.forIn(keyVar, ctx.data, (gi) => {
        for (const { regex, sub } of subs) {
          if (sub === undefined) continue;
          gi.if(`${regex}.test(${keyVar})`, (gii) => {
            ctx.validateSubschema(sub, `${ctx.data}[${keyVar}]`, { segment: keyVar });
            if (ctx.evaluatedPropertiesVar !== null) {
              gii.line(`${ctx.evaluatedPropertiesVar}.add(${keyVar});`);
            }
          });
        }
        ctx.emitBudgetBreak();
      });
    });
  },
  evaluates: { properties: true },
};

/**
 * The `additionalProperties` keyword. Validates every property NOT covered
 * by `properties` or `patternProperties` against the given subschema.
 *
 * @public
 */
export const additionalPropertiesKeyword: KeywordDefinition = {
  keyword: "additionalProperties",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  compile(ctx: KeywordCompileContext): void {
    const subSchema = ctx.schema as SchemaOrBoolean;
    const knownProps = Object.keys(ctx.parentSchema.properties ?? {});
    const patterns = Object.keys(ctx.parentSchema.patternProperties ?? {});
    const knownSet = knownProps.length > 0 ? JSON.stringify(knownProps) : "[]";
    const patternVars: string[] = patterns.map((p) =>
      ctx.hoistConstant(`${NAMES.DEPS}.compilePattern(${quoteString(p)})`, "re"),
    );
    const known = ctx.hoistConstant(`new Set(${knownSet})`, "known");
    ctx.gen.if(objectGuardVar(ctx), (g) => {
      const key = g.scope.name("key");
      g.forIn(key, ctx.data, (gi) => {
        gi.if(`${known}.has(${key})`, (gii) => gii.line("continue;"));
        for (const v of patternVars) {
          gi.if(`${v}.test(${key})`, (gii) => gii.line("continue;"));
        }
        if (subSchema === true) {
          if (ctx.evaluatedPropertiesVar !== null) {
            gi.line(`${ctx.evaluatedPropertiesVar}.add(${key});`);
          }
          return;
        }
        if (subSchema === false) {
          ctx.emitError(
            "leaf",
            ctx.leafErrorExpr(
              quoteString("additionalProperties"),
              `\`additional property "\${${key}}" is not allowed\``,
              `{ unexpected: ${key} }`,
              [key],
            ),
          );
          ctx.emitBudgetBreak();
          return;
        }
        let dataExpr = `${ctx.data}[${key}]`;
        if (bindsValue(subSchema)) {
          const valueVar = gi.scope.name("v");
          gi.const(valueVar, dataExpr);
          dataExpr = valueVar;
        }
        ctx.validateSubschema(subSchema, dataExpr, { segment: key });
        if (ctx.evaluatedPropertiesVar !== null) {
          gi.line(`${ctx.evaluatedPropertiesVar}.add(${key});`);
        }
        ctx.emitBudgetBreak();
      });
    });
  },
  evaluates: { properties: true },
};

/**
 * The `propertyNames` keyword. Each key name is validated as a string
 * against the given subschema.
 *
 * @public
 */
export const propertyNamesKeyword: KeywordDefinition = {
  keyword: "propertyNames",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  compile(ctx: KeywordCompileContext): void {
    const subSchema = ctx.schema as SchemaOrBoolean;
    ctx.gen.if(objectGuardVar(ctx), (g) => {
      const key = g.scope.name("key");
      g.forIn(key, ctx.data, () => {
        ctx.validateSubschema(subSchema, key, { segment: key });
        ctx.emitBudgetBreak();
      });
    });
  },
};

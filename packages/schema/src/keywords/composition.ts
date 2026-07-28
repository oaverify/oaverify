import { quoteString, stringArrayValue } from "../codegen/index.js";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { propertyAbsent, propertyPresent } from "./object-validation.js";
import type { KeywordCompileContext, KeywordDefinition } from "./types.js";
import { APPLICATOR_VOCAB } from "./vocabulary-uris.js";

/**
 * Two-phase composition error materialization (#338). Called inside the
 * failure guard of `anyOf` / `oneOf`, after a predicate-only decision
 * phase has already determined the composition fails. Re-runs every
 * branch in the enclosing error mode and collects the failing ones,
 * then emits the same node (tree) or flat leaves + marker (flat) the
 * eager path would have produced. Branches that pass return
 * `null`/empty and contribute nothing, so re-running all of them
 * reproduces the eager output exactly (the matching branches never had
 * errors). Runs only on the failure path, so the re-validation cost is
 * off the valid hot path.
 *
 * Gated by the caller on this scope tracking no evaluated keys, so
 * branches take `(data, path)` with no eval out-params.
 */
function emitCompositionErrors(
  ctx: KeywordCompileContext,
  schemas: SchemaOrBoolean[],
  codeExpr: string,
  messageExpr: string,
  paramsExpr: string,
): void {
  if (ctx.flat) {
    const buf = ctx.gen.scope.name("compBuf");
    ctx.gen.let(buf, "null");
    schemas.forEach((sub) => {
      const fn = ctx.compileSubschema(sub);
      const e = ctx.gen.scope.name("e");
      ctx.gen.const(e, `${fn}(${ctx.data}, ${ctx.path})`);
      ctx.gen.if(`${e} !== null`, () => ctx.gen.line(ctx.appendErrorsStatement(buf, e)));
    });
    ctx.gen.line(ctx.appendErrorsStatement(ctx.errors, buf));
    ctx.emitError("leaf", ctx.leafErrorExpr(codeExpr, messageExpr, paramsExpr));
    return;
  }
  const errsVar = ctx.gen.scope.name("compErrs");
  ctx.gen.const(errsVar, "[]");
  schemas.forEach((sub) => {
    const fn = ctx.compileSubschema(sub);
    const e = ctx.gen.scope.name("e");
    ctx.gen.const(e, `${fn}(${ctx.data}, ${ctx.path})`);
    ctx.gen.if(`${e} !== null`, () => ctx.gen.line(`${errsVar}.push(${e});`));
  });
  ctx.emitError("lift", ctx.branchErrorExpr(codeExpr, messageExpr, errsVar, paramsExpr));
}

/**
 * The `allOf` keyword. Every subschema must validate. Children of the
 * produced error are the failing conjuncts.
 *
 * @public
 */
export const allOfKeyword: KeywordDefinition = {
  keyword: "allOf",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  compile(ctx: KeywordCompileContext): void {
    const schemas = ctx.schema as SchemaOrBoolean[];
    if (schemas.length === 0) return;
    const outProps = ctx.evaluatedPropertiesVar;
    const outItems = ctx.evaluatedItemsVar;
    if (ctx.flat) {
      // Flat mode: every conjunct must pass, so each failing branch's
      // leaves surface directly with no wrapper and no marker (matching
      // ajv, which exposes the failing subschema's errors as-is).
      schemas.forEach((sub) => {
        ctx.compileAndCallSubschema(sub, {
          data: ctx.data,
          onPass: (g, bProps, bItems) => {
            if (outProps !== null && bProps !== null) {
              g.line(`for (const k of ${bProps}) ${outProps}.add(k);`);
            }
            if (outItems !== null && bItems !== null) {
              g.line(`for (const k of ${bItems}) ${outItems}.add(k);`);
            }
          },
          onFail: (g, errVar) => {
            if (errVar !== null) g.line(ctx.errorStatement("lift", errVar));
          },
        });
      });
      return;
    }
    // Tree mode collects per-branch errors; predicate short-circuits
    // on first failure so there's nothing to collect.
    const errsVar = ctx.predicate ? null : ctx.gen.scope.name("allOfErrs");
    if (errsVar !== null) ctx.gen.const(errsVar, "[]");
    schemas.forEach((sub) => {
      ctx.compileAndCallSubschema(sub, {
        data: ctx.data,
        onPass: (g, bProps, bItems) => {
          if (outProps !== null && bProps !== null) {
            g.line(`for (const k of ${bProps}) ${outProps}.add(k);`);
          }
          if (outItems !== null && bItems !== null) {
            g.line(`for (const k of ${bItems}) ${outItems}.add(k);`);
          }
        },
        onFail: (g, errVar) => {
          if (errVar === null) g.line("return false;");
          else g.line(`${errsVar}.push(${errVar});`);
        },
      });
    });
    if (errsVar !== null) {
      const n = schemas.length;
      ctx.gen.if(`${errsVar}.length > 0`, () => {
        ctx.emitError(
          "lift",
          ctx.branchErrorExpr(
            quoteString("allOf"),
            `\`must satisfy all ${n} schemas (\${${errsVar}.length} failed)\``,
            errsVar,
            `{ total: ${n}, failed: ${errsVar}.length }`,
          ),
        );
      });
    }
  },
};

/**
 * The `anyOf` keyword. At least one subschema must validate. Children of the
 * produced error (emitted only when NONE match) are the branch errors.
 *
 * @public
 */
export const anyOfKeyword: KeywordDefinition = {
  keyword: "anyOf",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  compile(ctx: KeywordCompileContext): void {
    const schemas = ctx.schema as SchemaOrBoolean[];
    if (schemas.length === 0) return;
    const outProps = ctx.evaluatedPropertiesVar;
    const outItems = ctx.evaluatedItemsVar;
    const n = schemas.length;
    if (!ctx.predicate && outProps === null && outItems === null) {
      // Two-phase (#338): decide with predicate-compiled branches, which
      // allocate no errors, short-circuiting on the first match. Only if
      // none match do we re-run the branches in error mode to build the
      // errors. The valid path (some branch matches) builds no throwaway
      // error tree for the non-matching branches.
      const decision = schemas
        .map((sub) => `${ctx.compileSubschema(sub, "predicate")}(${ctx.data})`)
        .join(" || ");
      const matched = ctx.gen.scope.name("matched");
      ctx.gen.const(matched, decision);
      ctx.gen.if(`!${matched}`, () => {
        emitCompositionErrors(
          ctx,
          schemas,
          quoteString("anyOf"),
          `\`must match at least one of ${n} schemas\``,
          `{ total: ${n} }`,
        );
      });
      return;
    }
    if (ctx.flat) {
      // Flat mode (eval tracking on): buffer each failing branch's
      // leaves; if some branch matched, discard the buffer (anyOf
      // succeeds). Otherwise flush the collected branch leaves flat and
      // append a single childless `anyOf` marker so the failure is not
      // anonymous.
      const matched = ctx.gen.scope.name("matched");
      ctx.gen.let(matched, "false");
      const buf = ctx.gen.scope.name("anyOfBuf");
      ctx.gen.let(buf, "null");
      schemas.forEach((sub) => {
        ctx.compileAndCallSubschema(sub, {
          data: ctx.data,
          onPass: (g, bProps, bItems) => {
            g.line(`${matched} = true;`);
            if (outProps !== null && bProps !== null) {
              g.line(`for (const k of ${bProps}) ${outProps}.add(k);`);
            }
            if (outItems !== null && bItems !== null) {
              g.line(`for (const k of ${bItems}) ${outItems}.add(k);`);
            }
          },
          onFail: (g, errVar) => {
            if (errVar !== null) g.line(ctx.appendErrorsStatement(buf, errVar));
          },
        });
      });
      ctx.gen.if(`!${matched}`, () => {
        ctx.gen.line(ctx.appendErrorsStatement(ctx.errors, buf));
        ctx.emitError(
          "leaf",
          ctx.leafErrorExpr(
            quoteString("anyOf"),
            `\`must match at least one of ${n} schemas\``,
            `{ total: ${n} }`,
          ),
        );
      });
      return;
    }
    const matched = ctx.gen.scope.name("matched");
    ctx.gen.let(matched, "false");
    // Tree mode collects per-branch errors for the final anyOf node;
    // predicate returns false after the loop if none matched.
    const errsVar = ctx.predicate ? null : ctx.gen.scope.name("anyOfErrs");
    if (errsVar !== null) ctx.gen.const(errsVar, "[]");
    schemas.forEach((sub) => {
      ctx.compileAndCallSubschema(sub, {
        data: ctx.data,
        onPass: (g, bProps, bItems) => {
          g.line(`${matched} = true;`);
          if (outProps !== null && bProps !== null) {
            g.line(`for (const k of ${bProps}) ${outProps}.add(k);`);
          }
          if (outItems !== null && bItems !== null) {
            g.line(`for (const k of ${bItems}) ${outItems}.add(k);`);
          }
        },
        onFail: (g, errVar) => {
          if (errVar !== null) g.line(`${errsVar}.push(${errVar});`);
          // predicate mode: no-op, the final `!matched` check handles it
        },
      });
    });
    if (ctx.predicate) {
      ctx.gen.line(`if (!${matched}) return false;`);
      return;
    }
    ctx.gen.if(`!${matched}`, () => {
      ctx.emitError(
        "lift",
        ctx.branchErrorExpr(
          quoteString("anyOf"),
          `\`must match at least one of ${n} schemas\``,
          errsVar!,
          `{ total: ${n} }`,
        ),
      );
    });
  },
};

/**
 * The `oneOf` keyword. Exactly one subschema must validate. Children of the
 * produced error are the per-branch failures.
 *
 * @public
 */
export const oneOfKeyword: KeywordDefinition = {
  keyword: "oneOf",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  compile(ctx: KeywordCompileContext): void {
    const schemas = ctx.schema as SchemaOrBoolean[];
    if (schemas.length === 0) return;
    const outProps = ctx.evaluatedPropertiesVar;
    const outItems = ctx.evaluatedItemsVar;
    const n = schemas.length;
    if (!ctx.predicate && outProps === null && outItems === null) {
      // Two-phase (#338): count matches with predicate-compiled branches
      // (no error allocation; all must run since oneOf needs the exact
      // count). Only on a non-unique match do we re-run the branches in
      // error mode. Re-running all reproduces the eager output: matching
      // branches return null and contribute nothing, so the collected
      // set is exactly the failing branches, same as today (preserving
      // output on both the 0-match and >1-match paths).
      const decision = schemas
        .map((sub) => `(${ctx.compileSubschema(sub, "predicate")}(${ctx.data}) ? 1 : 0)`)
        .join(" + ");
      const matchCount = ctx.gen.scope.name("oneOfMatched");
      ctx.gen.const(matchCount, decision);
      ctx.gen.if(`${matchCount} !== 1`, () => {
        emitCompositionErrors(
          ctx,
          schemas,
          quoteString("oneOf"),
          `\`must match exactly one of ${n} schemas (matched \${${matchCount}})\``,
          `{ total: ${n}, matchCount: ${matchCount} }`,
        );
      });
      return;
    }
    if (ctx.flat) {
      // Flat mode (eval tracking on): count matches and buffer each
      // failing branch's leaves. oneOf fails unless exactly one branch
      // matched; on failure, flush the collected failing-branch leaves
      // flat and append a single childless `oneOf` marker (carrying the
      // observed match count). The buffer may be null when more than one
      // branch matched and none failed; `appendErrors` is null-safe.
      const matched = ctx.gen.scope.name("oneOfMatched");
      ctx.gen.let(matched, "0");
      const buf = ctx.gen.scope.name("oneOfBuf");
      ctx.gen.let(buf, "null");
      schemas.forEach((sub) => {
        ctx.compileAndCallSubschema(sub, {
          data: ctx.data,
          onPass: (g, bProps, bItems) => {
            g.line(`${matched} += 1;`);
            if (outProps !== null && bProps !== null) {
              g.line(`for (const k of ${bProps}) ${outProps}.add(k);`);
            }
            if (outItems !== null && bItems !== null) {
              g.line(`for (const k of ${bItems}) ${outItems}.add(k);`);
            }
          },
          onFail: (g, errVar) => {
            if (errVar !== null) g.line(ctx.appendErrorsStatement(buf, errVar));
          },
        });
      });
      ctx.gen.if(`${matched} !== 1`, () => {
        ctx.gen.line(ctx.appendErrorsStatement(ctx.errors, buf));
        ctx.emitError(
          "leaf",
          ctx.leafErrorExpr(
            quoteString("oneOf"),
            `\`must match exactly one of ${n} schemas (matched \${${matched}})\``,
            `{ total: ${n}, matchCount: ${matched} }`,
          ),
        );
      });
      return;
    }
    if (ctx.predicate) {
      // Predicate mode: count branch matches; bail with `return false`
      // on the second match (>1 disallowed) or if fewer than 1
      // succeed. Evaluated keys from the single passing branch merge
      // into the caller. We buffer them per-branch and only commit
      // once we know we had exactly one match.
      const matchCount = ctx.gen.scope.name("oneOfMatched");
      ctx.gen.let(matchCount, "0");
      const keepProps = outProps !== null ? ctx.gen.scope.name("oneOfProps") : null;
      const keepItems = outItems !== null ? ctx.gen.scope.name("oneOfItems") : null;
      if (keepProps !== null) ctx.gen.let(keepProps, "null");
      if (keepItems !== null) ctx.gen.let(keepItems, "null");
      schemas.forEach((sub) => {
        const fn = ctx.compileSubschema(sub);
        if (outProps === null && outItems === null) {
          ctx.gen.if(`${fn}(${ctx.data})`, (g) => {
            g.line(`${matchCount} += 1;`);
            g.line(`if (${matchCount} > 1) return false;`);
          });
          return;
        }
        const propsVar = ctx.gen.scope.name("bProps");
        const itemsVar = ctx.gen.scope.name("bItems");
        ctx.gen.const(propsVar, outProps !== null ? "new Set()" : "undefined");
        ctx.gen.const(itemsVar, outItems !== null ? "new Set()" : "undefined");
        ctx.gen.if(`${fn}(${ctx.data}, ${propsVar}, ${itemsVar})`, (g) => {
          g.line(`${matchCount} += 1;`);
          g.line(`if (${matchCount} > 1) return false;`);
          if (keepProps !== null) g.line(`${keepProps} = ${propsVar};`);
          if (keepItems !== null) g.line(`${keepItems} = ${itemsVar};`);
        });
      });
      ctx.gen.line(`if (${matchCount} !== 1) return false;`);
      if (keepProps !== null && outProps !== null) {
        ctx.gen.line(
          `if (${keepProps} !== null) for (const k of ${keepProps}) ${outProps}.add(k);`,
        );
      }
      if (keepItems !== null && outItems !== null) {
        ctx.gen.line(
          `if (${keepItems} !== null) for (const k of ${keepItems}) ${outItems}.add(k);`,
        );
      }
      return;
    }
    const errsVar = ctx.gen.scope.name("oneOfErrs");
    const matchCount = ctx.gen.scope.name("matched");
    ctx.gen.const(errsVar, "[]");
    ctx.gen.let(matchCount, "0");
    schemas.forEach((sub) => {
      const fn = ctx.compileSubschema(sub);
      const errVar = ctx.gen.scope.name("e");
      if (outProps === null && outItems === null) {
        ctx.gen.const(errVar, `${fn}(${ctx.data}, ${ctx.path})`);
        ctx.gen.if(
          `${errVar} === null`,
          (g) => g.line(`${matchCount} += 1;`),
          (g) => g.line(`${errsVar}.push(${errVar});`),
        );
        return;
      }
      const propsVar = ctx.gen.scope.name("bProps");
      const itemsVar = ctx.gen.scope.name("bItems");
      ctx.gen.const(propsVar, outProps !== null ? "new Set()" : "undefined");
      ctx.gen.const(itemsVar, outItems !== null ? "new Set()" : "undefined");
      ctx.gen.const(errVar, `${fn}(${ctx.data}, ${ctx.path}, ${propsVar}, ${itemsVar})`);
      ctx.gen.if(
        `${errVar} === null`,
        (g) => {
          g.line(`${matchCount} += 1;`);
          if (outProps !== null) g.line(`for (const k of ${propsVar}) ${outProps}.add(k);`);
          if (outItems !== null) g.line(`for (const k of ${itemsVar}) ${outItems}.add(k);`);
        },
        (g) => g.line(`${errsVar}.push(${errVar});`),
      );
    });
    ctx.gen.if(`${matchCount} !== 1`, () => {
      ctx.emitError(
        "lift",
        ctx.branchErrorExpr(
          quoteString("oneOf"),
          `\`must match exactly one of ${n} schemas (matched \${${matchCount}})\``,
          errsVar,
          `{ total: ${n}, matchCount: ${matchCount} }`,
        ),
      );
    });
  },
};

/**
 * The `not` keyword. Data must NOT validate against the subschema.
 *
 * @public
 */
export const notKeyword: KeywordDefinition = {
  keyword: "not",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  compile(ctx: KeywordCompileContext): void {
    const sub = ctx.schema as SchemaOrBoolean;
    // `not` consumes only the sub's pass/fail and never surfaces its
    // errors or annotations, so compile it as a predicate regardless of
    // this function's mode. The valid path (sub fails -> `not` passes)
    // then builds no throwaway error tree. `predFn(data)` is `true` iff
    // the sub matches, which is exactly when `not` must report.
    const predFn = ctx.compileSubschema(sub, "predicate");
    if (ctx.predicate) {
      ctx.gen.line(`if (${predFn}(${ctx.data})) return false;`);
      return;
    }
    ctx.gen.if(`${predFn}(${ctx.data})`, () => {
      ctx.emitError(
        "leaf",
        ctx.leafErrorExpr(quoteString("not"), `"must NOT match the schema"`, `{}`),
      );
    });
  },
};

/**
 * The `if` / `then` / `else` triplet. Handled as one keyword because the
 * three are semantically coupled: `if` branches into `then` (on match) or
 * `else` (on mismatch), and `if` itself emits no errors.
 *
 * @public
 */
export const ifThenElseKeyword: KeywordDefinition = {
  keyword: "if",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  implements: ["then", "else"],
  compile(ctx: KeywordCompileContext): void {
    const ifSchema = ctx.schema as SchemaOrBoolean;
    const thenSchema = ctx.parentSchema.then;
    const elseSchema = ctx.parentSchema.else;
    const outProps = ctx.evaluatedPropertiesVar;
    const outItems = ctx.evaluatedItemsVar;

    // Two-phase: when this scope tracks no evaluated keys, the `if`
    // condition's only consumed output is its pass/fail (its annotations
    // would only matter for `unevaluated*`), so compile it as a predicate
    // and skip building, then discarding, its error tree on the common
    // else-taken path. `then` / `else` stay in error mode -- their errors
    // are reported.
    if (!ctx.predicate && outProps === null && outItems === null) {
      const ifPred = ctx.compileSubschema(ifSchema, "predicate");
      ctx.gen.if(
        `${ifPred}(${ctx.data})`,
        (g) => {
          if (thenSchema !== undefined) {
            const tFn = ctx.compileSubschema(thenSchema);
            const tErr = g.scope.name("thenErr");
            g.const(tErr, `${tFn}(${ctx.data}, ${ctx.path})`);
            g.if(`${tErr} !== null`, () => ctx.emitError("lift", tErr));
          }
        },
        (g) => {
          if (elseSchema !== undefined) {
            const eFn = ctx.compileSubschema(elseSchema);
            const eErr = g.scope.name("elseErr");
            g.const(eErr, `${eFn}(${ctx.data}, ${ctx.path})`);
            g.if(`${eErr} !== null`, () => ctx.emitError("lift", eErr));
          }
        },
      );
      return;
    }

    const ifFn = ctx.compileSubschema(ifSchema);
    const ifProps = ctx.gen.scope.name("ifProps");
    const ifItems = ctx.gen.scope.name("ifItems");
    ctx.gen.const(ifProps, outProps !== null ? "new Set()" : "undefined");
    ctx.gen.const(ifItems, outItems !== null ? "new Set()" : "undefined");
    const passProps = outProps ?? "undefined";
    const passItems = outItems ?? "undefined";
    if (ctx.predicate) {
      // Predicate mode: `if` never emits an error itself; it branches
      // into `then` or `else`. When `if` matches, merge its annotations
      // into the caller before running `then`.
      ctx.gen.if(
        `${ifFn}(${ctx.data}, ${ifProps}, ${ifItems})`,
        (g) => {
          if (outProps !== null) g.line(`for (const k of ${ifProps}) ${outProps}.add(k);`);
          if (outItems !== null) g.line(`for (const k of ${ifItems}) ${outItems}.add(k);`);
          if (thenSchema !== undefined) {
            const tFn = ctx.compileSubschema(thenSchema);
            g.line(`if (!${tFn}(${ctx.data}, ${passProps}, ${passItems})) return false;`);
          }
        },
        (g) => {
          if (elseSchema !== undefined) {
            const eFn = ctx.compileSubschema(elseSchema);
            g.line(`if (!${eFn}(${ctx.data}, ${passProps}, ${passItems})) return false;`);
          }
        },
      );
      return;
    }
    const ifErr = ctx.gen.scope.name("ifErr");
    // Per 2020-12: annotations from `if` are preserved when `if` passes
    // and merged into the enclosing scope alongside `then`'s. Give `if`
    // its own Set so failing runs don't leak keys into `else`'s path.
    ctx.gen.const(ifErr, `${ifFn}(${ctx.data}, ${ctx.path}, ${ifProps}, ${ifItems})`);
    ctx.gen.if(
      `${ifErr} === null`,
      (g) => {
        if (outProps !== null) g.line(`for (const k of ${ifProps}) ${outProps}.add(k);`);
        if (outItems !== null) g.line(`for (const k of ${ifItems}) ${outItems}.add(k);`);
        if (thenSchema !== undefined) {
          const tFn = ctx.compileSubschema(thenSchema);
          const tErr = g.scope.name("thenErr");
          g.const(tErr, `${tFn}(${ctx.data}, ${ctx.path}, ${passProps}, ${passItems})`);
          g.if(`${tErr} !== null`, () => ctx.emitError("lift", tErr));
        }
      },
      (g) => {
        if (elseSchema !== undefined) {
          const eFn = ctx.compileSubschema(elseSchema);
          const eErr = g.scope.name("elseErr");
          g.const(eErr, `${eFn}(${ctx.data}, ${ctx.path}, ${passProps}, ${passItems})`);
          g.if(`${eErr} !== null`, () => ctx.emitError("lift", eErr));
        }
      },
    );
  },
};

/**
 * The `dependentSchemas` keyword. When a given property is present, the
 * whole object is validated against the dependent subschema.
 *
 * @public
 */
export const dependentSchemasKeyword: KeywordDefinition = {
  keyword: "dependentSchemas",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  compile(ctx: KeywordCompileContext): void {
    const deps = ctx.schema as Record<string, SchemaOrBoolean>;
    ctx.gen.if(
      `typeof ${ctx.data} === "object" && ${ctx.data} !== null && !Array.isArray(${ctx.data})`,
      (g) => {
        const passProps = ctx.evaluatedPropertiesVar ?? "undefined";
        const passItems = ctx.evaluatedItemsVar ?? "undefined";
        for (const name of Object.keys(deps)) {
          const sub = deps[name];
          if (sub === undefined) continue;
          const fn = ctx.compileSubschema(sub);
          const keyLit = quoteString(name);
          g.if(propertyPresent(ctx.data, keyLit, name), (gi) => {
            if (ctx.predicate) {
              gi.line(`if (!${fn}(${ctx.data}, ${passProps}, ${passItems})) return false;`);
              return;
            }
            const errVar = gi.scope.name("e");
            gi.const(errVar, `${fn}(${ctx.data}, ${ctx.path}, ${passProps}, ${passItems})`);
            gi.if(`${errVar} !== null`, () => ctx.emitError("lift", errVar));
          });
        }
      },
    );
  },
};

/**
 * The draft-07-compat `dependencies` keyword. Dispatches per entry:
 * array values get `dependentRequired` semantics; object/boolean
 * values get `dependentSchemas` semantics. Kept as a distinct
 * keyword so schemas authored against older drafts but served under
 * a 2020-12 dialect still validate.
 *
 * @public
 */
export const dependenciesKeyword: KeywordDefinition = {
  keyword: "dependencies",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  compile(ctx: KeywordCompileContext): void {
    const deps = ctx.schema as Record<string, string[] | SchemaOrBoolean>;
    ctx.gen.if(
      `typeof ${ctx.data} === "object" && ${ctx.data} !== null && !Array.isArray(${ctx.data})`,
      (g) => {
        for (const trigger of Object.keys(deps)) {
          const entry = deps[trigger];
          if (entry === undefined) continue;
          const triggerLit = quoteString(trigger);
          if (Array.isArray(entry)) {
            // Array form → required-property semantics.
            g.if(propertyPresent(ctx.data, triggerLit, trigger), (gi) => {
              for (const prop of entry) {
                const propLit = quoteString(prop);
                gi.if(propertyAbsent(ctx.data, propLit, prop), () => {
                  ctx.emitError(
                    "leaf",
                    ctx.leafErrorExpr(
                      quoteString("dependencies"),
                      quoteString(`property "${prop}" is required when "${trigger}" is present`),
                      `{ trigger: ${triggerLit}, missing: ${propLit} }`,
                      [propLit],
                    ),
                  );
                });
              }
            });
          } else {
            // Schema form → dependent-schema semantics.
            const fn = ctx.compileSubschema(entry);
            g.if(propertyPresent(ctx.data, triggerLit, trigger), (gi) => {
              if (ctx.predicate) {
                gi.line(`if (!${fn}(${ctx.data})) return false;`);
                return;
              }
              const errVar = gi.scope.name("e");
              gi.const(errVar, `${fn}(${ctx.data}, ${ctx.path})`);
              gi.if(`${errVar} !== null`, () => ctx.emitError("lift", errVar));
            });
          }
        }
      },
    );
  },
};

/**
 * The `dependentRequired` keyword. When a given property is present, each
 * listed companion property must also be present.
 *
 * @public
 */
export const dependentRequiredKeyword: KeywordDefinition = {
  keyword: "dependentRequired",
  vocabulary: APPLICATOR_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const deps = ctx.schema as Record<string, unknown>;
    ctx.gen.if(
      `typeof ${ctx.data} === "object" && ${ctx.data} !== null && !Array.isArray(${ctx.data})`,
      (g) => {
        for (const trigger of Object.keys(deps)) {
          const raw = deps[trigger];
          if (raw === undefined) continue;
          // Same trap as `required`: an unchecked cast lets a bare
          // string through, and iterating it yields its characters.
          const required = stringArrayValue(raw, `dependentRequired.${trigger}`);
          const triggerLit = quoteString(trigger);
          g.if(propertyPresent(ctx.data, triggerLit, trigger), (gi) => {
            for (const prop of required) {
              const propLit = quoteString(prop);
              gi.if(propertyAbsent(ctx.data, propLit, prop), () => {
                ctx.emitError(
                  "leaf",
                  ctx.leafErrorExpr(
                    quoteString("dependentRequired"),
                    quoteString(`property "${prop}" is required when "${trigger}" is present`),
                    `{ trigger: ${triggerLit}, missing: ${propLit} }`,
                    [propLit],
                  ),
                );
              });
            }
          });
        }
      },
    );
  },
};

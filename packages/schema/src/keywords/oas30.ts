/**
 * OpenAPI 3.0.x Schema Object keywords.
 *
 * 3.0 uses a constrained JSON Schema Wright-00 dialect with three
 * deviations from the 2020-12 dialect used by 3.1 / 3.2:
 *
 * 1. `type` is a single string (never an array), and nullability is
 *    expressed via a sibling `nullable: true` instead of
 *    `type: ["…", "null"]`.
 * 2. `exclusiveMaximum` / `exclusiveMinimum` are **booleans**: they
 *    modify the sibling `maximum` / `minimum` rather than standing
 *    alone as numeric bounds.
 * 3. `$ref`, when present, causes every sibling keyword to be
 *    ignored. The containing schema is _only_ the reference.
 *
 * Each of these gets its own keyword implementation in this file;
 * everything else (string/array/object bounds, required, enum, the
 * applicators we support in 3.0, etc.) reuses the 2020-12 vocabulary
 * as-is.
 *
 * @packageDocumentation
 */

import { NAMES, numberLiteral, quoteString } from "../codegen/index.js";
import {
  buildTypeMismatchCondition,
  OAS30_TYPE_NAMES,
  suggestTypeName,
} from "./type-predicates.js";
import type { KeywordCompileContext, KeywordDefinition } from "./types.js";
import { OAS30_VOCAB } from "./vocabulary-uris.js";

/**
 * The `type` keyword in OAS 3.0: MUST be a single string. If the
 * sibling `nullable: true` is also set, the predicate additionally
 * admits `null`.
 *
 * @public
 */
export const oas30TypeKeyword: KeywordDefinition = {
  keyword: "type",
  vocabulary: OAS30_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    if (typeof ctx.schema !== "string") {
      throw new Error(
        `OpenAPI 3.0 'type' must be a single string; got ${JSON.stringify(ctx.schema)}. ` +
          `For nullability, add 'nullable: true' instead of 'type: ["X","null"]'.`,
      );
    }
    // The shape check above is not enough on its own. A string still has
    // to name a type OAS 3.0 has, and the two ways it can fail differ:
    // an unknown name (`Boolean`) compiles to a validator nothing
    // satisfies, while `null` is a real 2020-12 name that 3.0 does not
    // have, so it compiles to a *working* validator enforcing the wrong
    // contract. The second is the quieter bug, and gets its own hint.
    if (!(OAS30_TYPE_NAMES as readonly string[]).includes(ctx.schema)) {
      const hint =
        ctx.schema === "null"
          ? ` OpenAPI 3.0 has no 'null' type; use 'nullable: true' alongside the value's own type.`
          : suggestTypeName(ctx.schema, OAS30_TYPE_NAMES);
      throw new Error(
        `OpenAPI 3.0 'type' has unknown type name ${JSON.stringify(ctx.schema)}; ` +
          `expected one of ${OAS30_TYPE_NAMES.map((t) => JSON.stringify(t)).join(", ")}.${hint}`,
      );
    }
    const declared = ctx.schema;
    const nullable = ctx.parentSchema.nullable === true;
    const types = nullable ? [declared, "null"] : [declared];

    const condition = buildTypeMismatchCondition(ctx.data, types);
    ctx.gen.if(condition, () => {
      const expectedLit = JSON.stringify(types);
      const actualExpr = `${NAMES.DEPS}.typeOf(${ctx.data})`;
      ctx.emitError(
        "leaf",
        ctx.leafErrorExpr(
          quoteString("type"),
          `"must be " + ${JSON.stringify(nullable ? `${declared} or null` : declared)}`,
          `{ expected: ${expectedLit}, actual: ${actualExpr} }`,
        ),
      );
    });
  },
};

/**
 * The `nullable` keyword is a metadata flag that the OAS 3.0 `type`
 * keyword consults on its sibling lookup. This entry exists so the
 * dispatcher doesn't flag it as an unknown keyword; it emits no
 * validation code.
 *
 * @public
 */
export const oas30NullableKeyword: KeywordDefinition = {
  keyword: "nullable",
  vocabulary: OAS30_VOCAB,
  annotation: true,
  compile(): void {
    // intentionally empty: consumed by oas30TypeKeyword
  },
};

/**
 * OAS 3.0's `maximum`. Looks at the sibling `exclusiveMaximum`
 * boolean to decide whether the check is `<=` (default) or `<`
 * (exclusive).
 *
 * @public
 */
export const oas30MaximumKeyword: KeywordDefinition = {
  keyword: "maximum",
  vocabulary: OAS30_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const limit = numberLiteral(ctx.schema, "maximum");
    const exclusive = ctx.parentSchema.exclusiveMaximum === true;
    const op = exclusive ? ">=" : ">";
    const exclusiveLit = exclusive ? "true" : "false";
    ctx.gen.if(
      `typeof ${ctx.data} === "number" && Number.isFinite(${ctx.data}) && ${ctx.data} ${op} ${limit}`,
      () => {
        ctx.emitError(
          "leaf",
          ctx.leafErrorExpr(
            quoteString("maximum"),
            `\`must be ${exclusive ? "<" : "<="} ${limit}\``,
            `{ maximum: ${limit}, exclusive: ${exclusiveLit}, actual: ${ctx.data} }`,
          ),
        );
      },
    );
  },
};

/**
 * OAS 3.0's `minimum`. Looks at the sibling `exclusiveMinimum`
 * boolean to decide whether the check is `>=` (default) or `>`.
 *
 * @public
 */
export const oas30MinimumKeyword: KeywordDefinition = {
  keyword: "minimum",
  vocabulary: OAS30_VOCAB,
  compile(ctx: KeywordCompileContext): void {
    const limit = numberLiteral(ctx.schema, "minimum");
    const exclusive = ctx.parentSchema.exclusiveMinimum === true;
    const op = exclusive ? "<=" : "<";
    const exclusiveLit = exclusive ? "true" : "false";
    ctx.gen.if(
      `typeof ${ctx.data} === "number" && Number.isFinite(${ctx.data}) && ${ctx.data} ${op} ${limit}`,
      () => {
        ctx.emitError(
          "leaf",
          ctx.leafErrorExpr(
            quoteString("minimum"),
            `\`must be ${exclusive ? ">" : ">="} ${limit}\``,
            `{ minimum: ${limit}, exclusive: ${exclusiveLit}, actual: ${ctx.data} }`,
          ),
        );
      },
    );
  },
};

/**
 * OAS 3.0's `exclusiveMaximum` is a metadata boolean consumed by
 * {@link oas30MaximumKeyword}. No validation code on its own.
 *
 * @public
 */
export const oas30ExclusiveMaximumKeyword: KeywordDefinition = {
  keyword: "exclusiveMaximum",
  vocabulary: OAS30_VOCAB,
  annotation: true,
  compile(): void {
    // intentionally empty
  },
};

/**
 * OAS 3.0's `exclusiveMinimum` is a metadata boolean consumed by
 * {@link oas30MinimumKeyword}.
 *
 * @public
 */
export const oas30ExclusiveMinimumKeyword: KeywordDefinition = {
  keyword: "exclusiveMinimum",
  vocabulary: OAS30_VOCAB,
  annotation: true,
  compile(): void {
    // intentionally empty
  },
};

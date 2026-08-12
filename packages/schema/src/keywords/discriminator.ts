import { quoteString } from "../codegen/index.js";
import { computeDiscriminatorRoutes } from "./discriminator-routes.js";
import type { KeywordCompileContext, KeywordDefinition } from "./types.js";
import { APPLICATOR_VOCAB } from "./vocabulary-uris.js";

/**
 * The OpenAPI `discriminator` object, active in all three dialects. When
 * present alongside `oneOf` (or `anyOf`), the validator reads the named
 * property, routes on it (via `mapping`, or via the implicit name each
 * branch `$ref`'s last segment supplies), and validates the data against
 * ONLY the selected branch, producing a single-branch failure tree
 * rather than N branches.
 *
 * @remarks
 * When `discriminator` is present the normal `oneOf` / `anyOf` pathway
 * is suppressed via the `implements` field.
 *
 * @public
 */
export const discriminatorKeyword: KeywordDefinition = {
  keyword: "discriminator",
  vocabulary: APPLICATOR_VOCAB,
  applicator: true,
  implements: ["oneOf", "anyOf"],
  compile(ctx: KeywordCompileContext): void {
    const disc = ctx.schema as { propertyName: string; mapping?: Record<string, string> };
    const propertyName = disc.propertyName;
    const branches = ctx.parentSchema.oneOf ?? ctx.parentSchema.anyOf;
    if (!branches) return;

    const { routes, usable } = computeDiscriminatorRoutes(disc, branches);
    if (!usable) {
      // Nothing to route with, or a routing table only partly usable.
      // Hand `oneOf` / `anyOf` back and let the composition decide.
      //
      // OpenAPI treats `discriminator` as an aid to branch selection and
      // error quality; the composition beside it is what says whether an
      // instance is valid. Rejecting every payload because the aid could
      // not be interpreted is the one outcome the spec does not sanction,
      // and it is what happened to any spec whose branches arrived
      // without `$ref`s: pre-bundled documents keep mapping values
      // naming files the bundle absorbed (#561). The dead mapping is
      // reported by `silent-rewrite/discriminator-unroutable` so the
      // author still learns their routing table is not being used.
      ctx.declineImplements();
      return;
    }

    const discFns: Array<{ value: string; fn: string }> = [];
    for (const [value, index] of routes) {
      const branch = branches[index];
      if (branch === undefined) continue;
      const fn = ctx.compileSubschema(branch);
      discFns.push({ value, fn });
    }

    const propLit = quoteString(propertyName);
    ctx.gen.if(
      `typeof ${ctx.data} === "object" && ${ctx.data} !== null && !Array.isArray(${ctx.data})`,
      (g) => {
        const discVal = g.scope.name("disc");
        g.const(discVal, `${ctx.data}[${propLit}]`);
        g.if(
          `typeof ${discVal} !== "string"`,
          () => {
            if (ctx.predicate) {
              g.line("return false;");
              return;
            }
            ctx.emitError(
              "leaf",
              ctx.leafErrorExpr(
                quoteString("discriminator"),
                quoteString(`discriminator property "${propertyName}" must be a string`),
                `{ propertyName: ${propLit} }`,
                [propLit],
              ),
            );
          },
          (gi) => {
            if (ctx.predicate) {
              // Predicate mode switch: each case calls its branch and
              // propagates a false return; default returns false.
              gi.line(`switch (${discVal}) {`);
              for (const { value, fn } of discFns) {
                gi.line(
                  `      case ${quoteString(value)}: if (!${fn}(${ctx.data})) return false; break;`,
                );
              }
              gi.line(`      default: return false;`);
              gi.line(`    }`);
              return;
            }
            // Discriminator routes to ONE branch. If it returns an error,
            // that's already a counted leaf from the sub-validator; lift
            // it (don't re-count). If the discriminator value matches no
            // branch, THAT error is a fresh leaf; gate it.
            const switchLines = discFns
              .map(
                ({ value, fn }) =>
                  `      case ${quoteString(value)}: { const e = ${fn}(${ctx.data}, ${ctx.path}); if (e !== null) ${ctx.errorStatement("lift", "e")} break; }`,
              )
              .join("\n");
            gi.line(`switch (${discVal}) {`);
            gi.line(switchLines);
            gi.line(`      default: {`);
            gi.line(
              ctx.errorStatement(
                "leaf",
                ctx.leafErrorExpr(
                  quoteString("discriminator"),
                  `"discriminator value does not match any branch"`,
                  `{ propertyName: ${propLit}, value: ${discVal} }`,
                  [propLit],
                ),
              ),
            );
            gi.line(`      }`);
            gi.line(`    }`);
          },
        );
      },
    );
  },
};

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `@oaverify/core/schema` is consumable on its own: a caller naming
 * what `compileSchema` accepts, or what an error leaf looks like,
 * should not have to import from a second subpath to do it.
 *
 * The enforced rule is the one a regex can decide: a core type is
 * re-exported when any module reachable from the entry by
 * `export ... from` imports it. Deciding instead whether the type
 * reaches an exported signature would need type analysis, and the
 * coarser rule errs toward the consumer being able to name it.
 *
 * This reads source rather than asserting type identity because the
 * failure to catch is a core type arriving in a keyword or the
 * compiler and nobody remembering this entry. A hand-written list of
 * identity assertions only catches removals, and is itself the list
 * that goes stale.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const CORE = "@oaverify/internal-core";
const REEXPORT = /export\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+"(\.[^"]+)"/g;

/** Named bindings in one `{ ... }` clause, paired with type-only-ness. */
function bindings(clause: string, typeOnlyClause: boolean): Array<{ name: string; type: boolean }> {
  return clause
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => ({
      name: (part.replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? "").trim(),
      type: typeOnlyClause || part.startsWith("type "),
    }))
    .filter((binding) => binding.name.length > 0);
}

function read(module: string): string {
  return readFileSync(join(SRC, module), "utf8");
}

/** Type-only names a module imports from the bare `internal-core` specifier. */
function coreTypeImports(source: string): string[] {
  const pattern = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+"${CORE}"`, "g");
  return [...source.matchAll(pattern)].flatMap((match) =>
    bindings(match[2] ?? "", match[1] !== undefined)
      .filter((binding) => binding.type)
      .map((binding) => binding.name),
  );
}

/** Every module reachable from the entry by `export ... from`. */
function publishedModules(): string[] {
  const seen = new Set<string>();
  const queue = ["index.ts"];
  for (let module = queue.pop(); module !== undefined; module = queue.pop()) {
    if (seen.has(module)) continue;
    seen.add(module);
    const dir = dirname(module);
    for (const match of read(module).matchAll(REEXPORT)) {
      queue.push(join(dir, (match[1] ?? "").replace(/\.js$/, ".ts")));
    }
  }
  return [...seen];
}

describe("@oaverify/core/schema entry", () => {
  it("re-exports every core type its published modules import", () => {
    const pattern = new RegExp(`export\\s+type\\s+\\{([^}]*)\\}\\s+from\\s+"${CORE}"`, "g");
    const declared = new Set(
      [...read("index.ts").matchAll(pattern)].flatMap((match) =>
        bindings(match[1] ?? "", true).map((binding) => binding.name),
      ),
    );

    const needed = new Set(publishedModules().flatMap((module) => coreTypeImports(read(module))));

    expect([...needed].sort().filter((name) => !declared.has(name))).toEqual([]);
  });

  it("walks past the barrels rather than stopping at the entry", () => {
    // A closure that collapsed to `index.ts` alone would make the
    // assertion above vacuous, since the entry imports no core types
    // other than the ones it re-exports.
    expect(publishedModules()).toContain(join("compiler", "compiler.ts"));
  });
});

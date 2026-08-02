import { describe, expect, it } from "vitest";
import { refablePositionsFor, type OpenAPIVersion } from "@oaverify/internal-core";
import oas30 from "../src/vendor/oas-3.0.json" with { type: "json" };
import oas31 from "../src/vendor/oas-3.1.json" with { type: "json" };
import oas32 from "../src/vendor/oas-3.2.json" with { type: "json" };

/**
 * Pins `core`'s ref-position table to the meta-schemas OpenAPI
 * publishes.
 *
 * The table is hand-written so it stays readable where the resolver
 * uses it; this test is what stops it drifting from the specification.
 * It lives here rather than in `core` because the dependency graph runs
 * `metaschema -> core`, and a test importing the vendored documents
 * into `core` would reverse it.
 *
 * A version bump that moves a Reference Object fails here, naming the
 * position that moved.
 */

/** Meta-schema definition name -> the `RefNodeKind` it corresponds to. */
const KIND_OF: Record<string, string> = {
  components: "components",
  operation: "operation",
  "path-item": "pathItem",
  response: "response",
  responses: "responses",
  encoding: "encoding",
  content: "content",
  "media-type": "mediaType",
  parameter: "parameter",
  header: "header",
  Components: "components",
  Operation: "operation",
  PathItem: "pathItem",
  Response: "response",
  Responses: "responses",
  Encoding: "encoding",
  MediaType: "mediaType",
  Parameter: "parameter",
  Header: "header",
};

/**
 * Two meta-schema definitions are mixins rather than objects in their
 * own right: they are `allOf`-composed into several object types, so a
 * position found under them belongs to each host. `examples` carries
 * the `examples` map into Media Type, Parameter and Header; 3.2's
 * `parameters` carries the parameter array into Path Item and
 * Operation.
 */
const MIXIN_HOSTS: Record<string, { hosts: string[]; key?: string }> = {
  examples: { hosts: ["mediaType", "parameter", "header"] },
  ExampleXORExamples: { hosts: ["mediaType", "parameter", "header"] },
  // 3.2's `parameters` definition *is* the array, so the key it sits at
  // is not visible from inside it the way `examples` is.
  parameters: { hosts: ["pathItem", "operation"], key: "parameters" },
};

/**
 * The key a position sits at, read off the meta-schema path between the
 * owning definition and the `$ref`. `properties/X/...` is key `X`;
 * `patternProperties/...`, `additionalProperties` and `items` directly
 * under a definition mean "any key", which the table spells `*`.
 */
function keyFromPath(segments: string[]): string | undefined {
  const i = segments.indexOf("properties");
  if (i !== -1 && segments[i + 1] !== undefined) return segments[i + 1];
  if (segments.some((s) => s === "patternProperties" || s === "additionalProperties")) return "*";
  if (segments[0] === "items" || segments[0] === "additionalProperties") return "*";
  return undefined;
}

/** Walk a JSON value, yielding [path, value] for every node. */
function* nodes(value: unknown, path: string[] = []): Generator<[string[], unknown]> {
  yield [path, value];
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    yield* nodes(v, [...path, k]);
  }
}

/**
 * Derive `"<kind>/<key>"` for every position the document types as
 * admitting a Reference Object.
 *
 * 3.1 and 3.2 name those positions directly (`$ref` to an
 * `X-or-reference` definition). 3.0 predates that convention and spells
 * the same thing as `oneOf: [Reference, X]`, so the two shapes are
 * recognised separately.
 */
function derive(doc: unknown, defsKey: "$defs" | "definitions"): Set<string> {
  const out = new Set<string>();
  const defs = (doc as Record<string, Record<string, unknown>>)[defsKey] ?? {};

  for (const [defName, def] of Object.entries(defs)) {
    for (const [path, node] of nodes(def)) {
      let isRefable = false;

      if (path[path.length - 1] === "$ref" && typeof node === "string") {
        isRefable = node.endsWith("-or-reference");
      } else if (Array.isArray(node) && path[path.length - 1] === "oneOf") {
        isRefable = node.some(
          (b) =>
            typeof b === "object" &&
            b !== null &&
            (b as Record<string, unknown>)["$ref"] === `#/${defsKey}/Reference`,
        );
      }
      if (!isRefable) continue;

      // Trim the trailing `$ref` / `oneOf` segment; the key sits above.
      const within = path.slice(0, -1);
      const mixin = MIXIN_HOSTS[defName];
      const key = mixin?.key ?? keyFromPath(within);
      if (key === undefined) continue;

      for (const kind of mixin?.hosts ?? [KIND_OF[defName]].filter(Boolean)) {
        out.add(`${kind}/${key}`);
      }
    }
  }
  return out;
}

const CASES: { version: OpenAPIVersion; doc: unknown; defsKey: "$defs" | "definitions" }[] = [
  { version: "3.0", doc: oas30, defsKey: "definitions" },
  { version: "3.1", doc: oas31, defsKey: "$defs" },
  { version: "3.2", doc: oas32, defsKey: "$defs" },
];

/**
 * Positions whose value is a Schema Object.
 *
 * 3.0 spells these `oneOf: [Schema, Reference]`, so the derivation sees
 * them as ref-able; 3.1 and 3.2 do not, because JSON Schema handles
 * `$ref` itself. The resolver reaches them through its schema walk
 * rather than the Reference Object branch, which is what lets an
 * external schema keep an address by being hoisted into
 * `components.schemas` instead of inlined. The table records them with
 * `kind: "schema"` and `refable: false` for that reason, so they are
 * excluded here rather than in the table.
 */
const SCHEMA_VALUED = new Set([
  "components/schemas",
  "header/schema",
  "mediaType/schema",
  "parameter/schema",
]);

/**
 * Fold a derived position into the table's spelling. Where the table
 * says "any key of this object" (`responses/*`), the meta-schema names
 * both the pattern and `default` separately; they denote the same
 * position.
 */
function normalize(derived: Set<string>, table: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const position of derived) {
    if (SCHEMA_VALUED.has(position)) continue;
    const kind = position.slice(0, position.indexOf("/"));
    out.add(table.has(`${kind}/*`) ? `${kind}/*` : position);
  }
  return out;
}

describe("core's ref-position table matches the published meta-schemas", () => {
  for (const { version, doc, defsKey } of CASES) {
    it(`${version}: every ref-able position, and no others`, () => {
      const table = refablePositionsFor(version);
      const derived = normalize(derive(doc, defsKey), table);
      // Sanity: the derivation found something, so an empty set can
      // never pass this by matching an empty table.
      expect(derived.size).toBeGreaterThan(10);
      expect([...table].sort()).toEqual([...derived].sort());
    });
  }

  it("3.2 types a Media Type as ref-able where 3.1 does not", () => {
    expect(refablePositionsFor("3.2")).toContain("content/*");
    expect(refablePositionsFor("3.1")).not.toContain("content/*");
  });
});

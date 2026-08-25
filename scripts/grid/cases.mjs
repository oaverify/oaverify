/**
 * The parameter grid: every (location, style, explode, schema) declaration
 * crossed with every wire input plausible for that location.
 *
 * ## The grid is deliberately not curated
 *
 * Many cells here are nonsense. `style: deepObject` on a `type: string`
 * parameter is not a thing a spec author writes, and `?p=0x1A` against
 * `type: boolean` is not a request anyone means to send. They stay in.
 *
 * R3 compares two revisions on identical inputs, so a case earns its place
 * by being a *probe*, not by being sensible: whatever the validator does
 * with a nonsense cell, it should keep doing until someone changes it on
 * purpose. Filtering the grid down to combinations that "make sense" would
 * mean encoding one reading of the OpenAPI serialization rules into the
 * thing meant to detect changes in that reading, which is how #742 got
 * three review passes deep. The generator holds no opinion.
 *
 * That also means no expected values live here. The grid produces inputs;
 * the dump records what happened; the diff compares two dumps. There is no
 * oracle at this layer and this file does not pretend to be one.
 *
 * ## Coverage, and what is missing
 *
 * Declared: 2 OpenAPI versions x 4 locations x their legal styles *plus
 * leaving `style` unset* x `explode` unset/false/true x the version's
 * schema shapes, against the wire inputs plausible for each location.
 * `gridSize()` is the count; README.md quotes it and this comment does
 * not, because a number in two places drifts in one of them.
 *
 * `style` and `explode` are each generated unset as well as declared,
 * because that is a different code path rather than a missing row: the
 * library resolves the default before it deserializes anything, and a
 * generated corpus reaches for the declared form by habit. It is also
 * what real documents do. Counting `detection/real-world/specs` (301
 * published documents, 56,555 parameters), 92% declare no `style` and
 * 94% no `explode`, and before #766 this grid declared both on every
 * single case: the majority path had never run here.
 *
 * The same count is why 3.0 is generated: 87% of those documents are 3.0.
 * 3.0 has no type unions and spells nullability with `nullable`, so the
 * schema set forks per version rather than being shared.
 *
 * Not covered yet, each a known gap rather than an oversight: OpenAPI 3.2,
 * request bodies, response validation, `content`-typed parameters, and
 * `allowReserved`.
 */

/**
 * The OpenAPI versions generated. 87% of the real-world corpus is 3.0.
 *
 * What actually differs is the compiler, not the deserializer: 3.0 compiles
 * under `oas30Dialect`, which is a different `type` keyword plus `nullable`
 * and boolean `exclusive*`. Parameter deserialization has one
 * version-dependent branch, `refSuppressesSiblings`, and it only fires for a
 * `$ref`'d parameter schema, which this grid does not generate. So the 3.0
 * half earns its place through the schema table below or not at all.
 */
export const OAS_VERSIONS = ["3.1.1", "3.0.3"];

/** The parameter name every declaration uses. */
const NAME = "p";

/**
 * Schema shapes. The nullable pairs appear in both member orders on
 * purpose: `["array","null"]` and `["null","array"]` are the same schema,
 * and #742 was them behaving differently. `strInt` is the two-readable-member
 * case that #752 tracks, where member order decides and deliberately so.
 */
const SCHEMAS_31 = [
  ["str", { type: "string" }],
  ["int", { type: "integer" }],
  ["num", { type: "number" }],
  ["bool", { type: "boolean" }],
  ["strNull", { type: ["string", "null"] }],
  ["nullStr", { type: ["null", "string"] }],
  ["intNull", { type: ["integer", "null"] }],
  ["nullInt", { type: ["null", "integer"] }],
  ["arrStr", { type: "array", items: { type: "string" } }],
  ["arrInt", { type: "array", items: { type: "integer" } }],
  ["arrNull", { type: ["array", "null"], items: { type: "string" } }],
  ["nullArr", { type: ["null", "array"], items: { type: "string" } }],
  ["objAN", { type: "object", properties: { a: { type: "string" }, n: { type: "integer" } } }],
  ["objNull", { type: ["object", "null"], properties: { n: { type: "integer" } } }],
  ["strInt", { type: ["string", "integer"] }],
  ["intStr", { type: ["integer", "string"] }],
  ["exclMax", { type: "integer", exclusiveMaximum: 10 }],
  ["untyped", {}],
];

/**
 * The 3.0 set. Not a subset and not a translation.
 *
 * 3.0 spells nullability as `nullable: true` beside one `type`, which is a
 * flag rather than a member of a union, so it has no order to vary: `strNull`
 * and `nullStr` collapse to a single cell. The null-first ids `nullStr`,
 * `nullInt` and `nullArr` are therefore the ones absent here, not `strNull`.
 *
 * `strInt` and `intStr` are absent by choice rather than necessity. 3.0 has
 * `anyOf`, so a two-readable-member parameter can be written; it is left out
 * because spelling it by hand would test our reading of a translation nobody
 * writes, and #752 is a 3.1 question.
 *
 * Ids that mean the same thing keep the same name across the two tables so a
 * reader can line the versions up. `exclMax` is the one id whose *spelling*
 * differs on purpose: it is the version-appropriate way to say the same
 * thing, and it is what stops the 3.0 half agreeing with the 3.1 half on
 * every single case.
 */
const SCHEMAS_30 = [
  ["str", { type: "string" }],
  ["int", { type: "integer" }],
  ["num", { type: "number" }],
  ["bool", { type: "boolean" }],
  ["strNull", { type: "string", nullable: true }],
  ["intNull", { type: "integer", nullable: true }],
  ["arrStr", { type: "array", items: { type: "string" } }],
  ["arrInt", { type: "array", items: { type: "integer" } }],
  ["arrNull", { type: "array", items: { type: "string" }, nullable: true }],
  ["objAN", { type: "object", properties: { a: { type: "string" }, n: { type: "integer" } } }],
  ["objNull", { type: "object", properties: { n: { type: "integer" } }, nullable: true }],
  // The 3.0 spelling of the 3.1 `exclMax` above. Both mean "below 10".
  ["exclMax", { type: "integer", maximum: 10, exclusiveMaximum: true }],
  // The 3.1 spelling, in a 3.0 document, where it is currently ignored: a
  // numeric `exclusiveMaximum` is not a 3.0 keyword. Recorded so that
  // starting to honour it, or starting to reject it, is visible here.
  ["exclMaxNumeric", { type: "integer", exclusiveMaximum: 10 }],
  ["untyped", {}],
];

/** The schema table for a generated document's declared version. */
function schemasFor(oas) {
  return oas.startsWith("3.0") ? SCHEMAS_30 : SCHEMAS_31;
}

/** The styles OpenAPI defines for each location. */
const STYLES = {
  query: ["form", "spaceDelimited", "pipeDelimited", "deepObject"],
  path: ["simple", "label", "matrix"],
  header: ["simple"],
  cookie: ["form"],
};

/**
 * Query wire inputs. The lexeme set leads with the ones #736 and #751
 * decided: `Number()` reads `""`, `"  7  "` and `"0x1A"` as numbers and
 * none of them is a decimal number a client plausibly meant.
 */
const QUERY_WIRE = [
  ["absent", {}],
  ["empty", { [NAME]: "" }],
  ["int", { [NAME]: "7" }],
  ["hex", { [NAME]: "0x1A" }],
  ["padded", { [NAME]: "  7  " }],
  ["exp", { [NAME]: "1e3" }],
  // Exactly the bound the `exclMax` schemas name, so the exclusive/inclusive
  // distinction is exercised rather than only "far over it".
  ["bound", { [NAME]: "10" }],
  ["plus", { [NAME]: "+5" }],
  ["leadingZeros", { [NAME]: "007" }],
  ["infinity", { [NAME]: "Infinity" }],
  ["true", { [NAME]: "true" }],
  ["word", { [NAME]: "abc" }],
  ["csv", { [NAME]: "a,b,c" }],
  ["csvInts", { [NAME]: "1,2,3" }],
  ["ssv", { [NAME]: "a b c" }],
  ["psv", { [NAME]: "a|b|c" }],
  ["repeated", { [NAME]: ["a", "b"] }],
  ["repeatedInts", { [NAME]: ["1", "2"] }],
  ["bracketed", { [`${NAME}[]`]: ["a", "b"] }],
  ["deep", { [`${NAME}[a]`]: "x", [`${NAME}[n]`]: "7" }],
  ["deepHex", { [`${NAME}[n]`]: "0x1A" }],
  ["deepEmpty", { [`${NAME}[n]`]: "" }],
  ["deepPadded", { [`${NAME}[n]`]: "  7  " }],
  ["deepExp", { [`${NAME}[n]`]: "1e3" }],
  ["topLevelProps", { a: "x", n: "7" }],
  ["topLevelPropsHex", { a: "x", n: "0x1A" }],
  // Property names the object declarations actually declare, in a single
  // token. `deep` and `topLevelProps` above spell the same pair, and both
  // reach an object through the assemblers in param-assembly.ts, which
  // have coerced by the property schema since #707. Nothing spelled the
  // declared names in one token, so the branch that reads an object out
  // of one was never asked to coerce anything and #824 sat under a green
  // differential: every object shape used keys the schema does not
  // declare, where there is no type to read and a string is the right
  // answer.
  ["propsCsv", { [NAME]: "a,x,n,7" }],
  ["propsCsvHex", { [NAME]: "a,x,n,0x1A" }],
  ["propsExploded", { [NAME]: "a=x,n=7" }],
];

/** Path wire inputs, substituted into the `/t/{p}` template. */
const PATH_WIRE = [
  ["int", "7"],
  ["hex", "0x1A"],
  ["exp", "1e3"],
  ["word", "abc"],
  ["csv", "a,b,c"],
  ["label", ".a.b"],
  ["matrix", ";p=a"],
  ["matrixCsv", ";p=a,b"],
  ["matrixExploded", ";p=1;p=2"],
  // Groups naming a parameter other than this one. The grid shipped
  // without these and missed #758 as a result: `stripStyle` drops any
  // `;<name>=` prefix without checking the name, so `;q=1` supplied `p`'s
  // value, while the explode-array branch does check. Probing only the
  // matching name could not see a rule applied in one branch and not its
  // sibling.
  ["matrixWrongName", ";q=1"],
  ["matrixMixedNames", ";q=1;p=2"],
  ["matrixNoMatch", ";q=1;r=2"],
  ["encodedComma", "a%2Cb"],
  // The declared property names, in each framing an object takes here.
  // See the query table for what their absence hid.
  ["propsCsv", "a,x,n,7"],
  ["propsExploded", "a=x,n=7"],
  ["propsLabel", ".a,x,n,7"],
  ["propsMatrix", ";p=a,x,n,7"],
];

/** Header and cookie wire inputs. */
const SCALAR_WIRE = [
  ["absent", undefined],
  ["int", "7"],
  ["hex", "0x1A"],
  ["csv", "a,b,c"],
  ["word", "abc"],
  ["propsCsv", "a,x,n,7"],
  ["propsExploded", "a=x,n=7"],
];

/**
 * One OpenAPI document per (location, style, explode, schema). Grouping
 * this way is what keeps the run cheap: a validator is built once per
 * declaration and then driven with every wire input for its location.
 */
export function* declarations() {
  for (const oas of OAS_VERSIONS) {
    for (const [location, styles] of Object.entries(STYLES)) {
      // `undefined` is the unset cell, and it is not the same as writing
      // the default out: the library has to resolve a default before it
      // can deserialize, and that resolution is the branch 92% of real
      // parameters take. Declaring `style: form` and omitting `style`
      // therefore stay separate cells even where they should agree.
      for (const style of [undefined, ...styles]) {
        for (const explode of [undefined, false, true]) {
          for (const [schemaId, schema] of schemasFor(oas)) {
            const template = location === "path" ? `/t/{${NAME}}` : "/t";
            const parameter = {
              name: NAME,
              in: location,
              // OpenAPI requires path parameters to be required; anywhere
              // else `false` keeps the absent-input cells meaningful.
              required: location === "path",
              schema,
            };
            if (style !== undefined) parameter.style = style;
            if (explode !== undefined) parameter.explode = explode;
            yield {
              id:
                `${oas}|${location}|style=${style ?? "unset"}` +
                `|explode=${explode ?? "unset"}|${schemaId}`,
              location,
              doc: {
                openapi: oas,
                info: { title: "grid", version: "1" },
                paths: {
                  [template]: {
                    get: { parameters: [parameter], responses: { 200: { description: "ok" } } },
                  },
                },
              },
            };
          }
        }
      }
    }
  }
  yield* pairDeclarations();
}

/**
 * Two-parameter documents, where one parameter's wire shape could claim
 * the other's input.
 *
 * Everything above declares exactly one parameter, which made the grid
 * structurally unable to see this class however many cases it ran (#765):
 * `matrix` and `label` assign by position, and whether the name label is
 * honoured is a separate question a single declaration never asks.
 *
 * Each entry names its own probes rather than reusing the location tables,
 * because the interesting inputs here are relational: a segment swapped
 * against its neighbour, one key that both declarations can read. The
 * no-opinion rule holds exactly as above. These record what happens; none
 * of them asserts what should. `form-object-scalar` in particular is
 * live today, with one query key reaching two declared parameters, and
 * the grid deliberately takes no view on whether that is correct.
 */
const PAIRS = [
  {
    id: "matrix-matrix",
    template: "/t/{p}/{q}",
    // Both segments carry matrix framing, so the name label is the only
    // thing that can tell them apart.
    params: (schema) => [
      { name: "p", in: "path", required: true, style: "matrix", explode: false, schema },
      { name: "q", in: "path", required: true, style: "matrix", explode: false, schema },
    ],
    probes: [
      ["ordered", "/t/;p=1/;q=2"],
      ["swapped", "/t/;q=1/;p=2"],
      ["bothNameP", "/t/;p=1/;p=2"],
      ["unframed", "/t/1/2"],
      ["firstUnframed", "/t/1/;q=2"],
    ],
  },
  {
    id: "simple-matrix",
    template: "/t/{p}/{q}",
    // `p` declares no framing, so a `;q=` prefix in its segment is a
    // token it has no rule for.
    params: (schema) => [
      { name: "p", in: "path", required: true, style: "simple", explode: false, schema },
      { name: "q", in: "path", required: true, style: "matrix", explode: false, schema },
    ],
    probes: [
      ["ordered", "/t/1/;q=2"],
      ["matrixIntoSimple", "/t/;q=1/;q=2"],
      ["matrixNamingP", "/t/;p=1/;q=2"],
      ["unframed", "/t/1/2"],
    ],
  },
  {
    id: "form-object-scalar",
    template: "/t",
    // An exploded form object spreads its properties as top-level query
    // keys, and one of those property names is also a declared parameter.
    params: (schema) => [
      {
        name: "p",
        in: "query",
        style: "form",
        explode: true,
        schema: { type: "object", properties: { a: { type: "string" }, q: schema } },
      },
      { name: "q", in: "query", style: "form", explode: false, schema },
    ],
    probes: [
      ["contested", { a: "x", q: "1" }],
      ["onlyContested", { q: "1" }],
      ["onlyOther", { a: "x" }],
      ["absent", {}],
    ],
  },
  {
    id: "deepObject-prefix",
    template: "/t",
    // A scalar whose declared name is the bracketed key deepObject reads.
    params: (schema) => [
      {
        name: "p",
        in: "query",
        style: "deepObject",
        explode: true,
        schema: { type: "object", properties: { a: schema } },
      },
      { name: "p[a]", in: "query", style: "form", explode: false, schema },
    ],
    probes: [
      ["contested", { "p[a]": "1" }],
      ["contestedPlusPlain", { "p[a]": "1", p: "2" }],
      ["absent", {}],
    ],
  },
];

/** The schemas each pair is generated against. */
const PAIR_SCHEMAS = [
  ["str", { type: "string" }],
  ["int", { type: "integer" }],
  ["untyped", {}],
];

/** One document per (version, pair, schema), carrying its own probes. */
function* pairDeclarations() {
  for (const oas of OAS_VERSIONS) {
    for (const pair of PAIRS) {
      for (const [schemaId, schema] of PAIR_SCHEMAS) {
        yield {
          id: `${oas}|pair=${pair.id}|${schemaId}`,
          location: "pair",
          requests: pair.probes.map(([wireId, wire]) => ({
            wireId,
            request:
              typeof wire === "string"
                ? { method: "GET", path: wire }
                : { method: "GET", path: "/t", query: wire },
          })),
          doc: {
            openapi: oas,
            info: { title: "grid", version: "1" },
            paths: {
              [pair.template]: {
                get: {
                  parameters: pair.params(schema),
                  responses: { 200: { description: "ok" } },
                },
              },
            },
          },
        };
      }
    }
  }
}

/** The wire inputs to drive a declaration in `location` with. */
export function* requests(location) {
  if (location === "query") {
    for (const [wireId, query] of QUERY_WIRE) {
      yield { wireId, request: { method: "GET", path: "/t", query } };
    }
    return;
  }
  if (location === "path") {
    for (const [wireId, segment] of PATH_WIRE) {
      yield { wireId, request: { method: "GET", path: `/t/${segment}` } };
    }
    return;
  }
  if (location !== "header" && location !== "cookie") {
    // Every caller reaches this through `requestsFor`, which only asks for a
    // location a declaration actually carries. Falling through to the scalar
    // table for anything else would hand a `pair` declaration seven cookie
    // probes and look like it worked.
    throw new Error(`requests: no wire table for location "${location}"`);
  }
  for (const [wireId, value] of SCALAR_WIRE) {
    const request = { method: "GET", path: "/t" };
    if (value !== undefined) {
      if (location === "header") request.headers = { [NAME]: value };
      else request.cookies = { [NAME]: value };
    }
    yield { wireId, request };
  }
  // Header names match case-insensitively (#575, where the lookup had
  // drifted into three strategies). Probe the spelling the wire actually
  // carries as often as not.
  if (location === "header") {
    yield {
      wireId: "uppercased",
      request: { method: "GET", path: "/t", headers: { [NAME.toUpperCase()]: "7" } },
    };
  }
}

/**
 * The probes for one declaration. Most take their location's table; the
 * two-parameter documents carry their own, because the inputs that matter
 * there are relational rather than per-location.
 */
export function requestsFor(decl) {
  const probes = decl.requests ?? [...requests(decl.location)];
  if (probes.length === 0) {
    // A declaration with no probes contributes no cases, which reads as a
    // clean run rather than as a mistake.
    throw new Error(`requestsFor: declaration "${decl.id}" has no probes`);
  }
  return probes;
}

/** Total case count, for the dump's metadata. */
export function gridSize() {
  let n = 0;
  for (const decl of declarations()) n += requestsFor(decl).length;
  return n;
}

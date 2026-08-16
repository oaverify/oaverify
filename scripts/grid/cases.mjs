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
 * Declared: 4 locations x their legal styles x explode x 17 schema shapes,
 * against 18 query / 9 path / 5 header / 5 cookie wire inputs.
 *
 * Not covered yet, each a known gap rather than an oversight:
 * OpenAPI 3.0 and 3.2 (3.1 only, because 3.0 spells nullability with
 * `nullable` and the schema set would have to fork per version), request
 * bodies, response validation, `content`-typed parameters, and
 * `allowReserved`.
 */

/** The OpenAPI version every generated document declares. */
export const OAS_VERSION = "3.1.1";

/** The parameter name every declaration uses. */
const NAME = "p";

/**
 * Schema shapes. The nullable pairs appear in both member orders on
 * purpose: `["array","null"]` and `["null","array"]` are the same schema,
 * and #742 was them behaving differently. `strInt` is the two-readable-member
 * case that #752 tracks, where member order decides and deliberately so.
 */
const SCHEMAS = [
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
  ["untyped", {}],
];

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
  for (const [location, styles] of Object.entries(STYLES)) {
    for (const style of styles) {
      for (const explode of [false, true]) {
        for (const [schemaId, schema] of SCHEMAS) {
          const template = location === "path" ? `/t/{${NAME}}` : "/t";
          const parameter = {
            name: NAME,
            in: location,
            style,
            explode,
            // OpenAPI requires path parameters to be required; anywhere
            // else `false` keeps the absent-input cells meaningful.
            required: location === "path",
            schema,
          };
          yield {
            id: `${location}|${style}|explode=${explode}|${schemaId}`,
            location,
            doc: {
              openapi: OAS_VERSION,
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

/** Total case count, for the dump's metadata. */
export function gridSize() {
  let n = 0;
  for (const decl of declarations()) {
    for (const _ of requests(decl.location)) n += 1;
  }
  return n;
}

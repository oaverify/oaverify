/**
 * The cross-shape relation's case generator.
 *
 * ## The relation
 *
 * For one declared parameter schema and one logical value, every legal
 * (location, style, explode) serialization of that value must produce the
 * same verdict and the same deserialized value.
 *
 * OpenAPI gives a parameter many wire spellings. `{ R: 100 }` is
 * `?p=R,100` under query form, `?p[R]=100` under deepObject, `/t/;R=100`
 * under an exploded matrix path parameter, and eight more. They are one
 * declaration and one value, so they are supposed to arrive at the handler
 * as the same JavaScript object. `deserialize.ts` reaches each of them
 * through a different branch, and the branches have drifted apart three
 * times: #788 (a matrix rule taught to one of two code paths), #823 (eight
 * of the thirteen object rows in the Style Examples table read with
 * `form`'s separators), #825 (property values coerced in two shapes of
 * four). Each of those is this relation, failing.
 *
 * ## What this is not
 *
 * It is not the grid. `scripts/grid/` compares one revision to another on
 * identical inputs and holds no opinion about what either produced. This
 * file is an oracle: it compares one shape to another on a single
 * revision, which is the half of #753 the grid cannot do because the grid
 * never compares cell to cell.
 *
 * It is not a round-trip test, and the encoder below is not a serializer.
 * It is the Style Examples table transcribed as data, reachable only from
 * this directory, and it exists to produce inputs rather than to be
 * correct output for a caller.
 *
 * ## What it cannot see
 *
 * Five things, and they are the point of writing them down.
 *
 * 1. A change that breaks every shape identically. All shapes still agree
 *    and this file stays green. It is the failure mode #753 records for
 *    the permute-`type`-members relation, which ran 21,420 cases against a
 *    real regression and found nothing.
 * 2. A reading that is wrong but consistent. This compares shapes to each
 *    other, never to the specification, so if every shape reads "1,2" the
 *    same wrong way it passes. That needs a conformance corpus.
 * 3. A deserializer defect mirrored by the same misunderstanding in
 *    {@link encode}. Transcribing the table from the specification rather
 *    than from `deserialize.ts` narrows this and does not close it.
 * 4. Anything not parameter-shaped: bodies, responses, routing, output
 *    modes, `maxErrors`.
 * 5. Whether `returnValues` changes a verdict. Every validator compared
 *    here has it on, so the option is a constant and this relation says
 *    nothing about the separate invariant that it is verdict-neutral.
 *
 * ## The value domain
 *
 * A shape is only comparable when it is information-preserving, and
 * several are not for values carrying a separator: `form` without
 * `explode` writes an array as "a,b" and gives a string containing a comma
 * no escape, so a fixture using one would make the relation assert a
 * falsehood rather than find a defect. {@link assertInDomain} rejects such
 * a fixture at generation time. The cost is stated rather than hidden:
 * fractional numbers and strings carrying a separator are outside this
 * relation, and a defect that only appears for them is invisible here.
 */

import type { OpenAPIDocument } from "@oaverify/internal-core";

/** The parameter name every declaration uses. */
export const NAME = "p";

/** The path template a path-located declaration uses. */
export const PATH_TEMPLATE = `/t/{${NAME}}`;

/** The path a non-path-located declaration is requested at. */
export const FLAT_PATH = "/t";

export type Location = "query" | "path" | "header" | "cookie";

export type Style =
  | "form"
  | "simple"
  | "label"
  | "matrix"
  | "spaceDelimited"
  | "pipeDelimited"
  | "deepObject";

export type ValueKind = "scalar" | "array" | "object";

/** The style a location resolves to when the declaration leaves it unset. */
const DEFAULT_STYLE: Record<Location, Style> = {
  query: "form",
  path: "simple",
  header: "simple",
  cookie: "form",
};

/**
 * The `explode` a style resolves to when the declaration leaves it unset:
 * `true` for `form`, `false` for everything else.
 */
function defaultExplode(style: Style): boolean {
  return style === "form";
}

/**
 * Characters that frame or separate in at least one style this file
 * generates, plus the space `spaceDelimited` joins on. A string leaf or
 * object key containing one of these has no escape in some shape, so it
 * leaves the domain. The empty string leaves it too: `?p=` is the wire
 * spelling of both an empty value and, in several readings, an absent one.
 */
const SEPARATORS = new Set([",", ".", ";", "=", "&", "|", "[", "]", " "]);

/**
 * Reject a fixture whose value cannot survive every shape. Called from
 * {@link fixtures} so that a future fixture violating the domain fails
 * loudly instead of silently weakening the relation into a tautology.
 */
export function assertInDomain(fixtureId: string, value: unknown): void {
  const checkLeaf = (leaf: unknown, where: string): void => {
    if (typeof leaf !== "string") return;
    if (leaf.length === 0) {
      throw new Error(
        `fixture "${fixtureId}": ${where} is the empty string, which is out of domain`,
      );
    }
    for (const ch of leaf) {
      if (SEPARATORS.has(ch)) {
        throw new Error(
          `fixture "${fixtureId}": ${where} contains the separator "${ch}", which is out of domain`,
        );
      }
    }
  };
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkLeaf(item, `item ${i}`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      checkLeaf(k, `key "${k}"`);
      checkLeaf(v, `value at "${k}"`);
    }
    return;
  }
  checkLeaf(value, "the value");
}

/**
 * One wire spelling of a parameter: where it lives, how it is framed, and
 * whether the declaration says so or leaves the default to be resolved.
 *
 * `styleDeclared` and `explodeDeclared` are separate axes because leaving
 * them unset is a different code path rather than a missing row, and it is
 * what published documents overwhelmingly do (92% declare no `style`).
 */
export interface Shape {
  id: string;
  location: Location;
  style: Style;
  styleDeclared: boolean;
  explode: boolean;
  explodeDeclared: boolean;
}

function shapeId(s: Omit<Shape, "id">): string {
  const style = s.styleDeclared ? s.style : `${s.style}(unset)`;
  const explode = s.explodeDeclared ? String(s.explode) : `${s.explode}(unset)`;
  return `${s.location}/${style}/explode=${explode}`;
}

/**
 * The styles each location legally carries, per the Parameter Object's
 * `style` field. `deepObject` is query-only and object-only;
 * `spaceDelimited` and `pipeDelimited` are query-only and array-only.
 */
const STYLES_FOR: Record<Location, Style[]> = {
  query: ["form", "spaceDelimited", "pipeDelimited", "deepObject"],
  path: ["simple", "label", "matrix"],
  header: ["simple"],
  cookie: ["form"],
};

/**
 * Whether a (style, explode) pair has a defined spelling for a value kind
 * in the Style Examples table.
 *
 * `spaceDelimited` and `pipeDelimited` appear only in the exploded-false
 * array row; the table gives no exploded form for either, so none is
 * invented here. `deepObject` appears only in the exploded-true object
 * row.
 */
function tableHasRow(style: Style, explode: boolean, kind: ValueKind): boolean {
  if (style === "spaceDelimited" || style === "pipeDelimited") {
    return kind === "array" && !explode;
  }
  if (style === "deepObject") return kind === "object" && explode;
  return true;
}

/**
 * Shapes this relation declines to compare, and why.
 *
 * An exploded `form` object spreads its properties across the top-level
 * keys of its container, which leaves the parameter's own name off the
 * wire. In a query string the library assembles the object back out of
 * those keys. In a cookie it deliberately does not: assembling a
 * form-styled cookie object is settled against and asserted at
 * `packages/validator/test/cookie-style.test.ts:128`, where OpenAPI 3.2's
 * `style: cookie` is the spelling that reads crumbs. Generating this shape
 * would make the relation assert a requirement the repository has already
 * decided against, which is deciding correct behaviour rather than
 * comparing shapes.
 */
function declinedShape(
  location: Location,
  style: Style,
  explode: boolean,
  kind: ValueKind,
): boolean {
  return location === "cookie" && style === "form" && explode && kind === "object";
}

/** Every shape legal for a value of this kind, across all four locations. */
export function shapesFor(kind: ValueKind): Shape[] {
  const out: Shape[] = [];
  for (const location of Object.keys(STYLES_FOR) as Location[]) {
    for (const style of STYLES_FOR[location]) {
      for (const explode of [false, true]) {
        if (!tableHasRow(style, explode, kind)) continue;
        if (declinedShape(location, style, explode, kind)) continue;
        const declared = {
          location,
          style,
          styleDeclared: true,
          explode,
          explodeDeclared: true,
        };
        out.push({ ...declared, id: shapeId(declared) });
        // The same spelling with the declaration left to resolve its own
        // defaults. Only generated where this style and explode ARE the
        // defaults, since that is the only case where the two shapes are
        // required to mean the same thing.
        if (style === DEFAULT_STYLE[location] && explode === defaultExplode(style)) {
          const undeclared = {
            location,
            style,
            styleDeclared: false,
            explode,
            explodeDeclared: false,
          };
          out.push({ ...undeclared, id: shapeId(undeclared) });
        }
      }
    }
  }
  return out;
}

/** A request patch: the fields a shape contributes to an `HttpRequest`. */
export interface Wire {
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string | string[]>;
  cookies?: Record<string, string | string[]>;
}

const str = (v: unknown): string => String(v);

/** `R,100,G,200` for explode false, `R=100,G=200` for explode true. */
function objectPairs(value: Record<string, unknown>, explode: boolean, join: string): string {
  const entries = Object.entries(value);
  return explode
    ? entries.map(([k, v]) => `${k}=${str(v)}`).join(join)
    : entries.flatMap(([k, v]) => [k, str(v)]).join(join);
}

/**
 * The OpenAPI Style Examples table, transcribed as code.
 *
 * Read this against the specification's table rather than against
 * `deserialize.ts`: it is the relation's model of the wire, and checking it
 * against the implementation it tests would make the relation agree with
 * whatever the implementation currently does.
 */
export function encode(shape: Shape, kind: ValueKind, value: unknown): Wire {
  const { location, style, explode } = shape;
  const token = ((): string => {
    if (kind === "scalar") {
      switch (style) {
        case "label":
          return `.${str(value)}`;
        case "matrix":
          return `;${NAME}=${str(value)}`;
        default:
          return str(value);
      }
    }
    if (kind === "array") {
      const items = (value as unknown[]).map(str);
      switch (style) {
        case "label":
          // The Style Examples table gives label two different array
          // rows: ".blue,black,brown" without explode, ".blue.black.brown"
          // with it. Writing the exploded spelling for both is the
          // encoder mistake this relation is most exposed to, since it
          // reads as a disagreement in the library.
          return `.${items.join(explode ? "." : ",")}`;
        case "matrix":
          return explode
            ? items.map((v) => `;${NAME}=${v}`).join("")
            : `;${NAME}=${items.join(",")}`;
        case "spaceDelimited":
          return items.join(" ");
        case "pipeDelimited":
          return items.join("|");
        default:
          return items.join(",");
      }
    }
    const obj = value as Record<string, unknown>;
    switch (style) {
      case "label":
        // ".R,100,G,200" without explode, ".R=100.G=200" with it.
        return `.${objectPairs(obj, explode, explode ? "." : ",")}`;
      case "matrix":
        return explode
          ? Object.entries(obj)
              .map(([k, v]) => `;${k}=${str(v)}`)
              .join("")
          : `;${NAME}=${objectPairs(obj, false, ",")}`;
      default:
        return objectPairs(obj, explode, ",");
    }
  })();

  if (location === "path") return { path: `${FLAT_PATH}/${token}` };
  if (location === "header") return { path: FLAT_PATH, headers: { [NAME]: token } };

  // query and cookie both carry `form`; query additionally carries the
  // three query-only styles. Both fields are already-parsed maps rather
  // than a raw string, so the exploded forms are expressed as a repeated
  // key (an array) and as separate keys, which is what a framework hands
  // an adapter.
  const field = location === "query" ? "query" : "cookies";
  if (style === "deepObject") {
    const obj = value as Record<string, unknown>;
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) q[`${NAME}[${k}]`] = str(v);
    return { path: FLAT_PATH, [field]: q } as Wire;
  }
  if (explode && kind === "array") {
    return { path: FLAT_PATH, [field]: { [NAME]: (value as unknown[]).map(str) } } as Wire;
  }
  if (explode && kind === "object") {
    const obj = value as Record<string, unknown>;
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) q[k] = str(v);
    return { path: FLAT_PATH, [field]: q } as Wire;
  }
  return { path: FLAT_PATH, [field]: { [NAME]: token } } as Wire;
}

/** A schema and a value, in both dialects, with the verdict expected of it. */
export interface Fixture {
  id: string;
  kind: ValueKind;
  /** 3.1 spelling. */
  schema31: Record<string, unknown>;
  /** 3.0 spelling. `nullable` and the boolean `exclusiveMaximum` differ. */
  schema30: Record<string, unknown>;
  value: unknown;
  /**
   * What every shape is expected to answer. The relation asserts agreement
   * across shapes; this field is what turns a unanimous wrong answer into
   * a failure rather than a pass, and it is the only place this file holds
   * an opinion about a single shape.
   */
  verdict: "valid" | "invalid";
}

const FIXTURES: Fixture[] = [
  {
    id: "str",
    kind: "scalar",
    schema31: { type: "string" },
    schema30: { type: "string" },
    value: "abc",
    verdict: "valid",
  },
  {
    id: "int",
    kind: "scalar",
    schema31: { type: "integer" },
    schema30: { type: "integer" },
    value: 7,
    verdict: "valid",
  },
  // 7 rather than 1.5: a fractional literal carries a dot, which `label`
  // frames with and an array-valued `label` splits on, so it is out of
  // domain. What is exercised here is that a `number` schema agrees across
  // shapes, and an integer literal does that.
  {
    id: "num",
    kind: "scalar",
    schema31: { type: "number" },
    schema30: { type: "number" },
    value: 7,
    verdict: "valid",
  },
  {
    id: "bool",
    kind: "scalar",
    schema31: { type: "boolean" },
    schema30: { type: "boolean" },
    value: true,
    verdict: "valid",
  },
  { id: "untyped", kind: "scalar", schema31: {}, schema30: {}, value: "abc", verdict: "valid" },
  {
    id: "strNull",
    kind: "scalar",
    schema31: { type: ["string", "null"] },
    schema30: { type: "string", nullable: true },
    value: "abc",
    verdict: "valid",
  },
  {
    id: "intBad",
    kind: "scalar",
    schema31: { type: "integer" },
    schema30: { type: "integer" },
    value: "abc",
    verdict: "invalid",
  },
  {
    id: "exclMaxOver",
    kind: "scalar",
    schema31: { type: "integer", exclusiveMaximum: 10 },
    schema30: { type: "integer", maximum: 10, exclusiveMaximum: true },
    value: 10,
    verdict: "invalid",
  },
  {
    id: "arrStr",
    kind: "array",
    schema31: { type: "array", items: { type: "string" } },
    schema30: { type: "array", items: { type: "string" } },
    value: ["ab", "cd"],
    verdict: "valid",
  },
  {
    id: "arrInt",
    kind: "array",
    schema31: { type: "array", items: { type: "integer" } },
    schema30: { type: "array", items: { type: "integer" } },
    value: [1, 2],
    verdict: "valid",
  },
  {
    id: "arrIntBad",
    kind: "array",
    schema31: { type: "array", items: { type: "integer" } },
    schema30: { type: "array", items: { type: "integer" } },
    value: ["ab", "cd"],
    verdict: "invalid",
  },
  // #825's own declaration: one object with a string property and an
  // integer property, which is where two of four shapes stopped coercing.
  {
    id: "objAN",
    kind: "object",
    schema31: { type: "object", properties: { a: { type: "string" }, n: { type: "integer" } } },
    schema30: { type: "object", properties: { a: { type: "string" }, n: { type: "integer" } } },
    value: { a: "x", n: 7 },
    verdict: "valid",
  },
  {
    id: "objANBad",
    kind: "object",
    schema31: { type: "object", properties: { a: { type: "string" }, n: { type: "integer" } } },
    schema30: { type: "object", properties: { a: { type: "string" }, n: { type: "integer" } } },
    value: { a: "x", n: "zz" },
    verdict: "invalid",
  },
  {
    id: "objStr",
    kind: "object",
    schema31: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
    schema30: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
    value: { a: "x", b: "y" },
    verdict: "valid",
  },
];

/** The fixtures, domain-checked. */
export function fixtures(): Fixture[] {
  for (const f of FIXTURES) assertInDomain(f.id, f.value);
  return FIXTURES;
}

export const OAS_VERSIONS = ["3.0.3", "3.1.0"] as const;
export type OasVersion = (typeof OAS_VERSIONS)[number];

/** The document declaring one parameter in one shape. */
export function documentFor(oas: OasVersion, shape: Shape, fixture: Fixture): OpenAPIDocument {
  const parameter: Record<string, unknown> = {
    name: NAME,
    in: shape.location,
    required: true,
    schema: oas.startsWith("3.0") ? fixture.schema30 : fixture.schema31,
  };
  if (shape.styleDeclared) parameter["style"] = shape.style;
  if (shape.explodeDeclared) parameter["explode"] = shape.explode;
  const template = shape.location === "path" ? PATH_TEMPLATE : FLAT_PATH;
  return {
    openapi: oas,
    info: { title: "cross-shape", version: "1" },
    paths: {
      [template]: {
        get: { parameters: [parameter], responses: { 200: { description: "ok" } } },
      },
    },
  } as unknown as OpenAPIDocument;
}

/** Where a location's value lands in `RequestValues`. */
export function bucketFor(location: Location): "path" | "query" | "headers" | "cookies" {
  if (location === "header") return "headers";
  if (location === "cookie") return "cookies";
  return location;
}

/** One comparable case: a shape, its document, and its request. */
export interface Case {
  oas: OasVersion;
  fixture: Fixture;
  shape: Shape;
  document: OpenAPIDocument;
  request: { method: string } & Wire;
}

/**
 * The PRESENT and PRESENT-INVALID families: every (version, fixture) group
 * crossed with every shape legal for its value kind. Grouped, because the
 * relation is over a group rather than over a case.
 */
export function* presentGroups(): Generator<{ key: string; fixture: Fixture; cases: Case[] }> {
  for (const oas of OAS_VERSIONS) {
    for (const fixture of fixtures()) {
      const cases = shapesFor(fixture.kind).map((shape) => ({
        oas,
        fixture,
        shape,
        document: documentFor(oas, shape, fixture),
        request: { method: "GET", ...encode(shape, fixture.kind, fixture.value) },
      }));
      yield { key: `${oas}|${fixture.id}`, fixture, cases };
    }
  }
}

/**
 * The ABSENT family: a required parameter with nothing on the wire.
 *
 * Within-location, unlike {@link presentGroups}. A path parameter with no
 * segment is a route miss, so the router answers rather than the parameter
 * layer, and comparing that to a missing query parameter would be
 * comparing two different subsystems. The route-miss case is pinned
 * separately in the test file.
 */
export function* absentGroups(): Generator<{ key: string; fixture: Fixture; cases: Case[] }> {
  for (const oas of OAS_VERSIONS) {
    for (const fixture of fixtures()) {
      for (const location of ["query", "header", "cookie"] as const) {
        const cases = shapesFor(fixture.kind)
          .filter((s) => s.location === location)
          .map((shape) => ({
            oas,
            fixture,
            shape,
            document: documentFor(oas, shape, fixture),
            request: { method: "GET", path: FLAT_PATH },
          }));
        if (cases.length > 1)
          yield { key: `${oas}|${fixture.id}|${location}|absent`, fixture, cases };
      }
    }
  }
}

/** Total generated case count, for the runtime report. */
export function caseCount(): { present: number; absent: number } {
  let present = 0;
  let absent = 0;
  for (const g of presentGroups()) present += g.cases.length;
  for (const g of absentGroups()) absent += g.cases.length;
  return { present, absent };
}

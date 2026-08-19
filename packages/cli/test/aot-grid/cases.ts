/**
 * The AOT parity grid's generator: documents, and the wire inputs to
 * drive each one with.
 *
 * Two products rather than one cross-product. The parity defects this
 * exists to find sit in two places, and the places do not interact
 * across most of their cells:
 *
 * - **Product A**, parameter deserialization. One `get` operation, no
 *   security, 3.1, and every parameter axis crossed. #888, #903 and the
 *   `allowEmptyValue` divergence live here, and none of them cares what
 *   the document declares above the operation.
 * - **Product B**, request-level dispatch. A fixed, deliberately boring
 *   parameter set, and the document shape crossed instead: declared
 *   methods, `security`, parameter count, OpenAPI version. #899 and
 *   #895 live here, and both short-circuit before any parameter is
 *   read, which is why crossing them with product A's 1,300
 *   declarations would re-derive one answer a thousand times.
 *
 * The interactions worth cells are enumerated instead (see
 * `securityWithFailingParameter`). The claim is not that document shape
 * never interacts with parameter shape; it is that the interactions
 * worth cells are few enough to name.
 *
 * **No expected values live here.** This module produces inputs. The
 * runner records what each side did and the gate compares them, so
 * there is no oracle at this layer.
 *
 * **The grid holds no opinion.** `style: deepObject` on a `type: string`
 * parameter is not a thing anyone writes, and `?p=0x1A` against
 * `type: boolean` is not a request anyone means. They stay in, for the
 * reason `scripts/grid/cases.mjs` gives: filtering to the combinations
 * that "make sense" encodes one reading of the serialization rules into
 * the instrument meant to detect changes in that reading.
 *
 * The schema shapes and the wire lexemes were seeded from
 * `scripts/grid/cases.mjs` at `9577133` and are deliberately a separate
 * copy: that module is a review aid that is explicitly not a gate, and
 * importing it would make an edit there an edit to this gate. The cost
 * is real and is named in this directory's README: the two sets can
 * drift and nothing will notice.
 */

import type { OpenAPIDocument, SchemaOrBoolean } from "@oaverify/internal-core";

/** The parameter name every generated declaration uses. */
const NAME = "p";

/**
 * Schema shapes. The nullable pairs appear in both member orders
 * because `["array","null"]` and `["null","array"]` are the same schema
 * and #742 was them behaving differently. `strInt` is the
 * two-readable-member case #752 tracks.
 */
export const SCHEMAS: Array<[string, SchemaOrBoolean]> = [
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

/** The styles OpenAPI defines for each location. 3.2 adds `cookie`. */
const STYLES: Record<Location, string[]> = {
  query: ["form", "spaceDelimited", "pipeDelimited", "deepObject"],
  path: ["simple", "label", "matrix"],
  header: ["simple"],
  cookie: ["form"],
};

export type Location = "query" | "path" | "header" | "cookie";
export const LOCATIONS: Location[] = ["query", "path", "header", "cookie"];

/**
 * `style` / `explode` combinations per location, including the ones
 * where either field is left undeclared.
 *
 * Undeclared is not a gap in the declared set: the library resolves the
 * default before deserializing anything, so it is a different code
 * path, and #766 measured it as the path 92% of real parameters take
 * while `scripts/grid` declares both on every case. One field set and
 * the other unset is included for the same reason: the two defaults
 * resolve independently.
 */
function styleExplodeCombos(location: Location): Array<{ style?: string; explode?: boolean }> {
  const combos: Array<{ style?: string; explode?: boolean }> = [];
  for (const style of STYLES[location]) {
    combos.push({ style, explode: false });
    combos.push({ style, explode: true });
    combos.push({ style });
  }
  combos.push({ explode: false });
  combos.push({ explode: true });
  combos.push({});
  return combos;
}

/** The axes of a case, structured so a divergence entry can match on fields. */
export interface CaseAxes {
  product: "A" | "B";
  in?: Location;
  style?: string;
  explode?: boolean;
  schemaId?: string;
  required?: boolean;
  /** `schema` or `content`; see the media-type axis for the latter. */
  source?: "schema" | "content";
  mediaType?: string;
  allowEmptyValue?: boolean;
  /** Product B: which methods the path item declares. */
  methods?: string[];
  /** Product B: where `security` is declared. */
  security?: "none" | "operation" | "document" | "both" | "operation-empty";
  /** Product B: how many parameters the operation declares. */
  params?: number;
  version?: string;
  /** The runtime's `validateSecurity`; the emitted module has no such option. */
  runtimeSecurity: "off" | "shape";
  /** Free-form label for a hand-built product B shape. */
  shape?: string;
}

/**
 * A wire input, typed rather than a bag: the runner reads `method` and
 * `path` to call `getOperation`, and a `Record<string, unknown>` makes
 * that a stringification of `unknown` the type-aware lint rejects.
 */
export interface WireRequest {
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}

export interface Declaration {
  /** Human-readable, for reports. Never used to match an entry. */
  id: string;
  axes: CaseAxes;
  doc: OpenAPIDocument;
  /** Requests to drive this declaration with. */
  requests: Array<{ wireId: string; request: WireRequest }>;
}

/** Query wire inputs. Leads with the lexemes #736 and #751 decided. */
const QUERY_WIRE: Array<[string, Record<string, string | string[]>]> = [
  ["absent", {}],
  ["empty", { [NAME]: "" }],
  ["int", { [NAME]: "7" }],
  ["hex", { [NAME]: "0x1A" }],
  ["padded", { [NAME]: "  7  " }],
  ["exp", { [NAME]: "1e3" }],
  ["leadingZeros", { [NAME]: "007" }],
  ["true", { [NAME]: "true" }],
  ["word", { [NAME]: "abc" }],
  ["csv", { [NAME]: "a,b,c" }],
  ["csvInts", { [NAME]: "1,2,3" }],
  ["ssv", { [NAME]: "a b c" }],
  ["psv", { [NAME]: "a|b|c" }],
  ["repeated", { [NAME]: ["a", "b"] }],
  ["deep", { [`${NAME}[a]`]: "x", [`${NAME}[n]`]: "7" }],
  ["deepHex", { [`${NAME}[n]`]: "0x1A" }],
  ["topLevelProps", { a: "x", n: "7" }],
  // The declared property names in one token. #824 sat under a green
  // differential because every object case used names the schema does
  // not declare, where there is no type to read and a string is right.
  ["propsCsv", { [NAME]: "a,x,n,7" }],
  ["propsCsvHex", { [NAME]: "a,x,n,0x1A" }],
  ["propsExploded", { [NAME]: "a=x,n=7" }],
];

/** Path wire inputs, substituted into the template. */
const PATH_WIRE: Array<[string, string]> = [
  ["int", "7"],
  ["hex", "0x1A"],
  ["word", "abc"],
  ["csv", "a,b,c"],
  ["label", ".a.b"],
  ["matrix", ";p=a"],
  ["matrixCsv", ";p=a,b"],
  ["matrixExploded", ";p=1;p=2"],
  // Groups naming another parameter: #758, where `stripStyle` dropped
  // any `;<name>=` prefix without checking the name.
  ["matrixWrongName", ";q=1"],
  ["matrixMixedNames", ";q=1;p=2"],
  ["encodedComma", "a%2Cb"],
  ["propsCsv", "a,x,n,7"],
  ["propsExploded", "a=x,n=7"],
  ["propsMatrix", ";p=a,x,n,7"],
];

/** Header and cookie wire inputs. */
const SCALAR_WIRE: Array<[string, string | undefined]> = [
  ["absent", undefined],
  ["empty", ""],
  ["int", "7"],
  ["hex", "0x1A"],
  ["csv", "a,b,c"],
  ["word", "abc"],
  ["propsCsv", "a,x,n,7"],
  ["propsExploded", "a=x,n=7"],
];

const okResponses = { "200": { description: "ok" } };

/**
 * A record carrying one key as an own property.
 *
 * A literal cannot express this: `{ __proto__: "v" }` sets the
 * prototype and produces no key at all, so the hostile-name cases below
 * would test nothing if they were written the obvious way.
 */
function assign(name: string, value: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  out[name] = value;
  return out;
}

/** Requests for one product A declaration, by location and path template. */
function requestsFor(location: Location, path: string): Declaration["requests"] {
  if (location === "query") {
    return QUERY_WIRE.map(([wireId, query]) => ({
      wireId,
      request: { method: "GET", path, query },
    }));
  }
  if (location === "path") {
    return PATH_WIRE.map(([wireId, segment]) => ({
      wireId,
      request: { method: "GET", path: path.replace(`{${NAME}}`, segment) },
    }));
  }
  const out: Declaration["requests"] = SCALAR_WIRE.map(([wireId, value]) => {
    const request: WireRequest = { method: "GET", path };
    if (value !== undefined) {
      if (location === "header") request.headers = { [NAME]: value };
      else request.cookies = { [NAME]: value };
    }
    return { wireId, request };
  });
  if (location === "header") {
    // Header names match case-insensitively (#575, where the lookup had
    // drifted into three strategies).
    out.push({
      wireId: "uppercased",
      request: { method: "GET", path, headers: { [NAME.toUpperCase()]: "7" } },
    });
  }
  return out;
}

/**
 * The `content` sub-axis: JSON against valid, invalid and
 * schema-invalid payloads, plus a non-JSON media type that passes the
 * raw string through. That is the branch structure of
 * `firstContentMediaType` + `isJsonMediaType` in `validate-step.ts`,
 * which the emitted module does not implement at all (#903).
 */
const CONTENT_VARIANTS: Array<{
  id: string;
  mediaType: string;
  schema: SchemaOrBoolean;
  wire: Array<[string, string]>;
}> = [
  {
    id: "json-obj",
    mediaType: "application/json",
    schema: { type: "object", properties: { R: { type: "integer" }, G: { type: "integer" } } },
    wire: [
      ["validJson", '{"R":1,"G":2}'],
      ["schemaInvalidJson", '{"R":"x","G":2}'],
      ["notJson", "R,100,G,200"],
    ],
  },
  {
    id: "text-str",
    mediaType: "text/plain",
    schema: { type: "string", minLength: 2 },
    wire: [
      ["raw", "hello"],
      ["tooShort", "h"],
    ],
  },
];

/**
 * Product A. Every declaration for one location goes into a single
 * document as its own path, so the whole location is one compile
 * instead of hundreds: brief 2a measured 306 separate documents at 1.9s
 * against 49ms folded.
 *
 * The fold trades a datum for speed, and the trade is stated rather
 * than hidden: a declaration the compiler refuses takes its whole
 * location's document with it, where one document per declaration would
 * have recorded a `build-error` for that cell alone. The runner reports
 * a failed fold as such.
 */
export function productA(): Declaration[] {
  const out: Declaration[] = [];
  for (const location of LOCATIONS) {
    const paths: Record<string, unknown> = {};
    const perDecl: Array<{ id: string; axes: CaseAxes; path: string }> = [];
    let n = 0;

    const add = (
      axes: Omit<CaseAxes, "product" | "runtimeSecurity">,
      parameter: Record<string, unknown>,
    ) => {
      const key = `d${n}`;
      n += 1;
      const template = location === "path" ? `/${key}/{${NAME}}` : `/${key}`;
      paths[template] = { get: { parameters: [parameter], responses: okResponses } };
      const id = `A|${location}|${axes.style ?? "-"}|explode=${axes.explode ?? "-"}|${
        axes.schemaId ?? axes.mediaType ?? "-"
      }|required=${axes.required === true}${axes.allowEmptyValue === true ? "|aev" : ""}`;
      perDecl.push({
        id,
        axes: { ...axes, product: "A", in: location, runtimeSecurity: "off" },
        path: template,
      });
    };

    for (const combo of styleExplodeCombos(location)) {
      for (const [schemaId, schema] of SCHEMAS) {
        for (const required of [false, true]) {
          add(
            { style: combo.style, explode: combo.explode, schemaId, required, source: "schema" },
            {
              name: NAME,
              in: location,
              ...(combo.style === undefined ? {} : { style: combo.style }),
              ...(combo.explode === undefined ? {} : { explode: combo.explode }),
              required,
              schema,
            },
          );
        }
      }
    }

    // `content` instead of `schema`, on the default style only: the
    // media type is what decides this branch, and crossing it with
    // style would multiply a branch that never reads style.
    for (const variant of CONTENT_VARIANTS) {
      for (const required of [false, true]) {
        add(
          {
            schemaId: variant.id,
            required,
            source: "content",
            mediaType: variant.mediaType,
          },
          {
            name: NAME,
            in: location,
            required,
            content: { [variant.mediaType]: { schema: variant.schema } },
          },
        );
      }
    }

    // `allowEmptyValue`, crossed with a schema that accepts the empty
    // string and one that refuses it. Either alone hides half of the
    // divergence round 1 fixed: the accepting schema shows it in the
    // value channel, the refusing one in the verdict.
    for (const [schemaId, schema] of [
      ["strAcceptsEmpty", { type: "string" }],
      ["strRejectsEmpty", { type: "string", minLength: 1 }],
    ] as Array<[string, SchemaOrBoolean]>) {
      for (const required of [false, true]) {
        add(
          { schemaId, required, source: "schema", allowEmptyValue: true },
          { name: NAME, in: location, required, allowEmptyValue: true, schema },
        );
      }
    }

    const doc: OpenAPIDocument = {
      openapi: "3.1.0",
      info: { title: `grid-A-${location}`, version: "1" },
      paths,
    } as OpenAPIDocument;

    for (const decl of perDecl) {
      const variant = CONTENT_VARIANTS.find((v) => v.id === decl.axes.schemaId);
      const requests =
        variant === undefined
          ? requestsFor(location, decl.path)
          : contentRequests(location, decl.path, variant.wire);
      out.push({ id: decl.id, axes: decl.axes, doc, requests });
    }
  }
  return out;
}

/** Wire inputs for a `content` declaration, per location. */
function contentRequests(
  location: Location,
  path: string,
  wire: Array<[string, string]>,
): Declaration["requests"] {
  return wire.map(([wireId, value]) => {
    if (location === "query") {
      return { wireId, request: { method: "GET", path, query: { [NAME]: value } } };
    }
    if (location === "path") {
      return {
        wireId,
        request: { method: "GET", path: path.replace(`{${NAME}}`, encodeURIComponent(value)) },
      };
    }
    const request: WireRequest = { method: "GET", path };
    if (location === "header") request.headers = { [NAME]: value };
    else request.cookies = { [NAME]: value };
    return { wireId, request };
  });
}

const API_KEY = { k: { type: "apiKey", in: "header", name: "X-Key" } };

/** One boring parameter per location, for product B's document shapes. */
const PLAIN_PARAMS = [
  { name: "q", in: "query", schema: { type: "string" } },
  { name: "X-H", in: "header", schema: { type: "string" } },
  { name: "c", in: "cookie", schema: { type: "string" } },
];

/**
 * Product B. The document shape is the axis, so these are not folded:
 * folding would erase the shape under test.
 */
export function productB(): Declaration[] {
  const out: Declaration[] = [];
  const push = (
    id: string,
    axes: Omit<CaseAxes, "product">,
    doc: OpenAPIDocument,
    requests: Declaration["requests"],
  ) => out.push({ id: `B|${id}`, axes: { ...axes, product: "B" }, doc, requests });

  // Declared methods. #899: the router answers HEAD with the GET
  // operation, so a path declaring only `get` has to agree about HEAD
  // on both sides.
  const methodSets: Array<[string, string[]]> = [
    ["get", ["get"]],
    ["get+post", ["get", "post"]],
    ["post", ["post"]],
  ];
  const drivenMethods = ["GET", "HEAD", "POST", "DELETE", "OPTIONS"];
  for (const [id, methods] of methodSets) {
    const item: Record<string, unknown> = {};
    for (const m of methods) item[m] = { parameters: PLAIN_PARAMS, responses: okResponses };
    push(
      `methods=${id}`,
      { shape: "methods", methods, runtimeSecurity: "off", version: "3.1.0" },
      {
        openapi: "3.1.0",
        info: { title: "grid-B-methods", version: "1" },
        paths: { "/t": item },
      } as OpenAPIDocument,
      drivenMethods.map((method) => ({
        wireId: method,
        request: { method, path: "/t", query: { q: "x" } },
      })),
    );
  }

  // Security, crossed with the runtime's `validateSecurity`. The
  // emitted module has no such option, so the axis is over the runtime
  // side alone, which is what makes the configurability half of #895
  // visible: doc-level security rejects under `shape` and passes on the
  // AOT side whatever the option says.
  const securityShapes: Array<[CaseAxes["security"], Record<string, unknown>]> = [
    ["none", {}],
    ["operation", { op: [{ k: [] }] }],
    ["document", { doc: [{ k: [] }] }],
    ["both", { doc: [{ k: [] }], op: [{ k: [] }] }],
    // An empty operation-level array is the spec's way to opt one
    // operation out of a document-level requirement.
    ["operation-empty", { doc: [{ k: [] }], op: [] }],
  ];
  for (const [security, shape] of securityShapes) {
    for (const runtimeSecurity of ["off", "shape"] as const) {
      const operation: Record<string, unknown> = {
        parameters: PLAIN_PARAMS,
        responses: okResponses,
      };
      if (shape.op !== undefined) operation.security = shape.op;
      const doc: OpenAPIDocument = {
        openapi: "3.1.0",
        info: { title: "grid-B-security", version: "1" },
        components: { securitySchemes: API_KEY },
        ...(shape.doc === undefined ? {} : { security: shape.doc }),
        paths: { "/t": { get: operation } },
      } as OpenAPIDocument;
      push(
        `security=${security}|runtime=${runtimeSecurity}`,
        { shape: "security", security, runtimeSecurity, version: "3.1.0" },
        doc,
        [
          { wireId: "noCredential", request: { method: "GET", path: "/t", query: { q: "x" } } },
          {
            wireId: "withCredential",
            request: { method: "GET", path: "/t", query: { q: "x" }, headers: { "x-key": "s" } },
          },
        ],
      );
    }
  }

  // Security x a parameter that fails its schema. The named cross term:
  // the question is whether both sides short-circuit before recording
  // the parameter, which only the value channel can answer.
  for (const runtimeSecurity of ["off", "shape"] as const) {
    push(
      `security-vs-bad-parameter|runtime=${runtimeSecurity}`,
      { shape: "security-x-parameter", security: "document", runtimeSecurity, version: "3.1.0" },
      {
        openapi: "3.1.0",
        info: { title: "grid-B-sec-param", version: "1" },
        components: { securitySchemes: API_KEY },
        security: [{ k: [] }],
        paths: {
          "/t": {
            get: {
              parameters: [{ name: "n", in: "query", schema: { type: "integer" } }],
              responses: okResponses,
            },
          },
        },
      } as OpenAPIDocument,
      [
        {
          wireId: "badParamNoCredential",
          request: { method: "GET", path: "/t", query: { n: "x" } },
        },
        {
          wireId: "badParamWithCredential",
          request: {
            method: "GET",
            path: "/t",
            query: { n: "x" },
            headers: { "x-key": "s" },
          },
        },
      ],
    );
  }

  // Two parameters contending in one location. Section 2e of the brief
  // measured the obvious query case as sound today; it stays because it
  // is the only shape where the value channel can show a value
  // attributed to the wrong parameter, which no verdict expresses.
  const OBJ = { type: "object", properties: { a: { type: "string" }, n: { type: "integer" } } };
  push(
    "contending-query-objects",
    { shape: "contention", params: 2, runtimeSecurity: "off", version: "3.1.0" },
    {
      openapi: "3.1.0",
      info: { title: "grid-B-contend", version: "1" },
      paths: {
        "/t": {
          get: {
            parameters: [
              { name: "p", in: "query", style: "form", explode: true, schema: OBJ },
              { name: "q", in: "query", style: "form", explode: true, schema: OBJ },
            ],
            responses: okResponses,
          },
        },
      },
    } as OpenAPIDocument,
    [
      { wireId: "bothProps", request: { method: "GET", path: "/t", query: { a: "x", n: "7" } } },
      {
        wireId: "oneBad",
        request: { method: "GET", path: "/t", query: { a: "x", n: "notanint" } },
      },
      { wireId: "empty", request: { method: "GET", path: "/t", query: {} } },
    ],
  );

  // Parameter names that are inherited members of a plain object. A
  // by-name read that does not test own-property finds `constructor`
  // on every record and satisfies a required parameter nobody sent.
  // `compile-spec.test.ts` pins the codes for this as a regression;
  // the grid's job is the differential half, so both sides answer the
  // same way whatever that answer is.
  for (const name of ["constructor", "__proto__", "toString"]) {
    for (const location of LOCATIONS) {
      const template = location === "path" ? `/t/{${name}}` : "/t";
      const supplied: WireRequest = { method: "GET", path: location === "path" ? "/t/v" : "/t" };
      if (location === "query") supplied.query = assign(name, "v");
      if (location === "header") supplied.headers = assign(name, "v");
      if (location === "cookie") supplied.cookies = assign(name, "v");
      push(
        `hostile-name=${name}|${location}`,
        { shape: "hostile-name", in: location, runtimeSecurity: "off", version: "3.1.0" },
        {
          openapi: "3.1.0",
          info: { title: "grid-B-hostile", version: "1" },
          paths: {
            [template]: {
              get: {
                parameters: [{ name, in: location, required: true, schema: { type: "string" } }],
                responses: okResponses,
              },
            },
          },
        } as OpenAPIDocument,
        [
          // The frame is present and empty, which is where an
          // inherited member is reachable.
          {
            wireId: "absent",
            request: {
              method: "GET",
              path: location === "path" ? "/t/v" : "/t",
              query: {},
              headers: {},
              cookies: {},
            },
          },
          { wireId: "supplied", request: supplied },
        ],
      );
    }
  }

  // Versions. The parameters stay `{type: string}`, legal in all three,
  // so the axis reaches dialect dispatch and version detection without
  // forking the schema set the way 3.0's `nullable` would.
  for (const version of ["3.0.3", "3.1.0", "3.2.0"]) {
    push(
      `version=${version}`,
      { shape: "version", version, runtimeSecurity: "off" },
      {
        openapi: version,
        info: { title: "grid-B-version", version: "1" },
        paths: {
          "/t/{id}": {
            get: {
              parameters: [
                { name: "id", in: "path", required: true, schema: { type: "string" } },
                ...PLAIN_PARAMS,
              ],
              responses: okResponses,
            },
          },
        },
      } as OpenAPIDocument,
      [
        {
          wireId: "populated",
          request: {
            method: "GET",
            path: "/t/7",
            query: { q: "x" },
            headers: { "x-h": "h" },
            cookies: { c: "c" },
          },
        },
        { wireId: "bare", request: { method: "GET", path: "/t/7" } },
      ],
    );
  }

  // 3.2's `style: cookie`, which spreads an exploded object over one
  // crumb per property. The version axis above reaches dispatch; this
  // reaches the serialization shape that is new in 3.2.
  for (const explode of [false, true]) {
    for (const [schemaId, schema] of [
      ["objAN", OBJ],
      ["str", { type: "string" }],
    ] as Array<[string, SchemaOrBoolean]>) {
      push(
        `cookie-style-3.2|explode=${explode}|${schemaId}`,
        {
          shape: "cookie-style",
          version: "3.2.0",
          in: "cookie",
          style: "cookie",
          explode,
          schemaId,
          runtimeSecurity: "off",
        },
        {
          openapi: "3.2.0",
          info: { title: "grid-B-cookie", version: "1" },
          paths: {
            "/t": {
              get: {
                parameters: [{ name: "p", in: "cookie", style: "cookie", explode, schema }],
                responses: okResponses,
              },
            },
          },
        } as OpenAPIDocument,
        [
          { wireId: "crumbs", request: { method: "GET", path: "/t", cookies: { a: "x", n: "7" } } },
          {
            wireId: "underName",
            request: { method: "GET", path: "/t", cookies: { p: "a,x,n,7" } },
          },
          { wireId: "scalar", request: { method: "GET", path: "/t", cookies: { p: "hello" } } },
          { wireId: "absent", request: { method: "GET", path: "/t" } },
        ],
      );
    }
  }

  return out;
}

/** Every declaration, both products. */
export function declarations(): Declaration[] {
  return [...productA(), ...productB()];
}

/**
 * The framing relation's case generator.
 *
 * ## The relation
 *
 * A wire token that does not carry its declared style's framing, or whose
 * group names a different parameter, supplies nothing. The parameter is
 * not populated, and the request is answered as though the parameter had
 * not arrived.
 *
 * `label` frames every expansion with a leading ".", and `matrix` frames a
 * segment as a run of ";name=value" groups where the name says which
 * parameter the group supplies. Those are the only two styles with framing
 * to omit, which is why this relation is as narrow as it is (see
 * "Narrowness" below). #823 taught the framing rule to `stripStyle`, and
 * #788 taught the group-name rule to every matrix shape rather than to one
 * of two code paths. Both were accept-invalid defects: a token that named
 * nothing of ours supplied a value anyway.
 *
 * The oracle is not this file's invention. #788's commit message states
 * it: the "this group must name this parameter" rule is what "makes
 * `;q=1` an absent".
 *
 * ## Why this is round 2
 *
 * Round 1's `cross-shape.ts` varies the SPELLING at a fixed value and is
 * blind to malformed input, which it records as the largest item on its
 * own list. This varies WELLFORMEDNESS at a fixed spelling, so it breaks a
 * different symmetry and covers what round 1 states it cannot.
 *
 * ## Narrowness, stated rather than argued away
 *
 * This relation reaches path-located `label` and `matrix` parameters and
 * nothing else. `simple` has no framing to omit, and in query, header and
 * cookie a wrong key is indistinguishable from absence, so there is no
 * malformed form to construct.
 *
 * That vocabulary has no measured users. Counting
 * `detection/real-world/specs`, 301 published documents and 56,555
 * parameters, `matrix` and `label` appear on zero of them, and OpenAPI 4.0
 * removes both. The defects were real and a validator that misreads a
 * matrix segment is wrong either way, and it is worth knowing that this
 * relation guards a corner rather than a thoroughfare.
 *
 * ## What it cannot see
 *
 * 1. A malformed token that some other layer rejects first, which masks
 *    the parameter-level answer. Observed: at 9c0627e~1 the demonstration
 *    is partly masked, and the test file records which rows are attributed
 *    to which defect.
 * 2. Malformation after a correctly framed opening. `;p=a;q=1` opens
 *    correctly and carries a foreign group second; only the whole-token
 *    forms are generated here.
 * 3. Any correctness question beyond the absent-token rule. This says
 *    nothing about what a WELL-framed token should deserialize to, which
 *    is round 1's job.
 * 4. Every location and style outside path-located label and matrix.
 * 5. A change that treats every malformed token as supplying a value, AND
 *    every absent parameter as supplying the same value. Symmetric
 *    breakage, the standing blind spot of any relation of this kind.
 */

import type { OpenAPIDocument } from "@oaverify/internal-core";

/** The parameter name every declaration uses. */
export const NAME = "p";

/** The other name a foreign matrix group claims to supply. */
export const FOREIGN_NAME = "q";

export const PATH_TEMPLATE = `/t/{${NAME}}`;

/** The two styles that frame their expansions. `simple` has no framing. */
export type FramedStyle = "label" | "matrix";

export const FRAMED_STYLES: FramedStyle[] = ["label", "matrix"];

export type ValueKind = "scalar" | "array" | "object";

/**
 * A wire token, and whether it is framed for the style that will read it.
 *
 * `framed` tokens are the control arm: they must supply the value, so a
 * change that made the relation vacuous by rejecting everything fails
 * here rather than passing quietly.
 */
export interface Token {
  id: string;
  raw: string;
  framed: boolean;
}

/** Correctly framed tokens, per the Style Examples table. */
function framedTokens(style: FramedStyle, kind: ValueKind, explode: boolean): Token[] {
  if (style === "label") {
    if (kind === "scalar") return [{ id: "framed-scalar", raw: ".ab", framed: true }];
    if (kind === "array") {
      return [{ id: "framed-array", raw: explode ? ".ab.cd" : ".ab,cd", framed: true }];
    }
    return [{ id: "framed-object", raw: explode ? ".a=x.b=y" : ".a,x,b,y", framed: true }];
  }
  if (kind === "scalar") return [{ id: "framed-scalar", raw: `;${NAME}=ab`, framed: true }];
  if (kind === "array") {
    return [
      {
        id: "framed-array",
        raw: explode ? `;${NAME}=ab;${NAME}=cd` : `;${NAME}=ab,cd`,
        framed: true,
      },
    ];
  }
  return [{ id: "framed-object", raw: explode ? ";a=x;b=y" : `;${NAME}=a,x,b,y`, framed: true }];
}

/**
 * Tokens that are malformed for the style that will read them.
 *
 * Two kinds, and they are different defects. A token missing its framing
 * entirely is #823. A `matrix` segment that IS framed but whose groups all
 * name another parameter is #788, and it is the one a naive
 * "starts with ';'" check accepts.
 *
 * The `label` opener is reused as a `matrix` malformation and vice versa,
 * because a token framed for the OTHER framed style is the most plausible
 * way for a real request to arrive wrong.
 */
function malformedTokens(style: FramedStyle, kind: ValueKind, explode: boolean): Token[] {
  const bare = kind === "scalar" ? "ab" : kind === "array" ? "ab,cd" : "a,x,b,y";
  const out: Token[] = [{ id: "unframed", raw: bare, framed: false }];
  if (style === "label") {
    // Framed for matrix, read as label: no leading dot.
    out.push({ id: "framed-for-matrix", raw: `;${NAME}=${bare}`, framed: false });
    return out;
  }
  // Framed for label, read as matrix: no leading semicolon.
  out.push({ id: "framed-for-label", raw: `.${bare}`, framed: false });
  // #788: correctly framed as a matrix segment, every group naming another
  // parameter. The shape that a leading-semicolon check accepts.
  //
  // Not generated for an exploded object, where a group name is a PROPERTY
  // name rather than the parameter name: `;q=1` there is a well-formed
  // object `{q: "1"}` for a parameter named anything at all, so calling it
  // malformed would assert a falsehood. The group-name rule #788 restored
  // governs the shapes whose group name IS the parameter name, which is
  // every matrix shape except this one.
  if (kind === "object" && explode) return out;
  out.push({ id: "foreign-group", raw: `;${FOREIGN_NAME}=1`, framed: false });
  out.push({
    id: "foreign-groups",
    raw: explode ? `;${FOREIGN_NAME}=1;${FOREIGN_NAME}=2` : `;${FOREIGN_NAME}=1,2`,
    framed: false,
  });
  return out;
}

export function tokensFor(style: FramedStyle, kind: ValueKind, explode: boolean): Token[] {
  return [...framedTokens(style, kind, explode), ...malformedTokens(style, kind, explode)];
}

export interface Fixture {
  id: string;
  kind: ValueKind;
  schema31: Record<string, unknown>;
  schema30: Record<string, unknown>;
}

const FIXTURES: Fixture[] = [
  { id: "str", kind: "scalar", schema31: { type: "string" }, schema30: { type: "string" } },
  {
    id: "arrStr",
    kind: "array",
    schema31: { type: "array", items: { type: "string" } },
    schema30: { type: "array", items: { type: "string" } },
  },
  {
    id: "objStr",
    kind: "object",
    schema31: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
    schema30: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
  },
];

export function fixtures(): Fixture[] {
  return FIXTURES;
}

export const OAS_VERSIONS = ["3.0.3", "3.1.0"] as const;
export type OasVersion = (typeof OAS_VERSIONS)[number];

/**
 * `required` is an axis rather than a constant, and it is what makes the
 * relation observable.
 *
 * With `required: true` a malformed token and an unsupplied parameter both
 * fail, so the two are compared on the verdict. With `required: false`
 * both PASS, and the only thing distinguishing "supplied nothing" from
 * "supplied something" is whether the parameter appears in `value`. A
 * relation over the required arm alone could not tell an absent parameter
 * from one whose malformed token deserialized to a value the schema then
 * rejected.
 */
export const REQUIRED_ARMS = [true, false] as const;

export function documentFor(
  oas: OasVersion,
  style: FramedStyle,
  explode: boolean,
  required: boolean,
  fixture: Fixture,
): OpenAPIDocument {
  return {
    openapi: oas,
    info: { title: "framing", version: "1" },
    paths: {
      [PATH_TEMPLATE]: {
        get: {
          parameters: [
            {
              name: NAME,
              in: "path",
              required,
              style,
              explode,
              schema: oas.startsWith("3.0") ? fixture.schema30 : fixture.schema31,
            },
          ],
          responses: { 200: { description: "ok" } },
        },
      },
    },
  } as unknown as OpenAPIDocument;
}

export interface Case {
  oas: OasVersion;
  style: FramedStyle;
  explode: boolean;
  required: boolean;
  fixture: Fixture;
  token: Token;
  document: OpenAPIDocument;
  request: { method: string; path: string };
}

export function* cases(): Generator<Case> {
  for (const oas of OAS_VERSIONS) {
    for (const style of FRAMED_STYLES) {
      for (const explode of [false, true]) {
        for (const required of REQUIRED_ARMS) {
          for (const fixture of fixtures()) {
            for (const token of tokensFor(style, fixture.kind, explode)) {
              yield {
                oas,
                style,
                explode,
                required,
                fixture,
                token,
                document: documentFor(oas, style, explode, required, fixture),
                request: { method: "GET", path: `/t/${token.raw}` },
              };
            }
          }
        }
      }
    }
  }
}

export function caseCount(): number {
  let n = 0;
  for (const _ of cases()) n += 1;
  return n;
}

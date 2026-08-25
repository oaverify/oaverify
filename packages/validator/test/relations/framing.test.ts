/**
 * The framing relation. `framing.ts` carries the relation statement, the
 * narrowness, and the full list of what it cannot see.
 *
 * The observable is whether the parameter is POPULATED, read from
 * `returnValues`, rather than an error message. A message is prose and
 * moves; "the handler received a value for `p`" is the thing the defect
 * actually was. The error code is asserted alongside it on the required
 * arm as an anchor, so a change that started answering a malformed token
 * with a different class of failure is visible.
 *
 * Two arms per case, and the unrequired one is doing the real work. With
 * `required: true` a malformed token and an unsupplied parameter both
 * fail, so they agree on `valid` for a reason that has nothing to do with
 * this relation. With `required: false` both pass, and the only difference
 * between "supplied nothing" and "supplied something the schema happened
 * to accept" is the `value` entry.
 *
 * No random generation, so no seed: each failure prints the whole case.
 */

import { describe, expect, it } from "vitest";
import { createValidator } from "../../src/validator.js";
import { caseCount, cases, NAME, type Case } from "./framing.js";

function descriptor(c: Case): string {
  return [
    `oas=${c.oas}`,
    `style=${c.style}`,
    `explode=${c.explode}`,
    `required=${c.required}`,
    `fixture=${c.fixture.id}`,
    `token=${c.token.id}`,
    `framed=${c.token.framed}`,
    `path=${c.request.path}`,
  ].join(" ");
}

interface Observation {
  valid: boolean;
  supplied: boolean;
  value: unknown;
  code: string | undefined;
}

function observe(c: Case): Observation {
  const validator = createValidator(c.document, { returnValues: true });
  const result = validator.validateRequest(c.request);
  const bucket = result.value.path as Record<string, unknown>;
  const supplied = NAME in bucket;
  return {
    valid: result.valid,
    supplied,
    value: supplied ? bucket[NAME] : undefined,
    code: result.valid ? undefined : result.errors[0]?.code,
  };
}

const all = [...cases()];
const malformed = all.filter((c) => !c.token.framed);
const framed = all.filter((c) => c.token.framed);

describe("framing relation: a malformed token supplies nothing", () => {
  // The relation. `supplied` is read from `returnValues`, which populates a
  // parameter only when the call reached it, deserialized it, and its
  // schema accepted the result. So an unpopulated entry is exactly "this
  // token gave us no value", which is what #788 and #823 were about.
  for (const c of malformed) {
    it(`${descriptor(c)}`, () => {
      const got = observe(c);
      expect(got.supplied, `${descriptor(c)}\n  supplied ${JSON.stringify(got.value)}`).toBe(false);
    });
  }
});

describe("framing relation: a malformed token is answered as an absent one", () => {
  // The metamorphic half. On the required arm the request must fail as a
  // missing path parameter rather than as a bad value, which is the
  // verdict class an unsupplied parameter produces. On the unrequired arm
  // it must pass, because an absent optional parameter is not an error.
  for (const c of malformed) {
    it(`${descriptor(c)}`, () => {
      const got = observe(c);
      if (c.required) {
        expect(got.valid, descriptor(c)).toBe(false);
        expect(got.code, descriptor(c)).toBe("path-param");
      } else {
        expect(got.valid, descriptor(c)).toBe(true);
      }
    });
  }
});

describe("framing relation: a framed token still supplies its value", () => {
  // The control arm, and it is not decoration. Without it, a change that
  // rejected every path token would satisfy both assertions above and the
  // relation would report success while validating nothing.
  for (const c of framed) {
    it(`${descriptor(c)}`, () => {
      const got = observe(c);
      expect(got.supplied, `${descriptor(c)}\n  ${JSON.stringify(got)}`).toBe(true);
      expect(got.valid, descriptor(c)).toBe(true);
    });
  }
});

describe("framing relation: case count", () => {
  it("generates the recorded number of cases", () => {
    // Pinned rather than bounded, for the reason round 1 records: a
    // generator that silently dropped an axis reads as a faster run.
    expect(caseCount()).toBe(184);
    expect(malformed.length).toBe(136);
    expect(framed.length).toBe(48);
    // The split must exhaust the total: a token that is neither arm would
    // otherwise be generated and asserted on by nothing.
    expect(malformed.length + framed.length).toBe(caseCount());
  });
});

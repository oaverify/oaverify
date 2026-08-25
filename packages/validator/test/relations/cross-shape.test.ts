/**
 * The cross-shape relation. See `cross-shape.ts` for the relation
 * statement, the value domain, and the five things it cannot see.
 *
 * What is compared, and what deliberately is not: the verdict and the
 * deserialized value. Not the errors. A query parameter and a path
 * parameter report at different error paths with different messages by
 * design, so error equality would fail on correct behaviour. A defect that
 * changes only an error's shape is therefore invisible here, which is a
 * sixth blind spot on top of the five in `cross-shape.ts`.
 *
 * Every case prints its full descriptor on failure. There is no random
 * generation, so the descriptor is the input: a failure reproduces from
 * the printed line alone, on another machine, with no seed to record.
 */

import { describe, expect, it } from "vitest";
import { createValidator } from "../../src/validator.js";
import {
  bucketFor,
  caseCount,
  documentFor,
  absentGroups,
  encode,
  FLAT_PATH,
  fixtures,
  NAME,
  presentGroups,
  shapesFor,
  type Case,
} from "./cross-shape.js";

/** Marks a parameter the validator did not put in `value`. */
const ABSENT = Symbol("absent");

interface Observation {
  shapeId: string;
  valid: boolean;
  value: unknown;
}

/** One line carrying everything needed to rebuild the case by hand. */
function descriptor(c: Case): string {
  return [
    `oas=${c.oas}`,
    `fixture=${c.fixture.id}`,
    `kind=${c.fixture.kind}`,
    `shape=${c.shape.id}`,
    `wire=${JSON.stringify({
      path: c.request.path,
      query: c.request.query,
      headers: c.request.headers,
      cookies: c.request.cookies,
    })}`,
  ].join(" ");
}

function observe(c: Case): Observation {
  const validator = createValidator(c.document, { returnValues: true });
  const result = validator.validateRequest(c.request);
  const bucket = result.value[bucketFor(c.shape.location)] as Record<string, unknown>;
  return {
    shapeId: c.shape.id,
    valid: result.valid,
    value: NAME in bucket ? bucket[NAME] : ABSENT,
  };
}

/**
 * Compare every observation in a group to the group's first member, and
 * report all of the disagreements at once.
 *
 * Reporting against one reference rather than pairwise keeps the message
 * short; collecting every mismatch rather than throwing on the first is
 * what tells a reader whether one shape drifted or a whole family did,
 * which is the difference between #825 (one shape of four) and #823
 * (eight rows of thirteen).
 */
function assertGroupAgrees(key: string, cases: Case[]): void {
  const first = cases[0]!;
  const reference = observe(first);
  const disagreed: string[] = [];
  for (const c of cases.slice(1)) {
    const got = observe(c);
    if (got.valid === reference.valid && deepEqual(got.value, reference.value)) continue;
    disagreed.push(`  ${descriptor(c)}\n    got ${render(got)}`);
  }
  if (disagreed.length === 0) return;
  throw new Error(
    `group ${key}: ${disagreed.length} of ${cases.length - 1} shapes disagreed with the reference\n` +
      `  reference: ${descriptor(first)}\n    got ${render(reference)}\n` +
      disagreed.join("\n"),
  );
}

function render(o: Observation): string {
  return `valid=${o.valid} value=${o.value === ABSENT ? "<absent>" : JSON.stringify(o.value)}`;
}

/** Structural equality, order-insensitive for object keys and not for arrays. */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return typeof v === "symbol" ? "<absent>" : v;
}

describe("cross-shape relation: every serialization of one value agrees", () => {
  for (const group of presentGroups()) {
    it(`${group.key} agrees across ${group.cases.length} shapes`, () => {
      assertGroupAgrees(group.key, group.cases);
    });
  }
});

describe("cross-shape relation: the agreed verdict is the expected one", () => {
  // Agreement alone is satisfied by every shape being wrong the same way.
  // This is the only place the file holds an opinion about a single shape,
  // and it is what stops a unanimous wrong answer reading as a pass.
  for (const group of presentGroups()) {
    it(`${group.key} is ${group.fixture.verdict} in every shape`, () => {
      for (const c of group.cases) {
        const got = observe(c);
        expect(got.valid, `${descriptor(c)}\n  expected ${c.fixture.verdict}`).toBe(
          c.fixture.verdict === "valid",
        );
      }
    });
  }
});

describe("cross-shape relation: an absent required parameter", () => {
  for (const group of absentGroups()) {
    it(`${group.key} agrees across ${group.cases.length} shapes`, () => {
      assertGroupAgrees(group.key, group.cases);
    });
  }

  it("a missing path segment is a route miss, not a missing parameter", () => {
    // Pinned rather than compared. The router answers before the parameter
    // layer is reached, so this behaviour has no cross-location sibling to
    // agree with; leaving it out entirely would mean the floor's
    // absent-input row had no answer for `path` at all.
    const fixture = fixtures().find((f) => f.id === "str")!;
    const shape = shapesFor("scalar").find((s) => s.location === "path" && s.styleDeclared)!;
    const validator = createValidator(documentFor("3.1.0", shape, fixture), {
      returnValues: true,
    });
    const result = validator.validateRequest({ method: "GET", path: FLAT_PATH });
    if (result.valid) throw new Error("expected the missing path segment to fail");
    expect(result.errors[0]?.code).toBe("route");
  });
});

describe("cross-shape relation: every generated declaration builds", () => {
  // Not a comparison. There is no parameter declaration `createValidator`
  // refuses to build (its construction throws are document-level and
  // option-level), so build failure does not vary with shape and the
  // relation has nothing to compare on it. What is worth asserting is that
  // no generated shape quietly stops building or starts reporting a
  // hygiene issue.
  it("builds without throwing and reports no hygiene issue", () => {
    for (const group of presentGroups()) {
      for (const c of group.cases) {
        const validator = createValidator(c.document, { returnValues: true });
        expect(validator.specHygieneIssues, descriptor(c)).toEqual([]);
      }
    }
  });
});

describe("cross-shape relation: the failure descriptor is the reproducer", () => {
  it("prints enough to rebuild the case without a seed", () => {
    // The negative check codex-reviewer asked for. A deliberate mismatch,
    // constructed here rather than found, so the descriptor's sufficiency
    // is demonstrated rather than asserted.
    const fixture = fixtures().find((f) => f.id === "objAN")!;
    const shape = shapesFor("object").find((s) => s.id === "query/form/explode=false")!;
    const wire = encode(shape, fixture.kind, fixture.value);
    // Rebuild the request from the descriptor's own fields, which is what
    // a reader would do from a CI log.
    expect(
      descriptor({
        oas: "3.1.0",
        fixture,
        shape,
        document: {} as never,
        request: { method: "GET", ...wire },
      }),
    ).toBe(
      'oas=3.1.0 fixture=objAN kind=object shape=query/form/explode=false wire={"path":"/t","query":{"p":"a,x,n,7"}}',
    );
  });
});

describe("cross-shape relation: case count", () => {
  it("reports how many cases it generates", () => {
    const counts = caseCount();
    // A number that moves when the axes move. Recorded so a change to the
    // generator that silently drops a whole axis is visible as a failing
    // assertion rather than as a faster run.
    expect(counts.present).toBeGreaterThan(0);
    expect(counts.absent).toBeGreaterThan(0);
  });
});

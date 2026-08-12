/**
 * Representative JSON Schemas used by the performance benchmarks.
 *
 * Each entry declares:
 *  - a schema (2020-12),
 *  - a set of valid inputs,
 *  - a set of invalid inputs,
 * so validation benchmarks exercise both the pass and fail paths, and
 * don't just measure a hot no-op loop.
 */

import type { SchemaOrBoolean } from "../packages/core/src/index.ts";

export interface PerfSchema {
  name: string;
  description: string;
  schema: SchemaOrBoolean;
  validInputs: unknown[];
  invalidInputs: unknown[];
}

// 1. Tiny schema — floor-case for overhead measurement.
const tiny: PerfSchema = {
  name: "tiny",
  description: "single type + minimum; baseline per-call overhead",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "integer",
    minimum: 0,
  },
  validInputs: [0, 1, 42, 1000],
  invalidInputs: [-1, 3.14, "nope", null],
};

// 2. Petstore-ish object — the most common real shape.
const petstore: PerfSchema = {
  name: "petstore",
  description: "object with required + scalar properties; realistic small API payload",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "integer", minimum: 1 },
      name: { type: "string", minLength: 1, maxLength: 200 },
      tag: { type: "string" },
      status: { type: "string", enum: ["available", "pending", "sold"] },
      price: { type: "number", minimum: 0 },
    },
    additionalProperties: false,
  },
  validInputs: [
    { id: 1, name: "Fido" },
    { id: 2, name: "Whiskers", tag: "cat", status: "available", price: 12.5 },
  ],
  // Failure positions span early (required) → mid (a prop constraint) →
  // deep (a nested numeric bound) → late (additionalProperties, only
  // after every declared property is checked) → many (several at once).
  invalidInputs: [
    { name: "Missing id" }, // early: required `id`
    { id: 1, name: "" }, // mid: name minLength
    { id: 1, name: "Fido", price: -1 }, // deep: a property's numeric minimum
    { id: 1, name: "Fido", extra: true }, // late: additionalProperties
    { id: 0, name: "", status: "nope", price: -5, extra: 1 }, // many: five errors at once
  ],
};

// 3. Nested + $ref — recursive tree; exercises the ref cache.
const tree: PerfSchema = {
  name: "tree",
  description: "recursive tree via $ref; exercises the compiled-fn cache",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: {
      Node: {
        type: "object",
        required: ["value"],
        properties: {
          value: { type: "number" },
          label: { type: "string" },
          children: { type: "array", items: { $ref: "#/$defs/Node" } },
        },
      },
    },
    $ref: "#/$defs/Node",
  },
  validInputs: [
    { value: 1 },
    {
      value: 1,
      label: "root",
      children: [
        { value: 2, children: [{ value: 4 }, { value: 5 }] },
        { value: 3, label: "x" },
      ],
    },
  ],
  // Failure depth spread: root-required → shallow type → one level deep
  // → three levels into the recursion (stresses the recursive call path
  // before failing).
  invalidInputs: [
    { label: "missing value" }, // early: required `value` at the root
    { value: "not a number" }, // shallow: root value type
    { value: 1, children: [{ value: "bad" }] }, // one level deep
    {
      value: 1,
      children: [{ value: 2, children: [{ value: 3, children: [{ value: "deep" }] }] }],
    }, // deep: failure three levels into the recursion
  ],
};

// 4. Composition (oneOf + allOf) — the expensive path.
const composition: PerfSchema = {
  name: "composition",
  description: "oneOf + allOf + nested properties; stresses applicator dispatch",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: {
      Cat: {
        type: "object",
        required: ["kind", "purr"],
        properties: { kind: { const: "Cat" }, purr: { type: "boolean" } },
      },
      Dog: {
        type: "object",
        required: ["kind", "bark"],
        properties: { kind: { const: "Dog" }, bark: { type: "string" } },
      },
      Fish: {
        type: "object",
        required: ["kind", "fins"],
        properties: { kind: { const: "Fish" }, fins: { type: "integer", minimum: 0 } },
      },
    },
    allOf: [{ type: "object", required: ["kind"] }],
    oneOf: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }, { $ref: "#/$defs/Fish" }],
  },
  validInputs: [
    { kind: "Cat", purr: true },
    { kind: "Dog", bark: "woof" },
    { kind: "Fish", fins: 2 },
  ],
  // Spread across the oneOf dispatch: missing discriminator (fails the
  // allOf earliest) → no branch matches → matched branch missing a
  // required field → matched branch wrong type → matched branch deep
  // numeric bound.
  invalidInputs: [
    {}, // earliest: allOf required `kind` missing
    { kind: "Lizard" }, // no oneOf branch's const matches
    { kind: "Cat" }, // matches Cat const, missing required `purr`
    { kind: "Dog", bark: 42 }, // matches Dog const, wrong type for `bark`
    { kind: "Fish", fins: -1 }, // matches Fish const, fails `fins` minimum
  ],
};

// 6. Unique-primitives — pure `uniqueItems` pressure on a large array.
// Picks up any regression to the primitive-fast-path fix; a naïve
// O(N^2) implementation would show a sharp compile/validate split.
const uniquePrimitives: PerfSchema = {
  name: "unique-primitives",
  description: "array of 500 unique strings with uniqueItems; O(N) primitive fast path",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "array",
    uniqueItems: true,
    items: { type: "string" },
  },
  validInputs: [makeUniqueStrings(500)],
  // Vary where the duplicate sits so the scan detects it early, mid, or
  // only after a full pass.
  invalidInputs: [
    makeDuplicateStrings(500, 1), // early: duplicate near the start
    makeDuplicateStrings(500, 250), // middle
    makeDuplicateStrings(500, 499), // late: duplicate at the end (full scan)
  ],
};

function makeUniqueStrings(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) out.push(`item-${i}`);
  return out;
}

function makeDuplicateStrings(n: number, dupAt: number): string[] {
  const out = makeUniqueStrings(n);
  // Collide out[dupAt] with out[0] so the second occurrence (the
  // earliest point a scan can detect the duplicate) sits at `dupAt`.
  out[dupAt] = out[0]!;
  return out;
}

// 5. Array-heavy — exercises the hot per-item validation loop.
const arrayHeavy: PerfSchema = {
  name: "array-heavy",
  description: "array of 100 objects; amortised throughput on collections",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "array",
    items: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer", minimum: 1 },
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
  validInputs: [makeValidArray(100)],
  // First-element vs last-element failure separates fast-fail (exits at
  // the first bad item) from the cost of walking to a late failure;
  // every-element-fails stresses full-collect (100 errors gathered).
  invalidInputs: [
    makeInvalidArrayAt(100, 0), // early: first element fails
    makeInvalidArrayAt(100, 99), // late: last element fails
    makeAllInvalidArray(100), // many: every element fails
  ],
};

// 7. Large strings with length bounds — exercises minLength / maxLength
// code-point counting. Real API payloads carry big text fields
// (descriptions, content, base64 blobs) under generous maxLength caps.
// The valid body sits well under its cap, so a length-bounded check can
// decide the outcome from `.length` without walking; the invalid body
// overshoots its cap by >2x, the other short-circuitable case.
const longString: PerfSchema = {
  name: "long-string",
  description: "object with large minLength/maxLength-bounded string fields",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["body"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      body: { type: "string", minLength: 1, maxLength: 1_000_000 },
    },
  },
  validInputs: [{ title: "Hello", body: makeAscii(100_000) }],
  // Separates a cheap early failure (empty title, body never inspected)
  // from the expensive one (title fine, so the big maxLength count on a
  // 2.5M-char body has to run) and the both-fail case.
  invalidInputs: [
    { title: "", body: makeAscii(100_000) }, // cheap/early: title minLength fails first
    { title: "ok", body: makeAscii(2_500_000) }, // expensive: body overshoots maxLength
    { title: "", body: makeAscii(2_500_000) }, // both fail
  ],
};

// 8. Pattern-heavy — the only shape that measures regex cost.
//
// Every other shape here bounds strings with minLength/maxLength, so
// `pattern` was absent from the whole suite and a change in regex
// handling could not move any number in it. Patterns are taken from the
// published-spec corpus rather than invented, so the cost profile is the
// one real documents pay.
const patternHeavy: PerfSchema = {
  name: "pattern-heavy",
  description: "object whose string fields are constrained by `pattern` rather than by length",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["id", "host", "slug"],
    properties: {
      id: {
        type: "string",
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      },
      host: {
        type: "string",
        pattern: "^((xn--)?[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*\\.)+[a-zA-Z]{2,}\\.?$",
      },
      contact: { type: "string", pattern: "^(.+)@(.+)$" },
      slug: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    },
  },
  validInputs: [
    {
      id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      host: "api.example.com",
      contact: "someone@example.com",
      slug: "widgets",
    },
  ],
  // Separates a cheap early failure (malformed id, later patterns never
  // reached) from the case where every pattern has to run.
  invalidInputs: [
    {
      id: "not-a-uuid",
      host: "api.example.com",
      contact: "someone@example.com",
      slug: "widgets",
    },
    {
      id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      host: "api.example.com",
      contact: "someone@example.com",
      slug: "Not A Slug",
    },
  ],
};

// 9. Pattern-backtracking — the pathological regex case, kept apart.
//
// `[a-z]+$` is single-anchored, and a backtracking engine handles it in
// quadratic time: a non-matching tail forces a retry from every start
// index. Measured on the corpus at 2.58ms for a 2k-char non-match against
// 101ms at 16k, while the anchored patterns in `pattern-heavy` stay flat.
//
// Its own shape rather than a fixture inside `pattern-heavy`, because
// `render.ts` averages the mean latency of every invalid fixture in a
// shape: at ~1.7ms against ~100ns it would swamp that average and the
// published row would report V8 backtracking under the name of pattern
// cost. Both libraries hand this regex to the same engine, so the ratio
// here is parity by construction; the absolute number is the signal.
const patternBacktracking: PerfSchema = {
  name: "pattern-backtracking",
  description: "single-anchored `pattern` that backtracks quadratically on a non-match",
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["slug"],
    properties: {
      slug: { type: "string", pattern: "[a-z]+$" },
    },
  },
  validInputs: [{ slug: makeAscii(2_000) }],
  // Bounded at 2k chars: enough to show the quadratic term, small enough
  // that one run stays in the low milliseconds.
  invalidInputs: [{ slug: `${makeAscii(2_000)}!` }],
};

function makeAscii(n: number): string {
  return "a".repeat(n);
}

function makeValidArray(n: number): Array<Record<string, unknown>> {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ id: i + 1, name: `item-${i}`, tags: ["a", "b", "c"] });
  }
  return out;
}

function makeInvalidArrayAt(n: number, idx: number): Array<Record<string, unknown>> {
  const out = makeValidArray(n);
  (out[idx] as Record<string, unknown>).id = -1;
  return out;
}

function makeAllInvalidArray(n: number): Array<Record<string, unknown>> {
  const out = makeValidArray(n);
  for (const item of out) (item as Record<string, unknown>).id = -1;
  return out;
}

export const perfSchemas: PerfSchema[] = [
  tiny,
  petstore,
  tree,
  composition,
  arrayHeavy,
  uniquePrimitives,
  longString,
  patternHeavy,
  patternBacktracking,
];

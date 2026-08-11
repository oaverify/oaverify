import { describe, expect, it } from "vitest";
import type { RejectionReason } from "@oaverify/internal-core";
import type { SourceSpan } from "@oaverify/internal-spec";
import type { CheckFinding } from "../src/finding.js";
import { renderSarif } from "../src/sarif.js";
import { locatedReasonsFor, reasonTargetFor, spanRequestsFor } from "../src/span-target.js";

/**
 * One located item per sub-rejection of an invalid example (#773).
 *
 * The rules under test are the three that decide whether an item exists
 * at all, and they are asserted here rather than reasoned about because
 * every one of them is a silent failure: an item that should not be
 * there duplicates the primary location, and one that should be there
 * and is not looks identical to a document that had nothing to say.
 *
 * The end-to-end half, where spans come from real files and a region
 * has to name the text the author wrote, is
 * `packages/cli/test/check-reason-spans.test.ts`. This file pins the
 * policy; that one pins that the policy meets a real parser.
 */

const BASE = "/repo";
const EXAMPLE = "/paths/~1orders/get/responses/200/content/application~1json/examples/one/value";

interface SarifLoc {
  id?: number;
  physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } };
  message?: { text: string };
  properties?: Record<string, unknown>;
}
interface SarifLog {
  runs: { results: { locations: SarifLoc[]; relatedLocations?: SarifLoc[] }[] }[];
}

function reason(
  code: string,
  path: readonly (string | number)[],
  message = "must be number",
): RejectionReason {
  return { code, path, message, params: {} };
}

/** An `example-invalid` finding, with whatever reasons a case needs. */
function finding(
  reasons: readonly RejectionReason[],
  over: Partial<CheckFinding> = {},
): CheckFinding {
  return {
    code: "example-invalid",
    class: "examples",
    severity: "error",
    message: "example does not match its schema",
    location: "GET /orders",
    reasons,
    target: {
      pointer: EXAMPLE,
      anchor: "node",
      source: { uri: "spec.json", pointer: EXAMPLE, via: [] },
      ...over.target,
    },
    ...over,
  };
}

const SPAN: SourceSpan = {
  start: { line: 12, column: 3, offset: 100 },
  end: { line: 12, column: 9, offset: 106 },
};

/**
 * A lookup that answers for every pointer, and records what it was
 * asked. Recording is the point in the escaping cases, where the
 * question is what pointer was built rather than what came back.
 */
function everySpan(): { spanOf: (of: { pointer: string }) => SourceSpan; asked: string[] } {
  const asked: string[] = [];
  return {
    spanOf: (of) => {
      asked.push(of.pointer);
      return SPAN;
    },
    asked,
  };
}

/** A lookup that answers only for the pointers it was given. */
const spanAt =
  (...pointers: string[]) =>
  (of: { pointer: string }): SourceSpan | undefined =>
    pointers.includes(of.pointer) ? SPAN : undefined;

const render = (findings: CheckFinding[], spanOf?: Parameters<typeof renderSarif>[1]["spanOf"]) =>
  JSON.parse(
    renderSarif(findings, { base: BASE, classes: ["examples"], ...(spanOf && { spanOf }) }),
  ) as SarifLog;

const relatedOf = (log: SarifLog) => log.runs[0]?.results[0]?.relatedLocations ?? [];
const reasonsOf = (log: SarifLog) =>
  relatedOf(log).filter((l) => l.properties?.["oaverify:kind"] === "reason");

describe("which sub-rejections get a located item", () => {
  it("locates a one-segment object path at the leaf (row 2)", () => {
    const { spanOf, asked } = everySpan();
    const items = reasonsOf(render([finding([reason("type", ["uri"])])], spanOf));
    expect(items).toHaveLength(1);
    expect(items[0]?.properties?.["oaverify:at"]).toBe("self");
    expect(asked).toContain(`${EXAMPLE}/uri`);
  });

  it("locates an array index in the path at the leaf (row 3)", () => {
    const { spanOf, asked } = everySpan();
    const items = reasonsOf(
      render([finding([reason("type", ["usage_records", 0, "price"])])], spanOf),
    );
    expect(items).toHaveLength(1);
    expect(asked).toContain(`${EXAMPLE}/usage_records/0/price`);
    expect(items[0]?.message?.text).toBe("usage_records.0.price: must be number");
  });

  it("emits nothing for a reason that addresses the example as a whole (row 1)", () => {
    // The primary location already addresses it, and the finding's own
    // message already says it. A related location here is the result
    // repeated back.
    const log = render([finding([reason("type", [])])], everySpan().spanOf);
    expect(reasonsOf(log)).toHaveLength(0);
    expect(log.runs[0]?.results[0]?.relatedLocations).toBeUndefined();
  });

  it("emits one for a single-reason finding whose path is not empty (row 5)", () => {
    // The majority case, and the rule is about the path rather than the
    // count: one reason at a sub-position says more than the primary
    // location does, so it earns an item.
    expect(
      reasonsOf(render([finding([reason("format", ["uri"])])], everySpan().spanOf)),
    ).toHaveLength(1);
  });

  it("emits nothing when the finding has no source address (row 7)", () => {
    const bare = finding([reason("type", ["uri"])]);
    const log = render(
      [{ ...bare, target: { pointer: EXAMPLE, anchor: "node" } }],
      everySpan().spanOf,
    );
    expect(reasonsOf(log)).toHaveLength(0);
    expect(log.runs[0]?.results[0]?.locations).toEqual([]);
  });

  it("emits nothing when no span lookup was supplied (row 8)", () => {
    // An unwired caller gets what it got before this existed. A
    // file-level related location would say only "somewhere in the file
    // the result already names", which is the line-1 region argument in
    // another form.
    expect(reasonsOf(render([finding([reason("type", ["uri"])])]))).toHaveLength(0);
  });

  it("emits nothing for a reason whose position the file does not contain", () => {
    // The residual case: a path that is not `required` and still does
    // not resolve. Dropped rather than walked up from, so a located item
    // never claims a position that was not asked for.
    expect(
      reasonsOf(render([finding([reason("type", ["absent"])])], spanAt("nothing/matches"))),
    ).toHaveLength(0);
  });

  it("emits nothing for a class that carries no reasons (rows 11 and 12)", () => {
    const uncheckable: CheckFinding = { ...finding([]), code: "example-uncheckable" };
    const hygiene: CheckFinding = {
      code: "unused-component",
      class: "hygiene",
      severity: "warning",
      message: "component is not referenced",
      location: "components.schemas.Order",
      target: { pointer: "/components/schemas/Order", anchor: "node" },
    };
    expect(reasonsOf(render([uncheckable], everySpan().spanOf))).toHaveLength(0);
    expect(reasonsOf(render([hygiene], everySpan().spanOf))).toHaveLength(0);
  });
});

describe("a reason whose path names a member the value does not hold", () => {
  it("locates `required` at the containing value, not at the missing member (row 4)", () => {
    const items = reasonsOf(
      render(
        [
          finding([
            reason(
              "required",
              [0, "repository", "blobs_url"],
              'must have required property "blobs_url"',
            ),
          ]),
        ],
        spanAt(`${EXAMPLE}/0/repository`),
      ),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.properties?.["oaverify:at"]).toBe("container");
    // The path stays whole, missing member included, so a consumer
    // reading the item alone still knows what is absent.
    expect(items[0]?.properties?.["oaverify:reasonPath"]).toEqual([0, "repository", "blobs_url"]);
    expect(items[0]?.message?.text).toBe(
      '0.repository: must have required property "blobs_url" (this location is the containing value; the member it names is absent)',
    );
  });

  it("never asks for the missing member's own position", () => {
    const { spanOf, asked } = everySpan();
    render([finding([reason("required", ["repository", "blobs_url"])])], spanOf);
    expect(asked).toContain(`${EXAMPLE}/repository`);
    expect(asked).not.toContain(`${EXAMPLE}/repository/blobs_url`);
  });

  it("emits nothing when the container is the example itself", () => {
    // A one-segment `required` path: the value missing the member *is*
    // the rejected value, so this lands on the primary location and is
    // dropped for the same reason an empty path is. 184 of the 290
    // located candidates in `github.json` are this shape.
    expect(
      reasonsOf(render([finding([reason("required", ["blobs_url"])])], everySpan().spanOf)),
    ).toHaveLength(0);
  });

  it("keeps an unknown code at its own path", () => {
    // A code from a later version, or a custom keyword. Located where it
    // says it is, and dropped rather than guessed at if that is nowhere.
    expect(reasonTargetFor("some-future-keyword")).toBe("self");
    expect(reasonTargetFor("required")).toBe("container");
    expect(reasonTargetFor("dependentRequired")).toBe("container");
    expect(reasonTargetFor("type")).toBe("self");
  });
});

describe("the two kinds of related location stay apart (row 9)", () => {
  const withVia = finding([reason("type", ["uri"]), reason("required", ["a", "b"])], {
    target: {
      pointer: EXAMPLE,
      anchor: "definition",
      source: {
        uri: "shared.json",
        pointer: EXAMPLE,
        via: [{ uri: "entry.json", pointer: "/paths/~1orders/get/$ref" }],
      },
    },
  });

  it("marks each item with what it is, and keeps via first", () => {
    const related = relatedOf(render([withVia], everySpan().spanOf));
    expect(related.map((l) => l.properties?.["oaverify:kind"])).toEqual([
      "via",
      "reason",
      "reason",
    ]);
  });

  it("leaves the via message byte-identical", () => {
    // What a hop means is unchanged by this, and a reader with tooling
    // keyed to the sentence keeps it.
    const [hop] = relatedOf(render([withVia], everySpan().spanOf));
    expect(hop?.message?.text).toBe(
      "reference 1 of 1 the resolver followed to reach this document: /paths/~1orders/get/$ref",
    );
  });

  it("gives every item a unique id across both kinds", () => {
    const related = relatedOf(render([withVia], everySpan().spanOf));
    expect(related.map((l) => l.id)).toEqual([1, 2, 3]);
  });

  it("joins an item back to its reason by index, not by position", () => {
    // The two diverge as soon as one reason is not located, which is the
    // whole reason the index is carried rather than inferred.
    const mixed = finding([reason("type", []), reason("type", ["uri"])]);
    const items = reasonsOf(render([mixed], everySpan().spanOf));
    expect(items).toHaveLength(1);
    expect(items[0]?.properties?.["oaverify:reasonIndex"]).toBe(1);
  });
});

describe("scale and escaping", () => {
  it("locates all 46 of a 46-reason finding (row 6)", () => {
    // Uncapped, like `reasons` itself. A cap here would be a second
    // truncation in a change whose purpose is removing one.
    const many = Array.from({ length: 46 }, (_, i) => reason("type", ["items", i, "price"]));
    expect(reasonsOf(render([finding(many)], everySpan().spanOf))).toHaveLength(46);
  });

  it("escapes a property name containing / or ~ (row 13)", () => {
    const { spanOf, asked } = everySpan();
    render([finding([reason("type", ["a/b", "c~d"])])], spanOf);
    expect(asked).toContain(`${EXAMPLE}/a~1b/c~0d`);
  });

  it("takes the container from the segments, before any escaping (row 13)", () => {
    // A `/` in the final segment would split a pointer-joined path into
    // two and drop the wrong one.
    const { spanOf, asked } = everySpan();
    render([finding([reason("required", ["a/b", "c/d"])])], spanOf);
    expect(asked).toContain(`${EXAMPLE}/a~1b`);
  });
});

describe("spanRequestsFor asks for exactly what will be read back", () => {
  it("emits one request per located reason, and no fallback pair", () => {
    const requests = spanRequestsFor([
      finding([reason("type", ["uri"]), reason("required", ["a", "b"]), reason("type", [])]),
    ]);
    const pointers = requests.map((r) => r.pointer);
    expect(pointers).toContain(`${EXAMPLE}/uri`);
    expect(pointers).toContain(`${EXAMPLE}/a`);
    expect(pointers).not.toContain(`${EXAMPLE}/a/b`);
    // The finding's own address, plus the two reason positions. Nothing
    // speculative: `spanFor`'s key/value pair is for codes that
    // recommend a key, and `example-invalid` does not.
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.want === "value")).toBe(true);
  });

  it("hands locatedReasonsFor a self-contained address", () => {
    // An LSP mapping is out of scope to build and in scope to keep
    // possible: everything a `relatedInformation` entry needs is on the
    // entry, without re-deriving it from the finding.
    const [located] = locatedReasonsFor(
      finding([reason("type", ["uri"])]),
      everySpan().spanOf as never,
    );
    expect(located).toMatchObject({
      index: 0,
      at: "self",
      uri: "spec.json",
      pointer: `${EXAMPLE}/uri`,
      span: SPAN,
    });
  });
});

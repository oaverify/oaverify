/**
 * The JSON report is the finding contract, serialized (#775).
 *
 * `check` renders the same findings three ways, and nothing asserted
 * that the three stayed level. #773 is how that failed: the messages
 * were shortened, SARIF and the text report each grew a place for the
 * explanations that left them, and the JSON report went a commit with
 * no such place. It was caught by reading two reports side by side,
 * which is not a process.
 *
 * The assertion that closes it is `findings` deep-equalling what
 * `checkSpec` returned. That is stronger than listing the fields and
 * checking each one appears: a list covers the fields someone thought
 * to write down, for the cases someone thought to construct, while this
 * covers every field of every finding for whatever spec is put through
 * it. A renderer that drops, renames, reorders or truncates anything
 * fails here without this file needing to know what was added.
 *
 * The goldens pin what the report looks like. This pins that it is
 * complete, which is the direction that had no guard.
 */
import { describe, expect, it } from "vitest";
import { checkSpec } from "@oaverify/check";
import { createMemoryReader, loadSpec } from "@oaverify/internal-spec";
import { checkCommand } from "../src/commands.js";
import { memoryIo } from "./fixtures.js";
import { kitchenSink } from "../../check/test/fixtures.ts";

/** The JSON report for a set of in-memory documents. */
async function reportFor(entries: Array<[string, unknown]>): Promise<Record<string, unknown>> {
  const { io, stdout } = memoryIo(entries);
  await checkCommand(
    {
      spec: "entry.json",
      overlays: [],
      failOn: "none",
      format: "json",
      version: "0.0.0-test",
      cwd: "/repo",
      options: { out: undefined } as never,
    } as never,
    io,
  );
  return JSON.parse(stdout.value) as Record<string, unknown>;
}

/**
 * What `checkSpec` itself produces for the same documents, loaded the
 * way the command loads them.
 *
 * `provenance: true` because the command loads that way, and without it
 * every `target.source` would be absent from both sides and the
 * comparison would agree by having nothing to compare.
 */
async function findingsFor(entries: Array<[string, unknown]>): Promise<unknown> {
  const reader = createMemoryReader(new Map(entries));
  const resolved = await loadSpec({ reader, entry: "entry.json", provenance: true });
  // `checkSpec` returns the findings array itself.
  return JSON.parse(JSON.stringify(checkSpec(resolved)));
}

const clean: Array<[string, unknown]> = [
  ["entry.json", { openapi: "3.1.0", info: { title: "clean", version: "1" }, paths: {} }],
];

describe("the JSON report is the findings, whole", () => {
  it("serializes every finding checkSpec produced, field for field", async () => {
    // The load-bearing assertion. Deep equality against the library's
    // own output means a field added to `CheckFinding` is covered the
    // day it is added, with no edit here.
    const [report, findings] = await Promise.all([
      reportFor(kitchenSink()),
      findingsFor(kitchenSink()),
    ]);
    expect(report["findings"]).toEqual(findings);
  });

  it("covers enough for that comparison not to be vacuous", async () => {
    // Deep equality of two empty arrays proves nothing, so pin that the
    // fixture reaches some breadth. If this fails, the comparison above
    // may have stopped being a test without anyone noticing.
    const report = await reportFor(kitchenSink());
    const findings = report["findings"] as { class: string; target?: unknown }[];
    expect(findings.length).toBeGreaterThan(5);
    expect(new Set(findings.map((f) => f.class)).size).toBeGreaterThan(2);
    expect(findings.some((f) => f.target !== undefined)).toBe(true);
  });
});

describe("the report's own envelope", () => {
  it("always carries findings, so a consumer can index it without a guard", async () => {
    expect((await reportFor(clean))["findings"]).toEqual([]);
  });

  it("omits the optional blocks rather than padding them", async () => {
    // A clean run is `{"findings": []}`, not a shape carrying empty
    // containers a consumer has to tell apart from absence.
    expect(Object.keys(await reportFor(clean))).toEqual(["findings"]);
  });

  it("names the rule behind every code it reports", async () => {
    // The #773 regression this file exists to prevent, stated directly:
    // a code in the report with no entry in `rules` is a code a
    // consumer cannot look up.
    const report = await reportFor(kitchenSink());
    const codes = new Set((report["findings"] as { code: string }[]).map((f) => f.code));
    const rules = report["rules"] as Record<string, { title: string }>;
    expect(Object.keys(rules).sort()).toEqual([...codes].sort());
    for (const [code, rule] of Object.entries(rules)) {
      expect(rule.title, `${code} has no title`).toBeTruthy();
    }
  });
});

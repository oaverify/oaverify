/**
 * The #634 acceptance cases, as one rule module run through `check`.
 *
 * Five house rules reported by shape (two set operations over the
 * document, one business rule needing external data, two regexes) plus
 * the reporter's own sixth, which needs compiler knowledge. The point
 * of pinning them here is that the design is judged against these and
 * not against shapes invented to fit it, so the module in
 * `fixtures/acme-house-rules.mjs` is written the way a consumer would
 * write it: plain JS over the resolved document, importing nothing from
 * oaverify.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkCommand } from "../src/commands.js";
import type { CheckFinding } from "@oaverify/check";
import { memoryIo } from "./fixtures.js";

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const RULES = join(FIXTURES, "acme-house-rules.mjs");

/** `platform` is a registered owner; `billing` is not. */
const spec = {
  openapi: "3.1.0",
  info: { title: "acme-pets", version: "1.0.0" },
  tags: [{ name: "pets" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        "x-owner": "platform",
        tags: ["pets"],
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: "create_pet",
        tags: ["Pets"],
        responses: { "201": { description: "made" } },
      },
    },
    "/pet_food/{petId}": {
      get: {
        operationId: "getFood",
        "x-owner": "billing",
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        properties: { email: { type: "string", format: "acme-email" } },
      },
    },
  },
};

async function check(extra: Record<string, unknown> = {}) {
  const mem = memoryIo([["spec.json", spec]]);
  const res = await checkCommand(
    {
      spec: "spec.json",
      overlays: [],
      format: "json",
      only: ["custom"],
      rules: [RULES],
      cwd: FIXTURES,
      options: { quiet: false },
      ...extra,
    },
    mem.io,
  );
  const findings: CheckFinding[] = JSON.parse(mem.stdout.value).findings;
  return { res, findings, stderr: mem.stderr.value };
}

function byCode(findings: readonly CheckFinding[], code: string): CheckFinding[] {
  return findings.filter((f) => f.code === `x-acme/${code}`);
}

describe("the #634 acceptance cases, end to end", () => {
  it("case 1: a set operation over the document", async () => {
    const { findings } = await check();
    const hits = byCode(findings, "operation-needs-owner");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.message).toBe("operation create_pet declares no x-owner");
    expect(hits[0]?.target?.pointer).toBe("/paths/~1pets/post");
    expect(hits[0]?.severity).toBe("error");
  });

  it("case 2: a second set operation, tags declared at the document level", async () => {
    const { findings } = await check();
    const hits = byCode(findings, "tag-undeclared");
    expect(hits.map((f) => f.target?.pointer)).toEqual(["/paths/~1pets/post/tags/0"]);
    expect(hits[0]?.message).toBe('tag "Pets" is not declared');
  });

  // The rule reads a file. In the reporter's case it is an HTTP call to
  // a service registry; either way it is ordinary JS, which is the
  // reason a declarative rule format could not have covered this case.
  it("case 3: a business rule reaching external data", async () => {
    const { findings } = await check();
    const hits = byCode(findings, "registry-owner-unknown");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.message).toBe("owners not in the service registry: billing");
    // No node is responsible for it, so it addresses nothing and says so.
    expect(hits[0]?.location).toBe("<document>");
    expect(hits[0]).not.toHaveProperty("target");
  });

  it("case 4: a regex over a field", async () => {
    const { findings } = await check();
    const hits = byCode(findings, "operation-id-camel");
    expect(hits.map((f) => f.target?.pointer)).toEqual(["/paths/~1pets/post/operationId"]);
  });

  it("case 5: a second regex, over path segments", async () => {
    const { findings } = await check();
    const hits = byCode(findings, "path-kebab");
    expect(hits.map((f) => f.target?.pointer)).toEqual(["/paths/~1pet_food~1{petId}"]);
  });

  // The one case that needs to know what the compiler validates, and
  // the one #645 has since shipped as a built-in. Both fire on the same
  // node here, which is the evidence for the built-in / custom line: a
  // rule reaching for compiler knowledge is a rule that wants to be a
  // built-in.
  it("case 6: a rule needing compiler knowledge, beside the built-in that replaced it", async () => {
    const { findings } = await check();
    expect(byCode(findings, "format-must-validate")[0]?.target?.pointer).toBe(
      "/components/schemas/Pet/properties/email/format",
    );

    const withBuiltIn = await check({ only: ["custom", "schema"] });
    const builtIn = withBuiltIn.findings.filter((f) => f.code === "format-not-validated");
    expect(builtIn).toHaveLength(1);
    expect(builtIn[0]?.target?.pointer).toBe("/components/schemas/Pet/properties/email/format");
  });
});

describe("the acceptance grid: every cell has an answer", () => {
  it("every finding is addressed, graded, classed and sourced", async () => {
    const { findings } = await check();
    expect(findings).toHaveLength(6);
    for (const finding of findings) {
      expect(finding.class).toBe("custom");
      expect(["warning", "error", "fatal"]).toContain(finding.severity);
      expect(finding.location).not.toBe("");
      // Every pointer-bearing finding carries a source address, derived
      // by the framework from the pointer the rule supplied.
      if (finding.target !== undefined) {
        expect(finding.target.anchor).toBe("node");
        expect(finding.target.source?.uri).toBe("spec.json");
      }
    }
  });

  it("--only selects the class, and excludes it", async () => {
    expect((await check({ only: ["custom"] })).findings).toHaveLength(6);
    expect((await check({ only: ["hygiene"] })).findings.some((f) => f.class === "custom")).toBe(
      false,
    );
  });

  it("--severity regrades by code, family and class", async () => {
    const { findings } = await check({
      severity: ["x-acme/*=warning,x-acme/operation-needs-owner=fatal"],
    });
    expect(byCode(findings, "operation-needs-owner")[0]?.severity).toBe("fatal");
    expect(byCode(findings, "tag-undeclared")[0]?.severity).toBe("warning");
  });

  it("--fail-on gates on a custom finding, and exit 4 stays the compiler's", async () => {
    // The registry rule is `fatal`, so the strictest gate fires...
    expect((await check({ failOn: "fatal" })).res.exitCode).toBe(1);
    // ...and it is still exit 1, because nothing failed to compile.
    expect((await check({ failOn: "error" })).res.exitCode).toBe(1);
    expect((await check()).res.exitCode).toBe(0);
  });

  it("renders every custom code into SARIF as its own rule", async () => {
    const mem = memoryIo([["spec.json", spec]]);
    await checkCommand(
      {
        spec: "spec.json",
        overlays: [],
        format: "sarif",
        only: ["custom"],
        rules: [RULES],
        cwd: FIXTURES,
        options: { quiet: false },
      },
      mem.io,
    );
    const run = JSON.parse(mem.stdout.value).runs[0];
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id).sort()).toEqual([
      "x-acme/format-must-validate",
      "x-acme/operation-id-camel",
      "x-acme/operation-needs-owner",
      "x-acme/path-kebab",
      "x-acme/registry-owner-unknown",
      "x-acme/tag-undeclared",
    ]);
    // The pointerless one gets no location rather than an invented one.
    const whole = run.results.find(
      (r: { ruleId: string }) => r.ruleId === "x-acme/registry-owner-unknown",
    );
    expect(whole.locations).toEqual([]);
    expect(whole.properties["oaverify:severity"]).toBe("fatal");
  });
});

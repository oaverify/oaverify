import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import {
  isCustomSeverityKey,
  loadRules,
  runRules,
  RuleContractError,
  RuleLoadError,
  type DocumentRule,
} from "../src/custom-rules.js";

const document = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  paths: {
    "/pets": {
      get: { operationId: "listPets", responses: { "200": { description: "ok" } } },
    },
  },
} as unknown as OpenAPIDocument;

const ctx = { document, knownFormats: new Set(["uuid"]) };

/** Write a rule module into a fresh temp dir and return its directory. */
function moduleDir(source: string, name = "rules.mjs"): string {
  const dir = mkdtempSync(join(tmpdir(), "oav-rules-"));
  writeFileSync(join(dir, name), source);
  return dir;
}

function rule(over: Partial<DocumentRule> = {}): DocumentRule {
  return { code: "x-acme/thing", run: () => [], ...over };
}

describe("loadRules", () => {
  it("loads a named rules export", async () => {
    const dir = moduleDir(
      `export const rules = [{ code: "x-acme/owner", severity: "error", run: () => [] }];`,
    );
    const loaded = await loadRules(["./rules.mjs"], dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.code).toBe("x-acme/owner");
    expect(loaded[0]?.severity).toBe("error");
  });

  it("loads a default export", async () => {
    const dir = moduleDir(`export default [{ code: "x-acme/owner", run: () => [] }];`);
    expect(await loadRules(["./rules.mjs"], dir)).toHaveLength(1);
  });

  it("accepts an absolute specifier", async () => {
    const dir = moduleDir(`export const rules = [{ code: "x-acme/owner", run: () => [] }];`);
    expect(await loadRules([join(dir, "rules.mjs")], "/nowhere")).toHaveLength(1);
  });

  it("loads several modules in order", async () => {
    const dir = moduleDir(`export const rules = [{ code: "x-acme/one", run: () => [] }];`, "a.mjs");
    writeFileSync(
      join(dir, "b.mjs"),
      `export const rules = [{ code: "x-acme/two", run: () => [] }];`,
    );
    const loaded = await loadRules(["./a.mjs", "./b.mjs"], dir);
    expect(loaded.map((r) => r.code)).toEqual(["x-acme/one", "x-acme/two"]);
  });

  it("names the module when it cannot be imported", async () => {
    await expect(loadRules(["./missing.mjs"], "/nowhere")).rejects.toThrow(RuleLoadError);
    await expect(loadRules(["./missing.mjs"], "/nowhere")).rejects.toThrow(/missing\.mjs/);
  });

  it("refuses a module exporting nothing usable", async () => {
    const dir = moduleDir(`export const notRules = [];`);
    await expect(loadRules(["./rules.mjs"], dir)).rejects.toThrow(/neither "rules" nor a default/);
  });

  it("refuses a non-array export", async () => {
    const dir = moduleDir(`export const rules = { code: "x-acme/owner" };`);
    await expect(loadRules(["./rules.mjs"], dir)).rejects.toThrow(/exports an object/);
  });

  it("refuses a rule with no run function", async () => {
    const dir = moduleDir(`export const rules = [{ code: "x-acme/owner" }];`);
    await expect(loadRules(["./rules.mjs"], dir)).rejects.toThrow(/no "run" function/);
  });

  it("refuses a bad severity", async () => {
    const dir = moduleDir(
      `export const rules = [{ code: "x-acme/o", severity: "info", run: () => [] }];`,
    );
    await expect(loadRules(["./rules.mjs"], dir)).rejects.toThrow(/expected warning, error, fatal/);
  });

  // The reserved prefix is what keeps the built-in code space closed.
  it.each([
    ["acme/owner", "no x- prefix"],
    ["x-acme", "no family separator"],
    ["x-Acme/Owner", "uppercase"],
    ["unused-component", "a built-in code"],
    ["x-acme/owner name", "a space"],
    ["x-acme/*", "a star"],
  ])("refuses the code %j (%s)", async (code) => {
    const dir = moduleDir(
      `export const rules = [{ code: ${JSON.stringify(code)}, run: () => [] }];`,
    );
    await expect(loadRules(["./rules.mjs"], dir)).rejects.toThrow(RuleLoadError);
  });

  // `export const rules = undefined` is a broken named export, not an
  // absent one, so it is diagnosed rather than falling through.
  it("diagnoses a named export that is undefined instead of using the default", async () => {
    const dir = moduleDir(
      `export const rules = undefined;\nexport default [{ code: "x-acme/o", run: () => [] }];`,
    );
    await expect(loadRules(["./rules.mjs"], dir)).rejects.toThrow(/exports "rules" as undefined/);
  });

  it("prefers the named export when both are present", async () => {
    const dir = moduleDir(
      `export const rules = [{ code: "x-acme/named", run: () => [] }];\n` +
        `export default [{ code: "x-acme/defaulted", run: () => [] }];`,
    );
    const loaded = await loadRules(["./rules.mjs"], dir);
    expect(loaded.map((r) => r.code)).toEqual(["x-acme/named"]);
  });

  it("keeps the reason when a module throws a non-Error on import", async () => {
    const dir = moduleDir(`throw "module boom";`);
    await expect(loadRules(["./rules.mjs"], dir)).rejects.toThrow(/module boom/);
  });

  it("refuses two modules claiming one code", async () => {
    const dir = moduleDir(`export const rules = [{ code: "x-acme/one", run: () => [] }];`, "a.mjs");
    writeFileSync(
      join(dir, "b.mjs"),
      `export const rules = [{ code: "x-acme/one", run: () => [] }];`,
    );
    await expect(loadRules(["./a.mjs", "./b.mjs"], dir)).rejects.toThrow(
      /declared by both \.\/a\.mjs and \.\/b\.mjs/,
    );
  });
});

describe("runRules", () => {
  it("grades a finding from the rule, then the finding, then the default", async () => {
    const findings = await runRules(
      [
        rule({ code: "x-acme/default-graded", run: () => [{ message: "a" }] }),
        rule({ code: "x-acme/rule-graded", severity: "error", run: () => [{ message: "b" }] }),
        rule({
          code: "x-acme/finding-graded",
          severity: "error",
          run: () => [{ message: "c", severity: "fatal" }],
        }),
      ],
      ctx,
    );
    expect(findings.map((f) => f.severity)).toEqual(["warning", "error", "fatal"]);
  });

  it("keeps a pointer that resolves", async () => {
    const [finding] = await runRules(
      [rule({ run: () => [{ pointer: "/paths/~1pets/get", message: "m" }] })],
      ctx,
    );
    expect(finding?.pointer).toBe("/paths/~1pets/get");
  });

  it("keeps the empty pointer, which addresses the document root", async () => {
    const [finding] = await runRules([rule({ run: () => [{ pointer: "", message: "m" }] })], ctx);
    expect(finding?.pointer).toBe("");
  });

  it("leaves pointer absent when the rule reported no position", async () => {
    const [finding] = await runRules([rule({ run: () => [{ message: "m" }] })], ctx);
    expect(finding).not.toHaveProperty("pointer");
  });

  // The whole reason `target` exists: a pointer that resolves nowhere is
  // worse than no pointer, so it stops the run instead of being reported.
  it("refuses a pointer that does not resolve, naming the rule", async () => {
    await expect(
      runRules([rule({ run: () => [{ pointer: "/paths/~1nope/get", message: "m" }] })], ctx),
    ).rejects.toThrow(/rule x-acme\/thing produced a finding at "\/paths\/~1nope\/get"/);
  });

  it("refuses a syntactically invalid pointer", async () => {
    await expect(
      runRules([rule({ run: () => [{ pointer: "paths", message: "m" }] })], ctx),
    ).rejects.toThrow(RuleContractError);
  });

  it("accepts an async rule and a generator", async () => {
    const findings = await runRules(
      [
        rule({ code: "x-acme/async", run: () => Promise.resolve([{ message: "a" }]) }),
        rule({
          code: "x-acme/gen",
          run: function* () {
            yield { message: "b" };
          },
        }),
      ],
      ctx,
    );
    expect(findings.map((f) => f.message)).toEqual(["a", "b"]);
  });

  it("passes compiler knowledge through the context", async () => {
    const [finding] = await runRules(
      [rule({ run: (c) => [{ message: [...c.knownFormats].join(",") }] })],
      ctx,
    );
    expect(finding?.message).toBe("uuid");
  });

  it("reports a throwing rule against the rule, not the document", async () => {
    await expect(
      runRules(
        [
          rule({
            run: () => {
              throw new Error("boom");
            },
          }),
        ],
        ctx,
      ),
    ).rejects.toThrow(/rule x-acme\/thing threw: boom/);
  });

  // `throw "boom"` is legal JS. Reading `.message` off it would report
  // the failure as `undefined`, hiding the thing the error exists to say.
  it.each([
    ["a string", `"boom"`, /threw: boom/],
    ["a number", "42", /threw: 42/],
    ["an object with no message", "{ code: 7 }", /threw: \[object Object\]/],
  ])("keeps the reason when a rule throws %s", async (_label, thrown, expected) => {
    const dir = moduleDir(
      `export const rules = [{ code: "x-acme/thrower", run() { throw ${thrown}; } }];`,
    );
    const [loaded] = await loadRules(["./rules.mjs"], dir);
    await expect(runRules([loaded!], ctx)).rejects.toThrow(expected);
  });

  it("survives a thrown value whose toString throws", async () => {
    const evil = {
      toString: () => {
        throw new Error("nope");
      },
    };
    await expect(
      runRules(
        [
          rule({
            run: () => {
              throw evil;
            },
          }),
        ],
        ctx,
      ),
    ).rejects.toThrow(/threw: an object/);
  });

  it("refuses a rule that returns nothing iterable", async () => {
    await expect(
      runRules([rule({ run: () => undefined as unknown as RuleFinding[] })], ctx),
    ).rejects.toThrow(/expected an iterable of findings/);
  });

  it("refuses a finding with no message", async () => {
    await expect(runRules([rule({ run: () => [{ message: "" }] })], ctx)).rejects.toThrow(
      /no "message" string/,
    );
  });

  it("runs rules in the order they were loaded", async () => {
    const order: string[] = [];
    await runRules(
      [
        rule({
          code: "x-acme/first",
          run: async () => {
            await new Promise((r) => setTimeout(r, 5));
            order.push("first");
            return [];
          },
        }),
        rule({
          code: "x-acme/second",
          run: () => {
            order.push("second");
            return [];
          },
        }),
      ],
      ctx,
    );
    expect(order).toEqual(["first", "second"]);
  });
});

describe("isCustomSeverityKey", () => {
  it("splits the two namespaces so only x- keys defer past the loader", () => {
    expect(isCustomSeverityKey("x-acme/owner")).toBe(true);
    expect(isCustomSeverityKey("x-acme/*")).toBe(true);
    expect(isCustomSeverityKey("unsatisfiable/pattern-length")).toBe(false);
    expect(isCustomSeverityKey("hygiene")).toBe(false);
  });
});

type RuleFinding = { message: string };

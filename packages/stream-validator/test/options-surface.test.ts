import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { createStreamValidator, type StreamValidatorOptions } from "../src/index.js";

const enc = new TextEncoder();

describe("numeric options are validated at construction (parity with @oaverify/internal-schema)", () => {
  const schema = { type: "string" } as SchemaOrBoolean;
  for (const name of ["maxErrors", "maxDepth", "maxBufferedBytes", "maxTotalBytes"] as const) {
    for (const bad of [0, -1, 1.5]) {
      it(`rejects ${name}: ${bad}`, () => {
        expect(() => createStreamValidator(schema, { [name]: bad })).toThrow(
          /must be a positive integer/,
        );
      });
    }
    it(`accepts ${name}: Infinity (uncapped)`, () => {
      expect(() =>
        createStreamValidator(schema, { [name]: Number.POSITIVE_INFINITY }),
      ).not.toThrow();
    });
  }
});

describe("warn surfaces classifier warnings (matches @oaverify/internal-validator)", () => {
  it("calls warn for an unbounded pattern string", () => {
    const messages: string[] = [];
    // A single options type (StreamValidatorOptions) carries dialect /
    // openApiVersion / warn, matching @oaverify/internal-validator's ValidatorOptions.
    const opts: StreamValidatorOptions = { warn: (m) => messages.push(m) };
    createStreamValidator({ type: "string", pattern: "^a+$" } as SchemaOrBoolean, opts);
    expect(messages.some((m) => /maxLength|unbounded/.test(m))).toBe(true);
  });

  it("does not call warn for a bounded schema", () => {
    let warned = false;
    createStreamValidator({ type: "string", pattern: "^a$", maxLength: 8 } as SchemaOrBoolean, {
      warn: () => (warned = true),
    });
    expect(warned).toBe(false);
  });

  it("openApiVersion + warn coexist on the one options type", async () => {
    const validator = createStreamValidator({ type: "string", nullable: true } as SchemaOrBoolean, {
      openApiVersion: "3.0",
      policy: "detach",
      maxErrors: Number.POSITIVE_INFINITY,
    });
    validator.on("error", () => {});
    validator.resume();
    const result = validator.result;
    validator.end(Buffer.from(enc.encode("null")));
    await expect(result).resolves.toMatchObject({ valid: true }); // nullable widened
  });
});

// Run one document, collecting the verdict under detach policy (no throw).
async function validate(schema: SchemaOrBoolean, body: string) {
  const validator = createStreamValidator(schema, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
  });
  validator.on("error", () => {});
  validator.resume();
  const result = validator.result;
  validator.end(Buffer.from(enc.encode(body)));
  return result;
}

describe("SchemaViolation field shape", () => {
  it("STREAM-path leaf violation carries code/path/byteOffset, no message", async () => {
    const verdict = await validate({ type: "integer", minimum: 5 } as SchemaOrBoolean, "3");
    expect(verdict.valid).toBe(false);
    const [v] = verdict.violations;
    expect(v?.code).toBe("minimum");
    expect(typeof v?.byteOffset).toBe("number");
    expect(v?.message).toBeUndefined();
  });

  it("BUFFER-island violation preserves the in-memory engine's message/params", async () => {
    const verdict = await validate(
      { type: "array", uniqueItems: true } as SchemaOrBoolean,
      "[1,1]",
    );
    expect(verdict.valid).toBe(false);
    const [v] = verdict.violations;
    expect(v?.code).toBe("uniqueItems");
    expect(v?.message).toBe("must have unique items");
    expect(v?.params).toBeDefined();
    expect(typeof v?.byteOffset).toBe("number");
    expect(Array.isArray(v?.children)).toBe(true);
  });
});

// formats / keywords are threaded into the BUFFER-island delegate's
// compileSchema (the only place they take effect: the forward STREAM path
// does not assert format and does not know custom keywords).
describe("formats and keywords reach the delegate", () => {
  it("a custom format runs on a forced-buffer scalar under an asserting dialect", async () => {
    const schema = { type: "string", format: "even-len" } as SchemaOrBoolean;
    const formats = { "even-len": (s: string) => s.length % 2 === 0 };
    const run = (body: string) => {
      const v = createStreamValidator(schema, {
        openApiVersion: "3.1",
        formats,
        policy: "detach",
        maxErrors: Number.POSITIVE_INFINITY,
      });
      v.on("error", () => {});
      v.resume();
      const result = v.result;
      v.end(Buffer.from(enc.encode(body)));
      return result;
    };
    await expect(run('"abcd"')).resolves.toMatchObject({ valid: true });
    const bad = await run('"abc"');
    expect(bad.valid).toBe(false);
    expect(bad.violations[0]?.code).toBe("format");
  });

  it("a custom keyword runs through the delegate, carrying its message/params", async () => {
    const schema = { type: "integer", isEven: true } as unknown as SchemaOrBoolean;
    const keywords = {
      isEven: (data: unknown) =>
        typeof data === "number" && data % 2 === 0
          ? true
          : { message: "must be even", params: { parity: "odd" } },
    };
    const run = (body: string) => {
      const v = createStreamValidator(schema, {
        keywords,
        policy: "detach",
        maxErrors: Number.POSITIVE_INFINITY,
      });
      v.on("error", () => {});
      v.resume();
      const result = v.result;
      v.end(Buffer.from(enc.encode(body)));
      return result;
    };
    await expect(run("4")).resolves.toMatchObject({ valid: true });
    const bad = await run("3");
    expect(bad.valid).toBe(false);
    expect(bad.violations[0]?.code).toBe("isEven");
    expect(bad.violations[0]?.message).toBe("must be even");
    expect(bad.violations[0]?.params).toEqual({ parity: "odd" });
  });
});

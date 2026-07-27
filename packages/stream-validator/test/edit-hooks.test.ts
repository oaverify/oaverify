import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import {
  createStreamValidator,
  type ScopeContext,
  type StreamValidator,
  ValidationFailedError,
} from "../src/index.js";

const enc = new TextEncoder();

interface RunResult {
  output: string;
  err: Error | undefined;
  valid: boolean | undefined;
}

async function run(
  schema: SchemaOrBoolean,
  json: string,
  setup: (v: StreamValidator) => void,
  opts: Record<string, unknown> = {},
  chunkSize = 0,
): Promise<RunResult> {
  const v = createStreamValidator(schema, opts as never);
  setup(v);
  v.on("error", () => {});
  const out: Buffer[] = [];
  const sink = new Writable({
    write(c: Buffer, _e, cb) {
      out.push(Buffer.from(c));
      cb();
    },
  });
  const bytes = enc.encode(json);
  const chunks =
    chunkSize > 0
      ? Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, i) =>
          Buffer.from(bytes.subarray(i * chunkSize, (i + 1) * chunkSize)),
        )
      : [Buffer.from(bytes)];
  let err: Error | undefined;
  try {
    await pipeline(Readable.from(chunks), v, sink);
  } catch (e) {
    err = e as Error;
  }
  const verdict = await v.result.then(
    (r) => r.valid,
    () => undefined,
  );
  return { output: Buffer.concat(out).toString("utf8"), err, valid: verdict };
}

describe("editClose appends bytes before a scope's delimiter", () => {
  it("appends a field to the root object (leading comma when non-empty)", async () => {
    const r = await run({ type: "object" }, '{"a":1}', (v) =>
      v.editClose([], (ctx) => ctx.field("added", true)),
    );
    expect(r.output).toBe('{"a":1,"added":true}');
    expect(r.valid).toBe(true);
  });

  it("omits the leading comma for an empty object", async () => {
    const r = await run({ type: "object" }, "{}", (v) =>
      v.editClose([], (ctx) => ctx.field("x", 1)),
    );
    expect(r.output).toBe('{"x":1}');
  });

  it("appends to a nested scope selected by path", async () => {
    const r = await run({ type: "object" }, '{"outer":{"a":1}}', (v) =>
      v.editClose(["outer"], (ctx) => ctx.field("b", 2)),
    );
    expect(r.output).toBe('{"outer":{"a":1,"b":2}}');
  });

  it("appends an element to an array scope", async () => {
    const r = await run({ type: "array" }, "[1,2]", (v) =>
      v.editClose([], (ctx) => (ctx.memberCount > 0 ? ",3" : "3")),
    );
    expect(r.output).toBe("[1,2,3]");
  });

  it("is byte-exact across chunk boundaries", async () => {
    const r = await run(
      { type: "object" },
      '{"a":1,"b":2}',
      (v) => v.editClose([], (ctx) => ctx.field("c", 3)),
      {},
      3,
    );
    expect(r.output).toBe('{"a":1,"b":2,"c":3}');
  });

  it("does not validate appended bytes (may break the very schema)", async () => {
    // additionalProperties:false would reject `extra`, but appends are
    // never validated; the input was valid, so the verdict stays valid.
    const r = await run(
      { type: "object", additionalProperties: false, properties: { a: {} } },
      '{"a":1}',
      (v) => v.editClose([], (ctx) => ctx.field("extra", 1)),
    );
    expect(r.output).toBe('{"a":1,"extra":1}');
    expect(r.valid).toBe(true);
  });
});

describe("onScopeClose observes scopes (cross-scope state)", () => {
  it("reads a child's member count in the parent's edit hook", async () => {
    let childCount = 0;
    const r = await run({ type: "object" }, '{"items":[1,2,3]}', (v) => {
      v.onScopeClose(["items"], (ctx) => {
        childCount = ctx.memberCount;
      });
      v.editClose([], (ctx) => ctx.field("count", childCount));
    });
    // The child array closes before the root, so count is set first.
    expect(r.output).toBe('{"items":[1,2,3],"count":3}');
  });
});

describe("edit hooks and terminal policy", () => {
  it("under terminate, a root hook does not fire on the invalid path", async () => {
    let fired = false;
    const r = await run(
      { type: "object", properties: { a: { type: "integer" } } },
      '{"a":"x"}',
      (v) =>
        v.editClose([], (ctx) => {
          fired = true;
          return ctx.field("z", 1);
        }),
    );
    expect(r.err).toBeInstanceOf(ValidationFailedError);
    expect(fired).toBe(false);
    expect(r.output).not.toContain('"z"');
  });

  it("under detach, a hook sees verdict invalid", async () => {
    let seen: ScopeContext["verdict"] | undefined;
    const r = await run(
      { type: "object", properties: { a: { type: "integer" } } },
      '{"a":"x"}',
      (v) =>
        v.onScopeClose([], (ctx) => {
          seen = ctx.verdict;
        }),
      { policy: "detach", maxErrors: Number.POSITIVE_INFINITY },
    );
    expect(seen).toBe("invalid");
    expect(r.output).toBe('{"a":"x"}'); // detach echoes everything
  });
});

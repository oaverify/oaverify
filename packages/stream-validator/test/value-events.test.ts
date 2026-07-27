import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { PathSegment, SchemaOrBoolean } from "@oaverify/internal-core";
import {
  createStreamValidator,
  type StreamValidatorOptions,
  type ValueEvent,
} from "../src/index.js";

const enc = new TextEncoder();

// Feed `json` (optionally pre-split into chunks) through a validator with
// the given value-event options and collect the `value` events. Returns
// the events plus the raw input bytes, so a test can slice spans.
async function collectValues(
  schema: SchemaOrBoolean,
  json: string | string[],
  valueEvents: StreamValidatorOptions["valueEvents"],
  extra: StreamValidatorOptions = {},
): Promise<{ events: ValueEvent[]; input: Buffer }> {
  const chunks = (Array.isArray(json) ? json : [json]).map((c) => Buffer.from(enc.encode(c)));
  const input = Buffer.concat(chunks);
  const validator = createStreamValidator(schema, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
    valueEvents,
    ...extra,
  });
  const events: ValueEvent[] = [];
  validator.on("value", (e: ValueEvent) => events.push(e));
  validator.on("error", () => {});
  await pipeline(Readable.from(chunks), validator, new Writable({ write: (_c, _e, cb) => cb() }));
  return { events, input };
}

// The bytes a `value` event points at, as JSON.parse sees them.
function sliceParse(input: Buffer, e: ValueEvent): unknown {
  return JSON.parse(input.subarray(e.valueStart, e.valueEnd).toString("utf8"));
}

const objectSchema: SchemaOrBoolean = { type: "object" };

describe("value events", () => {
  it("reports a span for each scalar member, across every JSON scalar type", async () => {
    const json = '{"s":"abc","n":42,"f":1.5,"b":true,"z":null}';
    const { events, input } = await collectValues(objectSchema, json, true);
    expect(events.map((e) => [e.key, e.type])).toEqual([
      ["s", "string"],
      ["n", "number"],
      ["f", "number"],
      ["b", "boolean"],
      ["z", "null"],
    ]);
    // Each span slices to valid JSON whose value matches the source.
    expect(events.map((e) => sliceParse(input, e))).toEqual(["abc", 42, 1.5, true, null]);
  });

  it("spans a string from its opening quote to just past its closing quote", async () => {
    const { events, input } = await collectValues(objectSchema, '{"id":"abc"}', true);
    const [e] = events;
    expect(input.subarray(e.valueStart, e.valueEnd).toString()).toBe('"abc"');
    expect(sliceParse(input, e)).toBe("abc");
  });

  it("carries the value's full path and the member key", async () => {
    const { events } = await collectValues(objectSchema, '{"meta":{"id":"x"}}', true);
    // `path` is the full path to the value (scope plus key); `key` is its
    // last segment, the same coordinate the filter matches.
    expect(events.map((e) => [e.path, e.key])).toEqual([[["meta", "id"], "id"]]);
  });

  it("filters by the member's full path, which the event also reports", async () => {
    const json = '{"a":1,"meta":{"id":"x","ver":2}}';
    const { events } = await collectValues(objectSchema, json, { at: ["meta", "id"] });
    expect(events.map((e) => [e.path, e.key])).toEqual([[["meta", "id"], "id"]]);
  });

  it("filters by a predicate over the full path", async () => {
    const json = '{"id":1,"meta":{"id":2}}';
    const { events } = await collectValues(objectSchema, json, {
      at: (path: PathSegment[]) => path[path.length - 1] === "id",
    });
    expect(events.map((e) => e.path)).toEqual([["id"], ["meta", "id"]]);
  });

  it("a top-level scalar member has a length-1 path (filter and event agree)", async () => {
    const json = '{"version":"1.0","other":2}';
    const { events } = await collectValues(objectSchema, json, { at: ["version"] });
    // The trap: filtering on `[]` (the enclosing scope) captures nothing;
    // the value's path is `["version"]`, which is also what the filter matches.
    expect(events.map((e) => [e.path, e.key])).toEqual([[["version"], "version"]]);
  });

  it("emits nothing when off (the default)", async () => {
    const { events } = await collectValues(objectSchema, '{"a":1}', undefined);
    expect(events).toEqual([]);
    const off = await collectValues(objectSchema, '{"a":1}', false);
    expect(off.events).toEqual([]);
  });

  describe("scope: scalar object members (STREAM and buffer-delegated)", () => {
    it("skips array elements (and the array-valued member, a container)", async () => {
      const { events } = await collectValues({ type: "object" }, '{"xs":[1,2,3]}', true);
      // `xs` is a container, not a scalar; its elements are array elements.
      expect(events).toEqual([]);
    });

    it("reports scalar siblings of an array member, but not the array's elements", async () => {
      const { events } = await collectValues({ type: "object" }, '{"xs":[1,2],"k":9}', true);
      expect(events.map((e) => [e.key, e.type])).toEqual([["k", "number"]]);
    });

    it("skips the root scalar", async () => {
      const { events } = await collectValues(true, '"just a string"', true);
      expect(events).toEqual([]);
    });

    it("skips a member routed to a TEE composition branch", async () => {
      const schema: SchemaOrBoolean = {
        type: "object",
        properties: { x: { oneOf: [{ type: "string" }, { type: "number" }] } },
      };
      const { events } = await collectValues(schema, '{"x":"hi"}', true);
      expect(events).toEqual([]);
    });

    it("still reports a STREAM scalar that buffers for a forward keyword (pattern)", async () => {
      const schema: SchemaOrBoolean = {
        type: "object",
        properties: { code: { type: "string", pattern: "^[a-z]+$" } },
      };
      const { events, input } = await collectValues(schema, '{"code":"abc"}', true);
      expect(events.map((e) => e.key)).toEqual(["code"]);
      expect(sliceParse(input, events[0])).toBe("abc");
    });

    it("reports a format-bearing string island under an asserting dialect", async () => {
      // The headline case: `date-time` routes to a BUFFER island under an
      // OpenAPI dialect, but its value is materialized for the format
      // check, so the channel still fires (no schema fork needed).
      const schema: SchemaOrBoolean = {
        type: "object",
        properties: { ts: { type: "string", format: "date-time" } },
      };
      const { events, input } = await collectValues(
        schema,
        '{"ts":"2026-06-19T00:00:00Z"}',
        { at: ["ts"], capture: true },
        { openApiVersion: "3.1" },
      );
      expect(events.map((e) => [e.key, e.type, e.value])).toEqual([
        ["ts", "string", "2026-06-19T00:00:00Z"],
      ]);
      expect(sliceParse(input, events[0])).toBe("2026-06-19T00:00:00Z");
    });

    it("reports a format-string island in span-only mode (no capture)", async () => {
      const schema: SchemaOrBoolean = {
        type: "object",
        properties: { ts: { type: "string", format: "date-time" } },
      };
      const { events, input } = await collectValues(schema, '{"ts":"2026-06-19T00:00:00Z"}', true, {
        openApiVersion: "3.1",
      });
      expect(events.map((e) => [e.key, e.type, e.value])).toEqual([["ts", "string", undefined]]);
      expect(sliceParse(input, events[0])).toBe("2026-06-19T00:00:00Z");
    });

    it("does not fire for a scalar string nested inside a container island", async () => {
      // `o` is an object-valued island (enum of objects); the string `s`
      // inside it is part of the buffered subtree, not a top-level member.
      const schema: SchemaOrBoolean = {
        type: "object",
        properties: { o: { enum: [{ s: "x" }] } },
      };
      const { events } = await collectValues(schema, '{"o":{"s":"x"}}', true);
      expect(events).toEqual([]);
    });

    it("reports a format-bearing number island under an asserting dialect", async () => {
      // Numbers already fired for islands (their decode is in hand before
      // delegation); lock it so strings and numbers stay consistent.
      const schema: SchemaOrBoolean = {
        type: "object",
        properties: { n: { type: "number", format: "int64" } },
      };
      const { events } = await collectValues(
        schema,
        '{"n":42}',
        { at: ["n"], capture: true },
        {
          openApiVersion: "3.1",
        },
      );
      expect(events.map((e) => [e.key, e.type, e.value])).toEqual([["n", "number", 42]]);
    });

    it("still skips an object-valued island member (a container, not a scalar)", async () => {
      // `enum` of objects forces a BUFFER island, but the value is a
      // container, so no value event.
      const schema: SchemaOrBoolean = {
        type: "object",
        properties: { o: { enum: [{ a: 1 }] } },
      };
      const { events } = await collectValues(schema, '{"o":{"a":1}}', true);
      expect(events).toEqual([]);
    });

    it("truncates an over-cap format-string island, still reporting the span", async () => {
      const schema: SchemaOrBoolean = {
        type: "object",
        properties: { u: { type: "string", format: "uri" } },
      };
      const { events, input } = await collectValues(
        schema,
        '{"u":"https://example.com/a/very/long/path"}',
        { at: ["u"], capture: true, maxCaptureBytes: 8 },
        { openApiVersion: "3.1" },
      );
      const [e] = events;
      expect(e.truncated).toBe(true);
      expect(e.value).toBeUndefined();
      expect(sliceParse(input, e)).toBe("https://example.com/a/very/long/path");
    });
  });

  describe("capture", () => {
    it("delivers the decoded value when capture is on", async () => {
      const json = '{"s":"a\\nb","n":42,"z":null}';
      const { events } = await collectValues(objectSchema, json, {
        at: () => true,
        capture: true,
      });
      expect(events.map((e) => e.value)).toEqual(["a\nb", 42, null]);
      // A captured null is present (not merely absent).
      const nullEvent = events.find((e) => e.key === "z")!;
      expect("value" in nullEvent).toBe(true);
      expect(nullEvent.value).toBeNull();
      expect(events.every((e) => e.truncated === false)).toBe(true);
    });

    it("delivers falsy captured values (0, false, empty string)", async () => {
      // The driver guards on `value !== undefined`, not falsiness, so a
      // captured 0 / false / "" must ride along, not be dropped.
      const { events } = await collectValues(objectSchema, '{"n":0,"b":false,"s":""}', {
        at: () => true,
        capture: true,
      });
      expect(events.map((e) => [e.key, e.value])).toEqual([
        ["n", 0],
        ["b", false],
        ["s", ""],
      ]);
      expect(events.every((e) => "value" in e)).toBe(true);
    });

    it("omits the value (offsets only) when capture is off", async () => {
      const { events } = await collectValues(objectSchema, '{"s":"abc"}', { at: ["s"] });
      expect(events[0].value).toBeUndefined();
      expect(events[0].truncated).toBe(false);
    });

    it("drops the value and sets truncated past maxCaptureBytes, keeping the span", async () => {
      const { events, input } = await collectValues(objectSchema, '{"s":"abcdefghij"}', {
        at: ["s"],
        capture: true,
        maxCaptureBytes: 4,
      });
      const [e] = events;
      expect(e.truncated).toBe(true);
      expect(e.value).toBeUndefined();
      // The span is still usable: the consumer can slice the raw bytes.
      expect(sliceParse(input, e)).toBe("abcdefghij");
    });

    it("bounds capture for a large value delivered in a single chunk", async () => {
      // A long string arriving in one input buffer reaches the spine as a
      // single onStringChunk. The per-chunk cap must bound retention before
      // the append, not only at string end, so a value far over the cap is
      // truncated (value dropped) without being retained whole.
      const big = "x".repeat(100_000);
      const { events, input } = await collectValues(objectSchema, `{"s":"${big}"}`, {
        at: ["s"],
        capture: true,
        maxCaptureBytes: 16,
      });
      const [e] = events;
      expect(e.truncated).toBe(true);
      expect(e.value).toBeUndefined();
      expect(e.valueEnd - e.valueStart).toBe(big.length + 2); // span covers the quotes
      expect(sliceParse(input, e)).toBe(big);
    });

    it("truncates capture without starving validation when the schema also buffers the text", async () => {
      // `pattern` forces full-text buffering (needText), governed by
      // maxBufferedBytes (here unset); capture truncation is a separate,
      // softer limit. A pattern-violating char beyond the capture cap must
      // still be validated: the value is dropped, but the verdict reflects
      // the whole string.
      const schema: SchemaOrBoolean = {
        type: "object",
        properties: { code: { type: "string", pattern: "^[a-z]+$" } },
      };
      const validator = createStreamValidator(schema, {
        policy: "detach",
        maxErrors: Number.POSITIVE_INFINITY,
        valueEvents: { at: ["code"], capture: true, maxCaptureBytes: 4 },
      });
      const events: ValueEvent[] = [];
      validator.on("value", (e: ValueEvent) => events.push(e));
      validator.on("error", () => {});
      await pipeline(
        Readable.from([Buffer.from(enc.encode('{"code":"abcdefgZ"}'))]),
        validator,
        new Writable({ write: (_c, _e, cb) => cb() }),
      );
      const verdict = await validator.result;
      // The capital Z (past the 4-byte capture cap) still fails the pattern.
      expect(verdict.valid).toBe(false);
      expect(verdict.violations.some((v) => v.code === "pattern")).toBe(true);
      // Capture itself was dropped over the cap; span still reported.
      expect(events[0].truncated).toBe(true);
      expect(events[0].value).toBeUndefined();
    });

    it("accumulates a captured value across chunk boundaries", async () => {
      const { events, input } = await collectValues(objectSchema, ['{"id":"hel', 'lo world"}'], {
        at: ["id"],
        capture: true,
      });
      expect(events[0].value).toBe("hello world");
      expect(sliceParse(input, events[0])).toBe("hello world");
    });

    it("does not fail the stream when a captured value exceeds the cap (soft limit)", async () => {
      // A schema that would reject nothing; the run must still settle valid.
      const validator = createStreamValidator(objectSchema, {
        valueEvents: { at: ["s"], capture: true, maxCaptureBytes: 2 },
      });
      validator.on("value", () => {});
      validator.on("error", () => {});
      await pipeline(
        Readable.from([Buffer.from(enc.encode('{"s":"a very long value"}'))]),
        validator,
        new Writable({ write: (_c, _e, cb) => cb() }),
      );
      const verdict = await validator.result;
      expect(verdict.valid).toBe(true);
    });

    it("rejects a non-positive maxCaptureBytes at construction", () => {
      expect(() =>
        createStreamValidator(objectSchema, { valueEvents: { at: ["s"], maxCaptureBytes: 0 } }),
      ).toThrow(/positive integer/);
    });
  });

  it("uses absolute input offsets that ignore editClose injections", async () => {
    // editClose splices bytes into the OUTPUT; value spans stay in the
    // pre-injection INPUT space, so slicing the input still lines up.
    const json = '{"id":"x","n":7}';
    const validator = createStreamValidator(objectSchema, {
      valueEvents: { at: () => true, capture: true },
    });
    const events: ValueEvent[] = [];
    validator.on("value", (e: ValueEvent) => events.push(e));
    validator.on("error", () => {});
    validator.editClose([], (ctx) => ctx.field("added", true));
    const out: Buffer[] = [];
    await pipeline(
      Readable.from([Buffer.from(enc.encode(json))]),
      validator,
      new Writable({
        write: (c: Buffer, _e, cb) => {
          out.push(c);
          cb();
        },
      }),
    );
    // Output grew (the injection landed), but input-space spans are intact.
    const output = Buffer.concat(out).toString();
    expect(output).toContain('"added":true');
    const input = Buffer.from(enc.encode(json));
    expect(events.map((e) => sliceParse(input, e))).toEqual(["x", 7]);
    expect(events.map((e) => e.value)).toEqual(["x", 7]);
  });

  it("captures a member before the enclosing scope's editClose, so a rename can use it", async () => {
    // The consumer's pattern: capture scalars during member traversal,
    // then emit renamed copies at the enclosing scope's close. The value
    // event must fire before that scope's editClose for the value to be in
    // hand.
    const json = '{"message_id":"m-1","ts":"2026-06-19"}';
    const captured = new Map<string, unknown>();
    const validator = createStreamValidator(objectSchema, {
      valueEvents: { at: (path) => path.length === 1, capture: true },
    });
    validator.on("value", (e: ValueEvent) => captured.set(e.key, e.value));
    validator.on("error", () => {});
    validator.editClose([], (ctx) => ctx.field("id", captured.get("message_id") as string));
    const out: Buffer[] = [];
    await pipeline(
      Readable.from([Buffer.from(enc.encode(json))]),
      validator,
      new Writable({
        write: (c: Buffer, _e, cb) => {
          out.push(c);
          cb();
        },
      }),
    );
    expect(captured.get("message_id")).toBe("m-1");
    // The renamed copy carries the captured value, spliced before `}`.
    expect(Buffer.concat(out).toString()).toBe('{"message_id":"m-1","ts":"2026-06-19","id":"m-1"}');
  });
});

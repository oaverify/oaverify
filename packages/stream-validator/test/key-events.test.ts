import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { PathSegment, SchemaOrBoolean } from "@oaverify/internal-core";
import { createStreamValidator } from "../src/index.js";

const enc = new TextEncoder();

interface KeyEvent {
  path: PathSegment[];
  key: string;
  byteOffset: number;
}

async function collectKeys(
  schema: SchemaOrBoolean,
  json: string,
  keyEvents: boolean | { at: unknown },
): Promise<KeyEvent[]> {
  const validator = createStreamValidator(schema, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
    keyEvents: keyEvents as never,
  });
  const events: KeyEvent[] = [];
  validator.on("key", (e: KeyEvent) => events.push(e));
  validator.on("error", () => {});
  await pipeline(
    Readable.from([Buffer.from(enc.encode(json))]),
    validator,
    new Writable({ write: (_c, _e, cb) => cb() }),
  );
  return events;
}

describe("key events", () => {
  const schema: SchemaOrBoolean = { type: "object" };

  it("emits every key with its scope path and byte offset when enabled", async () => {
    const events = await collectKeys(schema, '{"a":1,"nested":{"b":2}}', true);
    expect(events.map((e) => [e.path, e.key])).toEqual([
      [[], "a"],
      [[], "nested"],
      [["nested"], "b"],
    ]);
    expect(events.every((e) => e.byteOffset >= 0)).toBe(true);
  });

  it("filters by an exact scope path", async () => {
    const events = await collectKeys(schema, '{"a":1,"nested":{"b":2,"c":3}}', { at: ["nested"] });
    expect(events.map((e) => e.key)).toEqual(["b", "c"]);
  });

  it("filters by a predicate over (path, kind)", async () => {
    const events = await collectKeys(schema, '{"a":1,"nested":{"b":2}}', {
      at: (path: PathSegment[]) => path.length === 0,
    });
    expect(events.map((e) => e.key)).toEqual(["a", "nested"]);
  });

  it("emits nothing when disabled (off by default)", async () => {
    expect(await collectKeys(schema, '{"a":1}', false)).toEqual([]);
  });
});

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import {
  analyzeStreamability,
  createStreamValidator,
  JsonParseError,
  KeyLimitError,
  MemberEditError,
  MaxTotalBytesError,
  NumberLimitError,
  type StreamValidator,
  type StreamValidatorOptions,
} from "../src/index.js";
import { JsonTokenizer, type JsonEventHandler } from "../src/tokenizer/index.js";

interface RetainedInput {
  tokenizer: { keyBuf: string; numBuf: string; stack: number[] };
  heldChunks: Buffer[];
  heldLength: number;
  pendingEdits: unknown[];
  spine: { frames: unknown[]; island: unknown; tee: unknown; str: unknown };
}

function retained(stream: StreamValidator): RetainedInput {
  return stream as unknown as RetainedInput;
}

async function write(stream: StreamValidator, input: string | Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    stream.write(input, (error) => (error ? reject(error) : resolve())),
  );
}

async function run(
  input: string | Buffer,
  options: StreamValidatorOptions,
  chunkSize: number,
  schema: SchemaOrBoolean = {},
  configure?: (stream: StreamValidator) => void,
) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const stream = createStreamValidator(schema, options);
  configure?.(stream);
  const output: Buffer[] = [];
  const result = stream.result.catch((error: unknown) => error);
  const chunks = function* () {
    for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
  };
  let failure: unknown;
  try {
    await pipeline(
      Readable.from(chunks()),
      stream,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          output.push(Buffer.from(chunk));
          callback();
        },
      }),
    );
  } catch (error) {
    failure = error;
  }
  return { stream, failure, result: await result, output: Buffer.concat(output).toString() };
}

describe("input token limits", () => {
  for (const option of ["maxKeyBytes", "maxNumberBytes"] as const) {
    it.each([-1, 0.5, NaN, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
      `rejects invalid ${option}: %s`,
      (value) => {
        expect(() => createStreamValidator({}, { [option]: value })).toThrow(
          /non-negative safe integer/,
        );
        expect(() => analyzeStreamability({}, { [option]: value })).toThrow(
          /non-negative safe integer/,
        );
      },
    );
    it.each([0, 1, Number.MAX_SAFE_INTEGER, Infinity])(`accepts ${option}: %s`, (value) => {
      createStreamValidator({}, { [option]: value }).destroy();
      expect(() => analyzeStreamability({}, { [option]: value })).not.toThrow();
    });
  }

  for (const chunkSize of [1, 7, 1000000]) {
    it(`refuses an unfinished key before completion (${chunkSize}-byte chunks)`, async () => {
      const { failure, result } = await run(
        '{"' + "x".repeat(100000),
        { maxKeyBytes: 64 },
        chunkSize,
      );
      expect(failure).toMatchObject({
        name: "KeyLimitError",
        limit: 64,
        keyStart: 1,
        byteOffset: 65,
      });
      expect(result).toBe(failure);
      expect(failure).toBeInstanceOf(KeyLimitError);
    });

    it(`refuses an unfinished number before completion (${chunkSize}-byte chunks)`, async () => {
      const { failure, result } = await run(
        "[1" + "0".repeat(100000),
        { maxNumberBytes: 64 },
        chunkSize,
      );
      expect(failure).toMatchObject({
        name: "NumberLimitError",
        limit: 64,
        numberStart: 1,
        byteOffset: 65,
      });
      expect(result).toBe(failure);
      expect(failure).toBeInstanceOf(NumberLimitError);
    });

    for (const token of ['""', '"cat"', '"💩"', '"\\uD83D\\uDCA9"', '"\\u0063at"', '"\\ud800"']) {
      it(`counts key token bytes for ${token} (${chunkSize})`, async () => {
        const size = Buffer.byteLength(token);
        const input = `{${token}:0}`;
        const accepted = await run(input, { maxKeyBytes: size }, chunkSize);
        expect(accepted.failure).toBeUndefined();
        expect(accepted.result).toMatchObject({ valid: true });
        expect(accepted.output).toBe(input);
        const rejected = await run(input, { maxKeyBytes: size - 1 }, chunkSize);
        expect(rejected.failure).toMatchObject({
          name: "KeyLimitError",
          keyStart: 1,
          byteOffset: size,
        });
      });
    }

    for (const token of ["0", "-0", "123", "1.000", "-1.2e+03", "1e000001"]) {
      for (const input of [token, `[${token}]`, `{"n":${token}}`]) {
        it(`finishes at-cap number ${input} (${chunkSize})`, async () => {
          const accepted = await run(input, { maxNumberBytes: token.length }, chunkSize);
          expect(accepted.failure).toBeUndefined();
          expect(accepted.result).toMatchObject({ valid: true });
          expect(accepted.output).toBe(input);
          const start = input.indexOf(token);
          const rejected = await run(input, { maxNumberBytes: token.length - 1 }, chunkSize);
          expect(rejected.failure).toMatchObject({
            name: "NumberLimitError",
            numberStart: start,
            byteOffset: start + token.length - 1,
          });
        });
      }
    }

    it(`handles zero caps and empty keys (${chunkSize})`, async () => {
      expect(
        (await run("{}", { maxKeyBytes: 0, maxNumberBytes: 0 }, chunkSize)).failure,
      ).toBeUndefined();
      expect((await run('{"":null}', { maxKeyBytes: 0 }, chunkSize)).failure).toMatchObject({
        name: "KeyLimitError",
        byteOffset: 1,
      });
      expect((await run('{"":null}', { maxKeyBytes: 1 }, chunkSize)).failure).toMatchObject({
        name: "KeyLimitError",
        byteOffset: 2,
      });
      expect(
        (await run('{"":null}', { maxKeyBytes: 2, maxNumberBytes: 0 }, chunkSize)).failure,
      ).toBeUndefined();
    });

    it(`preserves syntax failures below caps and at non-number terminators (${chunkSize})`, async () => {
      for (const input of ["1.", "01", "1e", "123x", '{"a\\q":1}', '{"a\n":1}', '{"abc']) {
        const { failure } = await run(input, { maxKeyBytes: 20, maxNumberBytes: 3 }, chunkSize);
        expect(failure).toBeInstanceOf(JsonParseError);
      }
      const atBoundary = await run('{"a\n":1}', { maxKeyBytes: 2 }, chunkSize);
      expect(atBoundary.failure).toBeInstanceOf(KeyLimitError);
    });

    it(`uses the same token policy in composition and buffered subtrees (${chunkSize})`, async () => {
      for (const schema of [
        true,
        { const: {} },
        { anyOf: [{ type: "object" }, false] },
      ] satisfies SchemaOrBoolean[]) {
        const key = await run('{"a":[{"' + "x".repeat(30), { maxKeyBytes: 8 }, chunkSize, schema);
        expect(key.failure).toMatchObject({ name: "KeyLimitError", keyStart: 7, byteOffset: 15 });
        const number = await run('{"a":[1234567890', { maxNumberBytes: 8 }, chunkSize, schema);
        expect(number.failure).toMatchObject({
          name: "NumberLimitError",
          numberStart: 6,
          byteOffset: 14,
        });
      }
    });

    it(`allows uncapped spelling by default and with Infinity (${chunkSize})`, async () => {
      const input = `{${JSON.stringify("x".repeat(100))}:1.${"0".repeat(100)}}`;
      for (const options of [{}, { maxKeyBytes: Infinity, maxNumberBytes: Infinity }]) {
        expect((await run(input, options, chunkSize)).failure).toBeUndefined();
      }
    });

    it(`counts raw UTF-8 bytes in strict and replacement modes (${chunkSize})`, async () => {
      const input = Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d]);
      expect((await run(input, { maxKeyBytes: 3 }, chunkSize)).failure).toBeInstanceOf(
        JsonParseError,
      );
      expect(
        (await run(input, { maxKeyBytes: 3, utf8: "replace" }, chunkSize)).failure,
      ).toBeUndefined();
      expect((await run(input, { maxKeyBytes: 1 }, chunkSize)).failure).toMatchObject({
        name: "KeyLimitError",
        byteOffset: 2,
      });
    });
  }

  for (const policy of ["terminate", "detach"] as const) {
    for (const maxErrors of [1, 2, Infinity]) {
      it(`caps dropped descendants under ${policy}/${maxErrors}`, async () => {
        for (const input of ['{"d":{"toolong":1}}', '{"d":{"n":123456789}}']) {
          const keys: unknown[] = [];
          const hooks: string[] = [];
          const result = await run(
            input,
            { policy, maxErrors, maxKeyBytes: 4, maxNumberBytes: 4, keyEvents: true },
            1,
            {},
            (stream) => {
              stream.on("key", (key: unknown) => keys.push(key));
              stream.editMember(
                (path) => path.length === 1,
                (ctx) => {
                  hooks.push(ctx.key);
                  return { action: "drop" };
                },
              );
            },
          );
          expect(result.failure).toBeInstanceOf(
            input.includes("toolong") ? KeyLimitError : NumberLimitError,
          );
          expect(hooks).toEqual(["d"]);
          expect(keys).toHaveLength(input.includes("toolong") ? 1 : 2);
        }
      });
    }
  }

  it("still caps an unresolved member after detach's error budget is reached", async () => {
    let edited = 0;
    const result = await run(
      '{"bad":123456789}',
      { policy: "detach", maxErrors: 1, maxNumberBytes: 4 },
      1,
      { propertyNames: { maxLength: 1 } },
      (stream) =>
        stream.editMember(
          () => true,
          () => {
            edited++;
            return null;
          },
        ),
    );
    expect(result.failure).toMatchObject({
      name: "NumberLimitError",
      numberStart: 7,
      byteOffset: 11,
    });
    expect(edited).toBe(0);
    expect(result.output).not.toContain("bad");
  });

  it("copies the tail after detach seals, without token policies", async () => {
    const input = '[false,{"longname":123456789}]';
    const result = await run(input, { policy: "detach", maxKeyBytes: 0, maxNumberBytes: 0 }, 1, {
      type: "array",
      items: { type: "number" },
    });
    expect(result.failure).toBeUndefined();
    expect(result.result).toMatchObject({ valid: false });
    expect(result.output).toBe(input);
  });

  it("keeps an eligible member drop refusal ahead of a tied token limit", async () => {
    const result = await run(
      '{"d":{"longname":1}}',
      { maxKeyBytes: 4, maxMemberDropBytes: 9 },
      1,
      {},
      (stream) => {
        stream.editMember(["d"], () => ({ action: "drop" }));
      },
    );
    expect(result.failure).toBeInstanceOf(MemberEditError);
    expect(result.failure).toMatchObject({ byteOffset: 10 });
  });

  it("leaves analyzer estimates and enforceBounds startup unchanged", () => {
    const options = { maxKeyBytes: 64, maxNumberBytes: 64, enforceBounds: true };
    for (const schema of [{ type: "object" }, { const: {} }] satisfies SchemaOrBoolean[]) {
      expect(analyzeStreamability(schema, options)).toEqual(
        analyzeStreamability(schema, { enforceBounds: true }),
      );
      createStreamValidator(schema, options).destroy();
    }
  });

  it.each([1, 8, 100])(
    "refuses a number before a tied drop limit becomes eligible (%s-byte chunks)",
    async (chunkSize) => {
      let decisions = 0;
      const result = await run(
        '{"d":123456}',
        { maxNumberBytes: 3, maxMemberDropBytes: 7 },
        chunkSize,
        {},
        (stream) => {
          stream.editMember(["d"], () => {
            decisions++;
            return { action: "drop" };
          });
        },
      );
      expect(result.failure).toBeInstanceOf(NumberLimitError);
      expect(result.failure).toMatchObject({ byteOffset: 8, numberStart: 5, limit: 3 });
      expect(decisions).toBe(0);
    },
  );

  it("preserves the total-input preflight's precedence over token parsing", async () => {
    const input = '{"' + "x".repeat(100);
    const options = { maxTotalBytes: 32, maxKeyBytes: 8 };
    expect((await run(input, options, 1000)).failure).toBeInstanceOf(MaxTotalBytesError);
    expect((await run(input, options, 1)).failure).toMatchObject({
      name: "KeyLimitError",
      byteOffset: 9,
    });
  });

  it("does not apply input policies to a generated rename or appended member", async () => {
    const name = "x".repeat(100);
    const appended = "1." + "0".repeat(100);
    const result = await run('{"a":1}', { maxKeyBytes: 3, maxNumberBytes: 1 }, 1, {}, (stream) => {
      stream.editMember(["a"], () => ({ action: "rename", key: name }));
      stream.editClose([], () => Buffer.from(',"generated":' + appended));
    });
    expect(result.failure).toBeUndefined();
    expect(result.output).toBe(`{"${name}":1,"generated":${appended}}`);
  });

  it("preserves decoding and code-point counts across internal key batches", async () => {
    const key = "a".repeat(16383) + "💩";
    const input = JSON.stringify({ [key]: 0 });
    const result = await run(input, { maxKeyBytes: Buffer.byteLength(key) + 2 }, 1000000, {
      propertyNames: { minLength: 16384, maxLength: 16384 },
    });
    expect(result.failure).toBeUndefined();
    expect(result.result).toMatchObject({ valid: true });
    expect(result.output).toBe(input);
  });

  it("does not decode the excess part of a giant caller chunk", () => {
    let keys = 0;
    const tokenizer = new JsonTokenizer(
      {
        onStartObject() {},
        onEndObject() {},
        onStartArray() {},
        onEndArray() {},
        onKey() {
          keys++;
        },
        onStringStart() {},
        onStringChunk() {},
        onStringEnd() {},
        onNumber() {},
        onBoolean() {},
        onNull() {},
      },
      { maxKeyBytes: 64, maxNumberBytes: 64 },
    );
    expect(() => tokenizer.write(Buffer.from('{"' + "x".repeat(1000000)))).toThrow(KeyLimitError);
    expect((tokenizer as unknown as { keyBuf: string }).keyBuf).toHaveLength(63);
    expect(keys).toBe(0);
    tokenizer.dispose();
  });

  it.each([
    ["onStartObject", '{"x":0}'],
    ["onStartArray", "[0]"],
    ["onKey", '{"x":0}'],
    ["onStringStart", '["x"]'],
    ["onStringChunk", '["x"]'],
    ["onStringEnd", '["x"]'],
    ["onNumber", "[0]"],
    ["onBoolean", "[true]"],
    ["onNull", "[null]"],
    ["onEndObject", "[{},0]"],
    ["onEndArray", "[[],0]"],
  ] as const)("stops parsing when %s disposes the tokenizer", (event, input) => {
    let disposed = false;
    const eventsAfterDispose: string[] = [];
    const handler = Object.fromEntries(
      [
        "onStartObject",
        "onEndObject",
        "onStartArray",
        "onEndArray",
        "onKey",
        "onStringStart",
        "onStringChunk",
        "onStringEnd",
        "onNumber",
        "onBoolean",
        "onNull",
      ].map((name) => [
        name,
        () => {
          if (disposed) eventsAfterDispose.push(name);
          if (name === event) {
            disposed = true;
            tokenizer.dispose();
          }
        },
      ]),
    ) as unknown as JsonEventHandler;
    const tokenizer = new JsonTokenizer(handler);
    expect(() => tokenizer.write(Buffer.from(input))).not.toThrow();
    expect(disposed).toBe(true);
    expect(eventsAfterDispose).toEqual([]);
    expect((tokenizer as unknown as { stack: number[] }).stack).toEqual([]);
  });

  it.each(["0", "{}", '"text"'])(
    "cleans up after an edit hook destroys the stream (%s)",
    async (value) => {
      let calls = 0;
      let parserResults: { type: string }[] = [];
      const result = await run(`{"a":${value},"b":1}`, {}, 100, {}, (stream) => {
        parserResults = vi.spyOn(
          (stream as unknown as { tokenizer: JsonTokenizer }).tokenizer,
          "write",
        ).mock.results;
        stream.editMember(
          () => true,
          () => {
            calls++;
            stream.destroy();
            return { action: "keep" };
          },
        );
      });
      expect(calls).toBe(1);
      expect(parserResults[0]!.type).toBe("return");
      const state = retained(result.stream);
      expect(state.heldChunks).toEqual([]);
      expect(state.pendingEdits).toEqual([]);
      expect(state.spine.frames).toEqual([]);
      expect(state.tokenizer.stack).toEqual([]);
    },
  );

  it.each([
    { mode: "keep", prefix: [], input: '{"abc', abortAt: 1 },
    { mode: "keep", prefix: [], input: '{"a":1}', abortAt: 1 },
    { mode: "rename", prefix: [], input: '{"a":1}', abortAt: 2 },
    { mode: "keep", prefix: ['{"a', "bc"], input: '":1}', abortAt: 1 },
    { mode: "rename", prefix: ['{"a', "bc"], input: '":1}', abortAt: 1 },
    { mode: "append", prefix: [], input: "{}", abortAt: 2 },
  ])(
    "stops output on consumer abort ($mode, $prefix, $abortAt)",
    async ({ mode, prefix, input, abortAt }) => {
      const stream = createStreamValidator({});
      stream.on("error", () => {});
      if (mode === "append") stream.editClose([], () => Buffer.from('"added":1'));
      else
        stream.editMember(
          () => true,
          () => (mode === "rename" ? { action: "rename", key: "changed" } : null),
        );
      let armed = false;
      let emissions = 0;
      stream.on("data", () => {
        if (armed && ++emissions === abortAt) stream.destroy();
      });
      const closed = new Promise<void>((resolve) => stream.once("close", resolve));
      for (const chunk of prefix) await write(stream, chunk);
      armed = true;
      expect(() => stream.write(input)).not.toThrow();
      await closed;
      await expect(stream.result).rejects.toThrow("destroyed before completion");
      expect(emissions).toBe(abortAt);
      const state = retained(stream);
      expect(state.heldLength).toBe(0);
      expect(state.heldChunks).toEqual([]);
      expect(state.pendingEdits).toEqual([]);
      expect(state.spine.frames).toEqual([]);
    },
  );

  it("compacts a carried edit tail instead of pinning the preceding chunk", async () => {
    const stream = createStreamValidator({}, { maxKeyBytes: 8, maxNumberBytes: 8 });
    stream.resume();
    stream.on("error", () => {});
    stream.editMember(
      () => true,
      () => null,
      { scope: [] },
    );
    await write(stream, '{"done":"' + "x".repeat(100000) + '","k');
    const state = retained(stream);
    expect(state.heldLength).toBe(3);
    expect(state.heldChunks).toHaveLength(1);
    expect(state.heldChunks[0]!.buffer.byteLength).toBe(3);
    await write(stream, '":12');
    expect(state.heldLength).toBe(7);
    expect(state.heldChunks.reduce((sum, chunk) => sum + chunk.buffer.byteLength, 0)).toBe(7);
    stream.end("}");
    await expect(stream.result).resolves.toMatchObject({ valid: true });
  });

  for (const maxKeyBytes of [undefined, 64]) {
    it.each([31, 32, 33])(
      `bounds edit backing storage while retaining %s/64 bytes (key cap ${maxKeyBytes})`,
      async (length) => {
        const stream = createStreamValidator({}, { maxKeyBytes });
        const output: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => output.push(chunk));
        stream.editMember(
          () => true,
          () => null,
        );
        const backing = Buffer.allocUnsafeSlow(64).fill("x");
        backing.write('{"');
        await write(stream, backing.subarray(0, length + 1));
        const state = retained(stream);
        expect(state.heldLength).toBe(length);
        const held = state.heldChunks[0]!;
        expect(held.buffer.byteLength).toBeLessThanOrEqual(2 * length);
        if (length >= 32) expect(held.buffer).toBe(backing.buffer);
        else expect(held.buffer.byteLength).toBe(length);

        await write(stream, '":0,"k');
        expect(state.heldLength).toBe(3);
        expect(state.heldChunks[0]!.buffer.byteLength).toBe(3);
        stream.end('":1}');
        await expect(stream.result).resolves.toMatchObject({ valid: true });
        expect(Buffer.concat(output).toString()).toBe('{"' + "x".repeat(length - 1) + '":0,"k":1}');
      },
    );
  }

  it("releases retained input on fatal refusal while the stream is still referenced", async () => {
    const result = await run(
      '{"d":{"n":123456789}',
      { maxNumberBytes: 4 },
      1,
      { const: {} },
      (stream) => {
        stream.editMember(
          () => true,
          () => null,
        );
      },
    );
    const state = retained(result.stream);
    expect(result.failure).toBeInstanceOf(NumberLimitError);
    expect(state.tokenizer.keyBuf).toBe("");
    expect(state.tokenizer.numBuf).toBe("");
    expect(state.tokenizer.stack).toEqual([]);
    expect(state.heldChunks).toEqual([]);
    expect(state.heldLength).toBe(0);
    expect(state.pendingEdits).toEqual([]);
    expect(state.spine.frames).toEqual([]);
    expect(state.spine.island).toBeNull();
    expect(state.spine.tee).toBeNull();
    expect(state.spine.str).toBeNull();
  });
});

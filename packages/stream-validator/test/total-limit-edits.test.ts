import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  createStreamValidator,
  MaxTotalBytesError,
  type StreamValidator,
  type StreamValidatorOptions,
} from "../src/index.js";

const keepAll = (stream: StreamValidator) =>
  stream.editMember(
    () => true,
    () => null,
  );

async function run(
  chunks: Buffer[],
  options: StreamValidatorOptions,
  configure: (stream: StreamValidator) => void,
) {
  const stream = createStreamValidator(true, options);
  configure(stream);
  const output: Buffer[] = [];
  const result = stream.result.catch((error: unknown) => error);
  const failure = await pipeline(
    Readable.from(chunks),
    stream,
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    }),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { output: Buffer.concat(output), failure, result: await result };
}

describe("maxTotalBytes with edits", () => {
  it.each<[string, (stream: StreamValidator) => void]>([
    ["no hooks", () => {}],
    ["no-op member hook", keepAll],
    ["unmatched member hook", (stream) => stream.editMember(["zzz"], () => ({ action: "drop" }))],
    ["no-op scope hook", (stream) => stream.editClose([], () => null)],
  ])("preserves input order with %s", async (_name, configure) => {
    const input = Buffer.from('{"a":1,"bbbbbb":2,"c":"é"}');
    for (const policy of ["terminate", "detach"] as const) {
      for (const chunkSize of [1, 3, 5, input.length]) {
        const chunks = Array.from({ length: Math.ceil(input.length / chunkSize) }, (_, i) =>
          input.subarray(i * chunkSize, (i + 1) * chunkSize),
        );
        for (const maxTotalBytes of [4, 12, input.length - 1]) {
          const end = Math.min(
            (Math.floor(maxTotalBytes / chunkSize) + 1) * chunkSize,
            input.length,
          );
          const r = await run(chunks, { policy, maxTotalBytes }, configure);
          expect(r.failure).toBeInstanceOf(MaxTotalBytesError);
          expect(r.failure).toMatchObject({ limit: maxTotalBytes, byteOffset: end });
          expect(r.result).toBe(r.failure);
          expect(r.output, `${policy}, chunk ${chunkSize}, cap ${maxTotalBytes}`).toEqual(
            input.subarray(0, end),
          );
        }
      }
    }
  });

  it.each<[string, (stream: StreamValidator) => void, string]>([
    [
      "rename",
      (stream) => stream.editMember(["done"], () => ({ action: "rename", key: "ready" })),
      '{"ready":{"keep":0},"kept":true,',
    ],
    ["drop", (stream) => stream.editMember(["done"], () => ({ action: "drop" })), '{"kept":true,'],
    [
      "append",
      (stream) => {
        keepAll(stream);
        stream.editClose(["done"], (ctx) => ctx.field("added", true));
      },
      '{"done":{"keep":0,"added":true},"kept":true,',
    ],
  ])("preserves a completed %s before the held tail", async (_name, configure, prefix) => {
    const chunks = ['{"done":{"keep":0},"kept":true,', '"bbbb', 'bb":2,"c":3}'].map((s) =>
      Buffer.from(s),
    );
    const maxTotalBytes = chunks[0]!.length + chunks[1]!.length;
    const r = await run(chunks, { maxTotalBytes }, configure);
    expect(r.failure).toBeInstanceOf(MaxTotalBytesError);
    expect(r.result).toBe(r.failure);
    expect(r.output.toString()).toBe(prefix + '"bbbbbb":2,"c":3}');
  });

  it("copies an unresolved member without running its hook on the refused chunk", async () => {
    const chunks = ['{"unfinished', '":1}'].map((s) => Buffer.from(s));
    let calls = 0;
    const r = await run(chunks, { maxTotalBytes: chunks[0]!.length }, (stream) => {
      stream.editMember(
        () => true,
        () => {
          calls++;
          return { action: "drop" };
        },
      );
    });
    expect(r.failure).toBeInstanceOf(MaxTotalBytesError);
    expect(r.output).toEqual(Buffer.concat(chunks));
    expect(calls).toBe(0);
  });

  it("keeps parsed drop bytes deleted and copies the unparsed overflowing chunk", async () => {
    const chunks = ['{"drop":[1,', "2,3,", '4],"keep":1}'].map((s) => Buffer.from(s));
    const maxTotalBytes = chunks[0]!.length + chunks[1]!.length;
    const r = await run(chunks, { maxTotalBytes }, (stream) =>
      stream.editMember(["drop"], () => ({ action: "drop" })),
    );
    expect(r.failure).toBeInstanceOf(MaxTotalBytesError);
    expect(r.output.toString()).toBe('{4],"keep":1}');
  });

  it("reports the byte limit before a syntax error in the refused chunk", async () => {
    const chunks = ['{"a', '" INVALID'].map((s) => Buffer.from(s));
    const r = await run(chunks, { maxTotalBytes: chunks[0]!.length }, keepAll);
    expect(r.failure).toBeInstanceOf(MaxTotalBytesError);
    expect(r.result).toBe(r.failure);
    expect(r.output).toEqual(Buffer.concat(chunks));
  });

  it("accepts input exactly at the byte limit with edits", async () => {
    const chunks = ['{"a', '":1}'].map((s) => Buffer.from(s));
    const r = await run(chunks, { maxTotalBytes: Buffer.concat(chunks).length }, (stream) => {
      stream.editMember(["a"], () => ({ action: "rename", key: "renamed" }));
    });
    expect(r.failure).toBeUndefined();
    expect(r.result).toMatchObject({ valid: true });
    expect(r.output.toString()).toBe('{"renamed":1}');
  });

  it("stops flushing when the consumer destroys the stream", async () => {
    const prefix = Buffer.from('{"unfinished');
    const stream = createStreamValidator(true, { maxTotalBytes: prefix.length });
    keepAll(stream);
    const abort = new Error("consumer aborted");
    const output: Buffer[] = [];
    const errors: Error[] = [];
    let armed = false;
    stream.on("error", (error) => errors.push(error));
    stream.on("data", (chunk: Buffer) => {
      output.push(Buffer.from(chunk));
      if (armed) stream.destroy(abort);
    });
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    await new Promise<void>((resolve, reject) =>
      stream.write(prefix, (err) => (err ? reject(err) : resolve())),
    );
    armed = true;
    stream.end(Buffer.from('":1}'));
    await closed;
    await expect(stream.result).rejects.toBe(abort);
    expect(errors).toEqual([abort]);
    expect(Buffer.concat(output)).toEqual(prefix);
  });
});

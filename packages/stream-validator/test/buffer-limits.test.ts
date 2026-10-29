import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import {
  createStreamValidator,
  type MemberEdit,
  type StreamValidator,
  type StreamValidatorOptions,
} from "../src/index.js";

// `maxBufferedBytes` holds as bytes arrive (#1227): for a region starting at
// byte I with cap B, a span of B bytes fits and byte I + B is refused.

const chunkSizes = [1, 7, 1_000_000];

async function outcome(
  schema: SchemaOrBoolean,
  input: string,
  options: StreamValidatorOptions,
  chunkSize: number,
  configure?: (stream: StreamValidator) => void,
): Promise<string> {
  const bytes = Buffer.from(input);
  const stream = createStreamValidator(schema, options);
  configure?.(stream);
  const result = stream.result.catch((error: unknown) => error);
  const chunks = function* () {
    for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
  };
  try {
    await pipeline(
      Readable.from(chunks()),
      stream,
      new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    );
  } catch {
    // The result carries the same error.
  }
  const settled = await result;
  if (!(settled instanceof Error)) return "ok";
  const at = (settled as { byteOffset?: number }).byteOffset;
  return at === undefined ? settled.name : `${settled.name}@${at}`;
}

/** Expect `input` to pass at cap `fits` and refuse at `fits - 1`, at byte `start + fits - 1`. */
async function expectBoundary(
  schema: SchemaOrBoolean,
  input: string,
  start: number,
  fits: number,
  extra: StreamValidatorOptions = {},
): Promise<void> {
  for (const chunkSize of chunkSizes) {
    const label = `${input} in ${chunkSize}-byte chunks`;
    expect(
      await outcome(schema, input, { ...extra, maxBufferedBytes: fits }, chunkSize),
      label,
    ).toBe("ok");
    expect(
      await outcome(schema, input, { ...extra, maxBufferedBytes: fits - 1 }, chunkSize),
      label,
    ).toBe(`BufferLimitError@${start + fits - 1}`);
  }
}

const island: SchemaOrBoolean = { type: "array", uniqueItems: true };
const inMember = (value: SchemaOrBoolean): SchemaOrBoolean => ({
  type: "object",
  properties: { d: value },
});

describe("maxBufferedBytes on a container island", () => {
  it("counts whitespace that produces no event", async () => {
    await expectBoundary(island, `[1${" ".repeat(40)}]`, 0, 43);
  });

  it("counts a long string inside the island", async () => {
    await expectBoundary(island, `["${"a".repeat(40)}"]`, 0, 44);
  });

  it("counts a long number inside the island", async () => {
    await expectBoundary(island, `[${"1".repeat(40)}]`, 0, 42);
  });

  it("counts the closing byte, and measures from the island's first byte", async () => {
    await expectBoundary(inMember(island), '{"d":[1,2]  }', 5, 5);
  });
});

describe("maxBufferedBytes on a forced-buffer string", () => {
  it("measures from the opening quote and counts the closing quote", async () => {
    await expectBoundary({ type: "string", pattern: "^a*$" }, `"${"a".repeat(40)}"`, 0, 42);
    await expectBoundary(
      inMember({ type: "string", pattern: "^a*$" }),
      `{"d":"${"a".repeat(40)}"}`,
      5,
      42,
    );
  });

  it("counts a string island delegated whole", async () => {
    await expectBoundary({ type: "string", format: "date" }, '"2026-10-28"', 0, 12, {
      openApiVersion: "3.1",
    });
  });

  it("stops counting once an equality bound releases the text", async () => {
    // `"bbbbbbbbbbbbbbbbbbbb"` outgrows the 3-character candidate and is no
    // longer held, so the cap stops applying to it.
    const schema = { enum: ["abc", 1] };
    for (const chunkSize of chunkSizes) {
      expect(await outcome(schema, `"${"b".repeat(40)}"`, { maxBufferedBytes: 8 }, chunkSize)).toBe(
        "ok",
      );
    }
  });
});

describe("maxBufferedBytes across sub-spines", () => {
  it("refuses at the shared byte when TEE branches open islands together", async () => {
    const schema = {
      anyOf: [
        { type: "array", uniqueItems: true },
        { type: "array", contains: { const: 2 } },
      ],
    };
    await expectBoundary(schema, `[1,${" ".repeat(20)}2]`, 0, 25);
  });

  it("releases a closed island without disturbing its siblings", async () => {
    // Each element is an island inside a TEE branch; the first closes before
    // the second opens at byte 5.
    const schema = { anyOf: [{ items: { type: "array", uniqueItems: true } }, { minItems: 9 }] };
    await expectBoundary(schema, `[[1],[1,${" ".repeat(20)}2]]`, 5, 25);
  });
});

describe("maxBufferedBytes beside the other limits", () => {
  const drop = (): MemberEdit => ({ action: "drop" });
  const dropD = (stream: StreamValidator) => stream.editMember(["d"], drop);
  // The island for `d` starts at byte 5; the dropped member at its key, byte 1.
  const input = `{"d":[1,${" ".repeat(10)}2],"k":1}`;

  it("refuses a member edit before an island at a tied byte", async () => {
    for (const chunkSize of chunkSizes) {
      // Island refusal at 5 + 6; drop refusal at 1 + 10.
      expect(
        await outcome(
          inMember(island),
          input,
          { maxBufferedBytes: 6, maxMemberDropBytes: 10 },
          chunkSize,
          dropD,
        ),
      ).toBe("MemberEditError@11");
      expect(
        await outcome(
          inMember(island),
          input,
          { maxBufferedBytes: 6, maxMemberDropBytes: 11 },
          chunkSize,
          dropD,
        ),
      ).toBe("BufferLimitError@11");
    }
  });

  it("refuses an island before a number at a tied byte", async () => {
    // The number starts at 1, so maxNumberBytes 9 refuses byte 10, as does the island cap.
    for (const chunkSize of chunkSizes) {
      expect(
        await outcome(
          island,
          `[${"1".repeat(20)}]`,
          { maxBufferedBytes: 10, maxNumberBytes: 9 },
          chunkSize,
        ),
      ).toBe("BufferLimitError@10");
      expect(
        await outcome(
          island,
          `[${"1".repeat(20)}]`,
          { maxBufferedBytes: 11, maxNumberBytes: 9 },
          chunkSize,
        ),
      ).toBe("NumberLimitError@10");
    }
  });

  it("refuses an island before a key at a tied byte", async () => {
    // The key starts at 1, so maxKeyBytes 9 refuses byte 10, as does the island cap.
    const schema = { type: "object", dependentSchemas: { x: {} } };
    const input = `{"${"k".repeat(20)}":1}`;
    for (const chunkSize of chunkSizes) {
      expect(
        await outcome(schema, input, { maxBufferedBytes: 10, maxKeyBytes: 9 }, chunkSize),
      ).toBe("BufferLimitError@10");
      expect(
        await outcome(schema, input, { maxBufferedBytes: 11, maxKeyBytes: 9 }, chunkSize),
      ).toBe("KeyLimitError@10");
    }
  });

  it("leaves the maxTotalBytes chunk check ahead of it", async () => {
    for (const chunkSize of chunkSizes) {
      expect(
        await outcome(
          island,
          `[1${" ".repeat(20)}]`,
          { maxBufferedBytes: 10, maxTotalBytes: 10 },
          chunkSize,
        ),
      ).toMatch(/^MaxTotalBytesError/);
    }
  });

  it("reports a syntax error strictly before the refusing byte", async () => {
    for (const chunkSize of chunkSizes) {
      expect(await outcome(island, "[1,]      ", { maxBufferedBytes: 5 }, chunkSize)).toMatch(
        /^JsonParseError/,
      );
      // The number is malformed before its delimiter, which is the refusing byte.
      expect(await outcome(island, "[01 ]", { maxBufferedBytes: 3 }, chunkSize)).toMatch(
        /^JsonParseError/,
      );
      expect(await outcome(island, "[10 ]", { maxBufferedBytes: 3 }, chunkSize)).toBe(
        "BufferLimitError@3",
      );
    }
  });
});

/**
 * An object frame retains an input name only when its schemas look the
 * name up at close (`required`, `dependentRequired`, array-form
 * `dependencies`). These tests measure the retained names directly and
 * pin the counts, output, events and verdicts each input should produce.
 */
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import { SpineValidator } from "../src/spine/index.js";
import {
  createStreamValidator,
  MemberEditError,
  type StreamValidator,
  type StreamValidatorOptions,
} from "../src/index.js";

interface SpineState {
  frames: Array<{ kind: string; seen?: Set<string> }>;
  tee: { subs: SpineState[] } | null;
}

/** The `seen` set of every live object frame, TEE sub-spines included. */
function liveSeen(stream: StreamValidator): Set<string>[] {
  const out: Set<string>[] = [];
  const walk = (spine: SpineState): void => {
    for (const f of spine.frames) if (f.kind === "object") out.push(f.seen!);
    if (spine.tee !== null) for (const sub of spine.tee.subs) walk(sub);
  };
  walk((stream as unknown as { spine: SpineState }).spine);
  return out;
}

async function write(stream: StreamValidator, chunk: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    stream.write(chunk, (error) => (error ? reject(error) : resolve())),
  );
}

interface Run {
  valid: boolean;
  codes: string[];
  output: string;
  closes: Array<[string, number]>;
  keys: string[];
  /** The largest `seen` of any live frame, sampled before every chunk. */
  maxSeen: number;
  /** Each live frame's `seen` with the final `holdBack` bytes (default 1) unwritten. */
  seenBeforeLast: string[][];
}

async function run(
  schema: SchemaOrBoolean,
  input: string,
  {
    chunk = input.length,
    holdBack = 1,
    configure,
    ...options
  }: StreamValidatorOptions & {
    chunk?: number;
    holdBack?: number;
    configure?: (s: StreamValidator) => void;
  } = {},
): Promise<Run> {
  const stream = createStreamValidator(schema, {
    policy: "detach",
    maxErrors: Number.POSITIVE_INFINITY,
    keyEvents: true,
    ...options,
  });
  stream.on("error", () => {});
  const closes: Array<[string, number]> = [];
  const keys: string[] = [];
  stream.onScopeClose(
    () => true,
    (ctx) => {
      closes.push([ctx.path.join("/"), ctx.memberCount]);
      return null;
    },
  );
  stream.on("key", (e: { key: string }) => keys.push(e.key));
  configure?.(stream);
  const output: Buffer[] = [];
  stream.on("data", (b: Buffer) => output.push(b));
  const result = stream.result;
  const bytes = Buffer.from(input);
  let maxSeen = 0;
  const sample = (): void => {
    for (const s of liveSeen(stream)) maxSeen = Math.max(maxSeen, s.size);
  };
  const last = bytes.length - holdBack;
  for (let i = 0; i < last; i += chunk) {
    sample();
    await write(stream, bytes.subarray(i, Math.min(i + chunk, last)));
  }
  sample();
  const seenBeforeLast = liveSeen(stream).map((s) => [...s].sort());
  stream.end(bytes.subarray(last));
  const verdict = await result;
  return {
    valid: verdict.valid,
    codes: verdict.violations.map((v) => v.code),
    output: Buffer.concat(output).toString(),
    closes,
    keys,
    maxSeen,
    seenBeforeLast,
  };
}

const members = (n: number, prefix = "k"): string =>
  Array.from({ length: n }, (_, i) => `"${prefix}${i}":${i}`).join(",");

describe("names no schema looks up are counted, not retained", () => {
  it("leaves an open entity's seen set empty under a top-level member editor", async () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      properties: { entities: { type: "array", items: { type: "object" } } },
    };
    const input = `{"entities":[{${members(1000)}}]}`;
    let edits = 0;
    const r = await run(schema, input, {
      chunk: 64,
      maxKeyBytes: 64,
      maxNumberBytes: 64,
      configure: (s) =>
        s.editMember(
          () => true,
          () => {
            edits++;
            return null;
          },
          { scope: [] },
        ),
    });
    expect(r.valid).toBe(true);
    expect(r.maxSeen).toBe(0);
    expect(r.output).toBe(input);
    expect(edits).toBe(1);
    expect(r.closes).toContainEqual(["entities/0", 1000]);
    expect(r.keys).toHaveLength(1001);
  });

  it("retains exactly the looked-up names, whatever arrives around them", async () => {
    const schema = {
      type: "object",
      required: ["id"],
      dependentRequired: { a: ["b"] },
      dependencies: { p: ["q"] },
    } as SchemaOrBoolean;
    for (const input of [
      `{${members(200)},"b":1,"id":1,"a":1,"q":1,"p":1}`,
      `{"a":1,"q":1,${members(200)},"p":1,"id":1,"b":1}`,
    ]) {
      const r = await run(schema, input, { chunk: 7 });
      expect(r.valid).toBe(true);
      expect(r.seenBeforeLast).toEqual([["a", "b", "id", "p", "q"]]);
    }
  });

  it("retains a duplicated looked-up name once and counts every occurrence", async () => {
    const schema: SchemaOrBoolean = { type: "object", required: ["id"], minProperties: 4 };
    const r = await run(schema, `{"id":1,"x":1,"id":2,"x":2}`, { chunk: 1 });
    expect(r.valid).toBe(true);
    expect(r.seenBeforeLast).toEqual([["id"]]);
    expect(r.closes).toEqual([["", 4]]);
  });

  it("bounds each TEE branch frame by its own branch's names", async () => {
    const schema: SchemaOrBoolean = {
      type: "object",
      anyOf: [{ required: ["a"] }, { required: ["b"], dependentRequired: { b: ["c"] } }],
    };
    const r = await run(schema, `{${members(80)},"a":1,"c":1,"b":1}`, { chunk: 3 });
    expect(r.valid).toBe(true);
    // The own-keyword branch looks up nothing; each anyOf branch only its names.
    expect(r.seenBeforeLast).toEqual([[], ["a"], ["b", "c"]]);
  });

  it("unions the names of every schema applying to one object", async () => {
    const schema: SchemaOrBoolean = {
      $ref: "#/$defs/E",
      required: ["s"],
      $defs: { E: { type: "object", required: ["e"], dependentRequired: { t: ["u"] } } },
    };
    const r = await run(schema, `{${members(50)},"t":1,"s":1,"e":1,"u":1}`, { chunk: 5 });
    expect(r.valid).toBe(true);
    expect(r.seenBeforeLast).toEqual([["e", "s", "t", "u"]]);
  });

  it("unions three overlapping schemas", async () => {
    const schema: SchemaOrBoolean = {
      $ref: "#/$defs/A",
      required: ["s", "e"],
      properties: { n: { $ref: "#/$defs/B" } },
      $defs: {
        A: { $ref: "#/$defs/B", required: ["e"] },
        B: { type: "object", required: ["t", "e"] },
      },
    };
    // Held back: the two closing braces, so `n` is still open when sampled.
    const input = `{${members(30)},"t":1,"e":1,"s":1,"n":{"t":1,"e":1,"s":1,"x":1}}`;
    const r = await run(schema, input, { chunk: 4, holdBack: 2 });
    expect(r.valid).toBe(true);
    expect(r.seenBeforeLast).toEqual([
      ["e", "s", "t"],
      ["e", "t"],
    ]);
  });

  it("builds a union without writing into a schema's cached set", () => {
    const a = { required: ["a"] };
    const b = { required: ["b"] };
    const spine = new SpineValidator({}) as unknown as {
      presenceFor(schemas: object[]): ReadonlySet<string> | null;
    };
    const shared = spine.presenceFor([a]);
    expect([...spine.presenceFor([a, b])!]).toEqual(["a", "b"]);
    expect(spine.presenceFor([a])).toBe(shared);
    expect([...shared!]).toEqual(["a"]);
  });
});

describe("presence verdicts are unchanged", () => {
  const cases: Array<[string, SchemaOrBoolean, string, string[]]> = [
    ["late required", { type: "object", required: ["id"] }, `{${members(100)},"id":1}`, []],
    [
      "missing required",
      { type: "object", required: ["id", "x"] },
      `{${members(100)},"x":1}`,
      ["required"],
    ],
    [
      "trigger then late target",
      { type: "object", dependentRequired: { a: ["b"] } },
      `{"a":1,${members(50)},"b":1}`,
      [],
    ],
    [
      "target missing",
      { type: "object", dependentRequired: { a: ["b", "c"] } },
      `{${members(50)},"c":1,"a":1}`,
      ["dependentRequired"],
    ],
    ["trigger absent", { type: "object", dependentRequired: { a: ["b"] } }, `{${members(50)}}`, []],
    [
      "array-form dependencies",
      { type: "object", dependencies: { a: ["b"], q: ["r"] } } as SchemaOrBoolean,
      `{"a":1,${members(50)},"q":1,"r":1}`,
      ["dependencies"],
    ],
    [
      "schema-form dependencies, delegated",
      { type: "object", dependencies: { a: { required: ["z"] } } } as SchemaOrBoolean,
      `{"a":1,${members(20)}}`,
      ["required"],
    ],
    [
      "overlapping allOf",
      { allOf: [{ required: ["a"] }, { required: ["a", "b"] }] },
      `{${members(40)},"a":1}`,
      ["composition"],
    ],
    [
      "duplicates against min/maxProperties",
      { type: "object", minProperties: 3, maxProperties: 4 },
      `{"a":1,"a":2,"b":3,"c":4,"c":5}`,
      ["maxProperties"],
    ],
    [
      "a string dependentRequired is read by index (#919)",
      { type: "object", dependentRequired: "ab" } as never,
      `{${members(20)},"0":1,"b":1}`,
      ["dependentRequired"],
    ],
    [
      "a string target is read per character (#919)",
      { type: "object", dependentRequired: { a: "bc" } } as never,
      `{"a":1,"b":1}`,
      ["dependentRequired"],
    ],
  ];

  for (const [name, schema, input, codes] of cases) {
    for (const chunk of [1, 5, input.length]) {
      it(`${name}, chunk ${chunk}`, async () => {
        const all = await run(schema, input, { chunk });
        expect(all.codes).toEqual(codes);
        expect(all.valid).toBe(codes.length === 0);
        const one = await run(schema, input, { chunk, maxErrors: 1 });
        expect(one.codes).toEqual(codes.slice(0, 1));
      });
    }
  }

  it("still fails a rename onto a name the schema never looks up", async () => {
    await expect(
      run({ type: "object" }, `{"k1":1,"k2":2}`, {
        configure: (s) => s.editMember(["k1"], () => ({ action: "rename", key: "k2" })),
      }),
    ).rejects.toBeInstanceOf(MemberEditError);
  });
});

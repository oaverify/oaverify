import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import type { SchemaOrBoolean } from "@oaverify/internal-core";
import {
  createStreamValidator,
  type MemberContext,
  type MemberEdit,
  type StreamValidator,
} from "../src/index.js";

const enc = new TextEncoder();

interface RunResult {
  output: string;
  err: Error | undefined;
  valid: boolean | undefined;
  peakBufferedBytes: number | undefined;
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
    (r) => r,
    () => undefined,
  );
  return {
    output: Buffer.concat(out).toString("utf8"),
    err,
    valid: verdict?.valid,
    peakBufferedBytes: verdict?.peakBufferedBytes,
  };
}

const rename = (key: string) => (): MemberEdit => ({ action: "rename", key });
const drop = (): MemberEdit => ({ action: "drop" });

describe("editMember rename", () => {
  it("renames a scalar key, value verbatim", async () => {
    const r = await run({ type: "object" }, '{"a":1,"b":2}', (v) =>
      v.editMember(["a"], rename("z")),
    );
    expect(r.output).toBe('{"z":1,"b":2}');
    expect(r.valid).toBe(true);
  });

  it("renames a key whose value is an array, streaming the array verbatim", async () => {
    const schema = { type: "object", properties: { ids: { type: "array" } } };
    const r = await run(schema, '{"ids":[1,2,3,4,5]}', (v) =>
      v.editMember(["ids"], rename("records")),
    );
    expect(r.output).toBe('{"records":[1,2,3,4,5]}');
    expect(r.valid).toBe(true);
  });

  it("renames a key whose value is an object", async () => {
    const r = await run({ type: "object" }, '{"meta":{"x":1}}', (v) =>
      v.editMember(["meta"], rename("m")),
    );
    expect(r.output).toBe('{"m":{"x":1}}');
  });

  it("only renames the targeted (full-path) member", async () => {
    const r = await run({ type: "object" }, '{"a":{"a":1}}', (v) =>
      v.editMember(["a"], rename("z")),
    );
    // The nested "a" is at path ["a","a"], not matched by ["a"].
    expect(r.output).toBe('{"z":{"a":1}}');
  });

  it("renames correctly across tiny chunk boundaries", async () => {
    const schema = { type: "object", properties: { message_ids: { type: "array" } } };
    const json = '{"message_ids":["x","y","z"],"batch":7}';
    for (const cs of [1, 2, 3, 5, 8]) {
      const r = await run(
        schema,
        json,
        (v) => v.editMember(["message_ids"], rename("records")),
        {},
        cs,
      );
      expect(r.output, `chunk size ${cs}`).toBe('{"records":["x","y","z"],"batch":7}');
      expect(r.valid).toBe(true);
    }
  });

  it("preserves whitespace/formatting around the renamed key", async () => {
    const r = await run({ type: "object" }, '{\n  "a" : 1\n}', (v) =>
      v.editMember(["a"], rename("zz")),
    );
    expect(r.output).toBe('{\n  "zz" : 1\n}');
  });
});

describe("editMember rename does not buffer the value", () => {
  const schema = {
    type: "object",
    properties: { ids: { type: "array", items: { type: "number" } } },
  };
  const big = Array.from({ length: 20000 }, (_, i) => i).join(",");
  const json = `{"ids":[${big}]}`; // ~109 KB, dominated by the array

  it("renames a key over a large array buffering nothing at realistic chunking", async () => {
    // A value far larger than the cap: if rename buffered it, the cap would trip.
    const r = await run(
      schema,
      json,
      (v) => v.editMember(["ids"], rename("records")),
      { maxBufferedBytes: 64 },
      256,
    );
    expect(r.valid).toBe(true);
    expect(r.err).toBeUndefined();
    expect(r.output).toBe(`{"records":[${big}]}`);
    // The exact meter (#439): the `"ids":` key resolves within one chunk, so
    // nothing is held across a boundary. The array streams; peak is zero.
    expect(r.peakBufferedBytes).toBe(0);
  });

  it("holds only the key span, never the array, even byte-at-a-time", async () => {
    // Pathological 1-byte chunks force the key token to straddle boundaries;
    // the held high-water is the `"ids":` span (~6 bytes), orders of magnitude
    // below the ~109 KB array. This is the #441 no-array-buffering promise,
    // now asserted exactly rather than via a `maxBufferedBytes` ceiling.
    const r = await run(schema, json, (v) => v.editMember(["ids"], rename("records")), {}, 1);
    expect(r.valid).toBe(true);
    expect(r.output).toBe(`{"records":[${big}]}`);
    expect(r.peakBufferedBytes).toBeGreaterThan(0);
    expect(r.peakBufferedBytes).toBeLessThanOrEqual('"ids":'.length);
    expect(r.peakBufferedBytes).toBeLessThan(json.length / 1000);
  });
});

describe("editMember drop", () => {
  it("drops a middle member (absorbs the following comma)", async () => {
    const r = await run({ type: "object" }, '{"a":1,"b":2,"c":3}', (v) =>
      v.editMember(["b"], drop),
    );
    expect(r.output).toBe('{"a":1,"c":3}');
    expect(r.valid).toBe(true);
  });

  it("drops the first member", async () => {
    const r = await run({ type: "object" }, '{"a":1,"b":2}', (v) => v.editMember(["a"], drop));
    expect(r.output).toBe('{"b":2}');
  });

  it("drops the last member (absorbs the preceding comma)", async () => {
    const r = await run({ type: "object" }, '{"a":1,"b":2}', (v) => v.editMember(["b"], drop));
    expect(r.output).toBe('{"a":1}');
  });

  it("drops the only member", async () => {
    const r = await run({ type: "object" }, '{"a":1}', (v) => v.editMember(["a"], drop));
    expect(JSON.parse(r.output)).toEqual({});
  });

  it("drops two consecutive members", async () => {
    const r = await run({ type: "object" }, '{"a":1,"b":2,"c":3,"d":4}', (v) => {
      v.editMember(["b"], drop);
      v.editMember(["c"], drop);
    });
    expect(r.output).toBe('{"a":1,"d":4}');
  });

  it("drops trailing members after a kept array sibling", async () => {
    const schema = { type: "object", properties: { ids: { type: "array" } } };
    const r = await run(schema, '{"ids":[1,2,3],"x":1,"y":2}', (v) => {
      v.editMember(["x"], drop);
      v.editMember(["y"], drop);
    });
    expect(r.output).toBe('{"ids":[1,2,3]}');
    expect(r.valid).toBe(true);
  });

  it("drops a deprecated scalar across chunk boundaries", async () => {
    const json = '{"keep":"v","old":"deprecated","tail":3}';
    for (const cs of [1, 2, 4, 7]) {
      const r = await run({ type: "object" }, json, (v) => v.editMember(["old"], drop), {}, cs);
      expect(r.output, `chunk size ${cs}`).toBe('{"keep":"v","tail":3}');
    }
  });

  it("still validates a dropped member (validate-by-default)", async () => {
    const schema = {
      type: "object",
      properties: { gone: { type: "number" } },
    };
    // "gone" is a string but the schema says number: invalid even though dropped.
    const r = await run(schema, '{"gone":"x","keep":1}', (v) => v.editMember(["gone"], drop), {
      maxErrors: Number.POSITIVE_INFINITY,
      policy: "detach",
    });
    expect(r.valid).toBe(false);
    expect(r.output).toBe('{"keep":1}');
  });
});

describe("editMember rename + drop together", () => {
  it("renames one member and drops another", async () => {
    const schema = { type: "object", properties: { ids: { type: "array" } } };
    const r = await run(schema, '{"ids":[1,2],"old":true,"keep":9}', (v) => {
      v.editMember(["ids"], rename("records"));
      v.editMember(["old"], drop);
    });
    expect(r.output).toBe('{"records":[1,2],"keep":9}');
    expect(JSON.parse(r.output)).toEqual({ records: [1, 2], keep: 9 });
  });
});

describe("editMember collisions and conflicts are fatal", () => {
  it("fails when a rename target duplicates an existing later key", async () => {
    const r = await run({ type: "object" }, '{"a":1,"b":2}', (v) =>
      v.editMember(["a"], rename("b")),
    );
    expect(r.err).toBeDefined();
    expect(r.err?.name).toBe("MemberEditError");
  });

  it("fails when a rename target duplicates an existing earlier key", async () => {
    const r = await run({ type: "object" }, '{"b":2,"a":1}', (v) =>
      v.editMember(["a"], rename("b")),
    );
    expect(r.err?.name).toBe("MemberEditError");
  });

  it("allows a key swap (rename a->b while b->c)", async () => {
    const r = await run({ type: "object" }, '{"a":1,"b":2}', (v) => {
      v.editMember(["a"], rename("b"));
      v.editMember(["b"], rename("c"));
    });
    expect(r.err).toBeUndefined();
    expect(r.output).toBe('{"b":1,"c":2}');
  });

  it("fails on conflicting hooks for one member", async () => {
    const r = await run({ type: "object" }, '{"a":1}', (v) => {
      v.editMember(["a"], rename("x"));
      v.editMember(["a"], rename("y"));
    });
    expect(r.err?.name).toBe("MemberEditError");
  });

  it("tolerates two hooks that agree (same rename)", async () => {
    const r = await run({ type: "object" }, '{"a":1}', (v) => {
      v.editMember(["a"], rename("x"));
      v.editMember(["a"], rename("x"));
    });
    expect(r.err).toBeUndefined();
    expect(r.output).toBe('{"x":1}');
  });
});

describe("editMember caps", () => {
  it("fails when colon-to-value whitespace exceeds maxMemberPrefixBytes", async () => {
    const pad = " ".repeat(64);
    const r = await run(
      { type: "object" },
      `{"a":${pad}1}`,
      (v) => v.editMember(["a"], rename("z")),
      {
        maxMemberPrefixBytes: 16,
      },
    );
    expect(r.err?.name).toBe("MemberEditError");
  });

  it("fails when a dropped member's span exceeds maxMemberDropBytes", async () => {
    const big = "x".repeat(200);
    const r = await run(
      { type: "object" },
      `{"a":"${big}","b":2}`,
      (v) => v.editMember(["a"], drop),
      {
        maxMemberDropBytes: 32,
      },
    );
    expect(r.err?.name).toBe("MemberEditError");
  });

  it("rejects a container drop as unsupported", async () => {
    const schema = { type: "object", properties: { obj: { type: "object" } } };
    const r = await run(schema, '{"obj":{"x":1}}', (v) => v.editMember(["obj"], drop));
    expect(r.err?.name).toBe("MemberEditError");
  });
});

describe("editMember nested objects", () => {
  it("renames and drops members in a nested object selected by full path", async () => {
    const schema = { type: "object", properties: { inner: { type: "object" } } };
    const r = await run(schema, '{"inner":{"a":1,"b":2,"c":3}}', (v) => {
      v.editMember(["inner", "a"], rename("z"));
      v.editMember(["inner", "b"], drop);
    });
    expect(r.output).toBe('{"inner":{"z":1,"c":3}}');
    expect(JSON.parse(r.output)).toEqual({ inner: { z: 1, c: 3 } });
  });

  it("keep is a no-op (returning null too)", async () => {
    const r = await run({ type: "object" }, '{"a":1,"b":2}', (v) => {
      v.editMember(["a"], () => ({ action: "keep" }));
      v.editMember(["b"], () => null);
    });
    expect(r.output).toBe('{"a":1,"b":2}');
  });

  it("exposes the member context (path, key, valueType)", async () => {
    const seen: MemberContext[] = [];
    await run({ type: "object" }, '{"s":"x","n":1,"arr":[]}', (v) =>
      v.editMember(
        () => true,
        (m) => {
          seen.push(m);
          return { action: "keep" };
        },
      ),
    );
    expect(seen.map((m) => [m.key, m.valueType])).toEqual([
      ["s", "string"],
      ["n", "number"],
      ["arr", "array"],
    ]);
  });
});

describe("editMember on a scalar routed through a BUFFER island", () => {
  // Under an asserting OpenAPI dialect a `format`-bearing scalar is delegated
  // to the in-memory engine (a scalar BUFFER island), not stream-checked. The
  // edit is decided at the value start (pre-classification) and finalized at
  // the value end; the delegate validates the materialized value but never
  // emits output, so the echo remains the single output path. These pin that
  // boundary: edit applies, verdict comes from the delegate. A custom format
  // (deterministic, definitely asserting) forces the island.
  const schema = {
    type: "object",
    properties: { when: { type: "string", format: "even-len" } },
  };
  const opts = {
    openApiVersion: "3.1",
    formats: { "even-len": (s: string) => s.length % 2 === 0 },
  };

  it("renames a delegated format scalar, value verbatim, verdict from the delegate", async () => {
    const r = await run(
      schema,
      '{"when":"abcd","keep":1}',
      (v) => v.editMember(["when"], rename("ts")),
      opts,
    );
    expect(r.output).toBe('{"ts":"abcd","keep":1}');
    expect(r.valid).toBe(true);
  });

  it("drops a delegated format scalar (still validated, then suppressed)", async () => {
    const r = await run(
      schema,
      '{"when":"abcd","keep":1}',
      (v) => v.editMember(["when"], drop),
      opts,
    );
    expect(r.output).toBe('{"keep":1}');
    expect(r.valid).toBe(true);
  });

  it("applies the rename even when the delegated value fails its format", async () => {
    // decide-before-classification: the key is rewritten at value start, so an
    // invalid format still renames; the delegate's verdict flows independently.
    const r = await run(schema, '{"when":"abc"}', (v) => v.editMember(["when"], rename("ts")), {
      ...opts,
      maxErrors: Number.POSITIVE_INFINITY,
      policy: "detach",
    });
    expect(r.output).toBe('{"ts":"abc"}');
    expect(r.valid).toBe(false);
  });
});

describe("editMember rename of a container routed through BUFFER/TEE, then trailing drop", () => {
  // Rename is decided at the key token, independent of how the value
  // classifies, so a key in front of a non-streamed container renames the same
  // as in front of a plain array. The load-bearing assertion is that
  // `noteContainerMemberEnd` records the right `lastKeptValueEnd` on the
  // finalizeIsland / finalizeTee paths, so a following trailing scalar drop
  // absorbs the correct comma.
  it("renames a BUFFER container (uniqueItems) then drops a trailing scalar", async () => {
    const schema = {
      type: "object",
      properties: { tags: { type: "array", uniqueItems: true } },
    };
    const r = await run(schema, '{"tags":[1,2,3],"drop_me":1}', (v) => {
      v.editMember(["tags"], rename("labels"));
      v.editMember(["drop_me"], drop);
    });
    expect(r.output).toBe('{"labels":[1,2,3]}');
    expect(r.valid).toBe(true);
  });

  it("renames a TEE container (oneOf) then drops a trailing scalar", async () => {
    const schema = {
      type: "object",
      properties: { val: { oneOf: [{ type: "array" }, { type: "number" }] } },
    };
    const r = await run(schema, '{"val":[1,2],"drop_me":1}', (v) => {
      v.editMember(["val"], rename("value"));
      v.editMember(["drop_me"], drop);
    });
    expect(r.output).toBe('{"value":[1,2]}');
    expect(r.valid).toBe(true);
  });
});

describe("editMember collision rule keys on surviving output names", () => {
  // The duplicate-key guard polices effective *surviving* output names, not
  // raw input keys: a rename onto a name whose original is itself dropped is
  // legal (the original never reaches the output). The symmetric case (rename
  // onto a surviving key) stays fatal, covered above.
  it("allows a->b when the original b is dropped", async () => {
    const r = await run({ type: "object" }, '{"a":1,"b":2}', (v) => {
      v.editMember(["a"], rename("b"));
      v.editMember(["b"], drop);
    });
    expect(r.err).toBeUndefined();
    expect(r.output).toBe('{"b":1}');
  });

  it("allows b->a when the original a is dropped", async () => {
    const r = await run({ type: "object" }, '{"a":1,"b":2}', (v) => {
      v.editMember(["a"], drop);
      v.editMember(["b"], rename("a"));
    });
    expect(r.err).toBeUndefined();
    expect(r.output).toBe('{"a":2}');
  });
});

describe("editMember + editClose interaction (cross-hook output-member count)", () => {
  // `editClose`'s field() leading comma must track *surviving output* members,
  // not the pre-edit input count: after a member drop the appended field has to
  // know whether anything is left to comma-separate from. A drop never enters
  // the output-key set, so an all-members drop leaves a zero output count and
  // field() omits the comma.
  it("drop-all + editClose field omits the stray comma (root)", async () => {
    const r = await run({ type: "object" }, '{"a":1}', (v) => {
      v.editMember(["a"], drop);
      v.editClose([], (ctx) => ctx.field("x", 1));
    });
    expect(r.err).toBeUndefined();
    expect(r.output).toBe('{"x":1}');
  });

  it("drop-all + editClose field omits the comma in a nested object (per-frame count)", async () => {
    const r = await run({ type: "object" }, '{"outer":{"a":1}}', (v) => {
      v.editMember(["outer", "a"], drop);
      v.editClose(["outer"], (ctx) => ctx.field("x", 1));
    });
    expect(r.err).toBeUndefined();
    expect(r.output).toBe('{"outer":{"x":1}}');
  });

  it("partial drop + editClose field keeps the comma (a survivor remains)", async () => {
    const r = await run({ type: "object" }, '{"a":1,"b":2}', (v) => {
      v.editMember(["b"], drop);
      v.editClose([], (ctx) => ctx.field("x", 1));
    });
    expect(r.err).toBeUndefined();
    expect(r.output).toBe('{"a":1,"x":1}');
  });

  it("rename-only + editClose field keeps the comma (a renamed member is a survivor)", async () => {
    const r = await run({ type: "object" }, '{"a":1}', (v) => {
      v.editMember(["a"], rename("z"));
      v.editClose([], (ctx) => ctx.field("x", 1));
    });
    expect(r.err).toBeUndefined();
    expect(r.output).toBe('{"z":1,"x":1}');
  });

  it("observer memberCount stays the pre-edit input count under drop-all", async () => {
    let observed: number | undefined;
    const r = await run({ type: "object" }, '{"a":1}', (v) => {
      v.editMember(["a"], drop);
      v.onScopeClose([], (ctx) => {
        observed = ctx.memberCount;
      });
    });
    expect(r.err).toBeUndefined();
    expect(r.output).toBe("{}");
    // memberCount is the input observation, not the surviving output count.
    expect(observed).toBe(1);
  });
});

describe("scope-only editClose does not hold a chunk-split key", () => {
  // The tokenizer mid-key hold exists for rename safety. With only `editClose`
  // registered (no member hooks), there is no key rewrite, so a key straddling
  // a chunk boundary must not be held: it would buffer to its closing quote
  // with no member-prefix cap, regressing the append-only path. Observed
  // directly: after a chunk that ends mid-key, the bytes preceding the key are
  // already flushed downstream rather than withheld.
  it("flushes the pre-key bytes before the split key closes", async () => {
    const v = createStreamValidator({ type: "object" }, {});
    v.editClose([], (ctx) => ctx.field("x", 1));
    v.on("error", () => {});
    const out: Buffer[] = [];
    v.on("data", (c: Buffer) => out.push(Buffer.from(c)));

    const longKey = "k".repeat(50000);
    const json = `{"${longKey}":1}`;
    const cut = 2 + 25000; // mid-key: past the leading `{"`, inside the key body
    v.write(Buffer.from(json.slice(0, cut)));
    await new Promise((resolve) => setImmediate(resolve));
    // Held (pre-fix) would leave only the opening `{` flushed (~1 byte). With
    // the hold gated off, everything up to the cut streams through.
    const flushed = Buffer.concat(out).length;
    expect(flushed).toBeGreaterThan(20000);

    v.end(Buffer.from(json.slice(cut)));
    const valid = await v.result.then(
      (res) => res.valid,
      () => undefined,
    );
    expect(Buffer.concat(out).toString("utf8")).toBe(`{"${longKey}":1,"x":1}`);
    expect(valid).toBe(true);
  });
});

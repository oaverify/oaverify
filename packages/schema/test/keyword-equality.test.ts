import { describe, expect, it } from "vitest";
import { compile, failure } from "./helpers.js";

describe("enum keyword", () => {
  it("accepts any deep-equal value from the allowed set", () => {
    const v = compile({ enum: [1, "x", { a: 1 }, [1, 2]] });
    expect(v.validate(1).valid).toBe(true);
    expect(v.validate("x").valid).toBe(true);
    expect(v.validate({ a: 1 }).valid).toBe(true);
    expect(v.validate([1, 2]).valid).toBe(true);
  });

  it("rejects values not in the set with code 'enum'", () => {
    const v = compile({ enum: [1, 2, 3] });
    const r = v.validate(4);
    expect(r.valid).toBe(false);
    expect(failure(r).error.code).toBe("enum");
    expect(failure(r).error.params).toMatchObject({ allowed: [1, 2, 3], actual: 4 });
  });

  it("accepts object equality regardless of key order", () => {
    const v = compile({ enum: [{ a: 1, b: 2 }] });
    expect(v.validate({ b: 2, a: 1 }).valid).toBe(true);
  });
});

describe("const keyword", () => {
  it("accepts only the exact constant", () => {
    const v = compile({ const: "Cat" });
    expect(v.validate("Cat").valid).toBe(true);
    expect(v.validate("Dog").valid).toBe(false);
  });

  it("uses deep equality for objects and arrays", () => {
    const v = compile({ const: { kind: "Cat", purrs: true } });
    expect(v.validate({ purrs: true, kind: "Cat" }).valid).toBe(true);
  });

  it("emits code 'const' with expected/actual params", () => {
    const v = compile({ const: 42 });
    const r = v.validate(7);
    expect(failure(r).error.code).toBe("const");
    expect(failure(r).error.params).toEqual({ expected: 42, actual: 7 });
  });
});

describe("own __proto__ keys in const and enum values (#1201)", () => {
  // Every value here comes from JSON.parse, which keeps an own `__proto__`
  // key; an object literal in source would set a prototype instead.
  const j = (text: string): unknown => JSON.parse(text);
  const hasOwnProto = (v: unknown): boolean =>
    typeof v === "object" && v !== null && Object.hasOwn(v, "__proto__");

  const cases: Array<{ name: string; schema: string; equal: string; unequal: string[] }> = [
    {
      name: "root const",
      schema: '{"const":{"__proto__":{"a":1}}}',
      equal: '{"__proto__":{"a":1}}',
      unequal: ["{}", '{"__proto__":{"a":2}}', '{"a":1}'],
    },
    {
      name: "nested const",
      schema: '{"const":{"k":[{"__proto__":"x"}]}}',
      equal: '{"k":[{"__proto__":"x"}]}',
      unequal: ['{"k":[{}]}', '{"k":[{"__proto__":"y"}]}'],
    },
    {
      name: "mixed enum",
      schema: '{"enum":[1,"x",{"__proto__":"x"},[{"__proto__":{"b":null}}]]}',
      equal: '[{"__proto__":{"b":null}}]',
      unequal: ["{}", "[{}]", '{"__proto__":"y"}'],
    },
  ];

  for (const c of cases) {
    for (const output of ["tree", "flat", "predicate"] as const) {
      it(`${c.name}: accepts the equal value and rejects others (${output})`, () => {
        const budgets =
          output === "predicate" ? [Number.POSITIVE_INFINITY] : [1, Number.POSITIVE_INFINITY];
        for (const maxErrors of budgets) {
          const v = compile(j(c.schema) as never, { output, maxErrors });
          const ok = (data: unknown): boolean => {
            const r = v.validate(data);
            return typeof r === "boolean" ? r : r.valid;
          };
          expect(ok(j(c.equal))).toBe(true);
          for (const u of c.unequal) expect(ok(j(u)), u).toBe(false);
        }
      });
    }
  }

  it("keeps the own key in error params, fresh on every failure", () => {
    const v = compile(j('{"const":{"__proto__":{"a":1}}}') as never);
    const first = failure(v.validate({})).error.params as { expected: Record<string, unknown> };
    expect(hasOwnProto(first.expected)).toBe(true);
    expect(first.expected).toEqual(j('{"__proto__":{"a":1}}'));
    // Mutating a reported value must not change later verdicts or params.
    (first.expected["__proto__"] as Record<string, unknown>)["a"] = 99;
    expect(v.validate(j('{"__proto__":{"a":1}}')).valid).toBe(true);
    const second = failure(v.validate({})).error.params as { expected: unknown };
    expect(second.expected).toEqual(j('{"__proto__":{"a":1}}'));

    const e = compile(j('{"enum":[{"__proto__":"x"}]}') as never);
    const allowed = (failure(e.validate({})).error.params as { allowed: unknown[] }).allowed;
    expect(hasOwnProto(allowed[0])).toBe(true);
    allowed.length = 0;
    expect(e.validate(j('{"__proto__":"x"}')).valid).toBe(true);
  });

  it("passes a custom keyword its argument with own keys, fresh on every call", () => {
    const received: Record<string, unknown>[] = [];
    const v = compile(j('{"tag":{"__proto__":{"a":1}}}') as never, {
      keywords: {
        tag: (_data, schemaValue) => {
          const arg = schemaValue as Record<string, unknown>;
          received.push(structuredClone(arg));
          arg["mutated"] = true;
          return true;
        },
      },
    });
    v.validate(1);
    v.validate(2);
    expect(received).toEqual([j('{"__proto__":{"a":1}}'), j('{"__proto__":{"a":1}}')]);
    for (const arg of received) expect(hasOwnProto(arg)).toBe(true);
  });
});

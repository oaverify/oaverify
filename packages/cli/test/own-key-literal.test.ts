import { describe, expect, it } from "vitest";
import { ownKeyLiteral } from "../src/own-key-literal.js";

// Loaded as a module, the way the emitted output is.
const evaluate = async (source: string): Promise<unknown> =>
  (
    (await import(
      `data:text/javascript;base64,${Buffer.from(`export default (${source});`).toString("base64")}`
    )) as { default: unknown }
  ).default;

describe("ownKeyLiteral", () => {
  const samples: unknown[] = [
    null,
    "s",
    1,
    [],
    {},
    [1, [2, {}], { a: [] }],
    { a: 1, b: { c: [true, null, "x"] }, d: undefined, e: Number.NaN },
  ];

  it.each(samples.map((s) => [JSON.stringify(s), s]))(
    "writes %s exactly as JSON.stringify does",
    (_label, value) => {
      expect(ownKeyLiteral(value)).toBe(JSON.stringify(value, null, 2));
      expect(ownKeyLiteral(value, 0)).toBe(JSON.stringify(value));
    },
  );

  it("keeps an own __proto__ key as an own property (#1236)", async () => {
    const value = JSON.parse(
      '{"headers":{"__proto__":{"schema":{"type":"integer"}},"x":[{"__proto__":1}]},"s":"__proto__"}',
    ) as unknown;
    for (const space of [2, 0] as const) {
      const source = ownKeyLiteral(value, space);
      const read = (await evaluate(source)) as { headers: Record<string, unknown> };
      expect(Object.hasOwn(read.headers, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(read.headers)).toBe(Object.prototype);
      expect(JSON.stringify(read)).toBe(JSON.stringify(value));
    }
    expect(ownKeyLiteral({ s: "__proto__" })).toBe(JSON.stringify({ s: "__proto__" }, null, 2));
  });

  it("lays a __proto__-bearing value out as JSON.stringify would", () => {
    const value = JSON.parse('{"a":{"__proto__":[1,{}]},"b":[]}') as unknown;
    expect(ownKeyLiteral(value).replace('["__proto__"]', '"__proto__"')).toBe(
      JSON.stringify(value, null, 2),
    );
    expect(ownKeyLiteral(value, 0).replace('["__proto__"]', '"__proto__"')).toBe(
      JSON.stringify(value),
    );
  });
});

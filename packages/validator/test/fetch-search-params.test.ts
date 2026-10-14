import { describe, expect, it } from "vitest";
import { httpRequestFromFetch } from "../src/from-fetch.js";

/**
 * The extraction before #1149: one `getAll` per distinct name. Kept as
 * the reference the one-pass accumulator must agree with.
 */
function reference(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    Object.defineProperty(out, key, {
      value: values.length === 1 ? (values[0] ?? "") : values,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

const QUERIES = [
  "",
  "a=1",
  "a=1&b=2&c=3",
  "a=1&a=2&a=3",
  "a=1&b=2&a=3&b=4&c=5",
  "a=&a=&b=",
  "a&b=&a",
  "constructor=1&__proto__=2&toString=3&hasOwnProperty=4",
  "__proto__=1&__proto__=2&constructor=x&constructor=y",
  "x%20y=1&x+y=2&%C3%A9=3",
  "=1&=2",
];

/** Own entries in insertion order, so an inherited member cannot pass for a field. */
const own = (o: object): Array<[string, unknown]> =>
  Object.keys(o).map((k) => [k, Object.getOwnPropertyDescriptor(o, k)?.value]);

describe("Fetch query and form field extraction (#1149)", () => {
  it.each(QUERIES)("query %j matches the per-name extraction", async (query) => {
    const req = await httpRequestFromFetch(new Request(`https://example.test/x?${query}`));
    expect(own(req.httpRequest.query ?? {})).toEqual(own(reference(new URLSearchParams(query))));
    expect(Object.getPrototypeOf(req.httpRequest.query)).toBe(Object.prototype);
  });

  it.each(QUERIES.filter((q) => q !== ""))(
    "urlencoded body %j matches the per-name extraction",
    async (body) => {
      const req = await httpRequestFromFetch(
        new Request("https://example.test/x", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
      );
      expect(own(req.body as object)).toEqual(own(reference(new URLSearchParams(body))));
    },
  );

  it("keeps repeated values in order and special names as own fields", async () => {
    const req = await httpRequestFromFetch(
      new Request("https://example.test/x?b=1&a=x&b=2&constructor=c&__proto__=p&b=3&a="),
    );
    expect(own(req.httpRequest.query ?? {})).toEqual([
      ["b", ["1", "2", "3"]],
      ["a", ["x", ""]],
      ["constructor", "c"],
      ["__proto__", "p"],
    ]);
  });
});

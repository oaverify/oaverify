import { normalizeFormat, type FormatDefinition } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import {
  builtInFormats,
  fromAjvFormats,
  validateDate,
  validateDateTime,
  validateDuration,
  validateEmail,
  validateHostname,
  validateIdnEmail,
  validateInt32,
  validateInt64,
  validateIpv4,
  validateIpv6,
  validateJsonPointer,
  validateRegex,
  validateRelativeJsonPointer,
  validateTime,
  validateUri,
  validateUriReference,
  validateUriTemplate,
  validateUuid,
} from "../src/index.js";

describe("date / time / date-time / duration", () => {
  it("accepts RFC 3339 dates", () => {
    expect(validateDate("2024-01-31")).toBe(true);
    expect(validateDate("2024-02-29")).toBe(true);
    expect(validateDate("2023-02-29")).toBe(false);
    expect(validateDate("2024-13-01")).toBe(false);
    expect(validateDate("not a date")).toBe(false);
  });

  it("accepts RFC 3339 times with offsets", () => {
    expect(validateTime("12:34:56Z")).toBe(true);
    expect(validateTime("12:34:56+02:00")).toBe(true);
    expect(validateTime("12:34:56.789Z")).toBe(true);
    expect(validateTime("25:00:00Z")).toBe(false);
    expect(validateTime("12:34:56")).toBe(false);
  });

  it("accepts RFC 3339 date-times", () => {
    expect(validateDateTime("2024-01-31T12:34:56Z")).toBe(true);
    expect(validateDateTime("2024-01-31T12:34:56.789+02:00")).toBe(true);
    expect(validateDateTime("2024-01-31 12:34:56Z")).toBe(false);
  });

  it("accepts ISO 8601 durations", () => {
    expect(validateDuration("P1Y")).toBe(true);
    expect(validateDuration("P1Y2M10DT2H30M")).toBe(true);
    expect(validateDuration("P")).toBe(false);
    expect(validateDuration("PT")).toBe(false);
    expect(validateDuration("nope")).toBe(false);
  });
});

describe("email / hostname", () => {
  it("accepts plausible emails", () => {
    expect(validateEmail("user@example.com")).toBe(true);
    expect(validateEmail("a.b+c@sub.example.co.uk")).toBe(true);
    expect(validateEmail("no-at-sign")).toBe(false);
    expect(validateEmail("two@@signs.com")).toBe(false);
  });

  it("accepts plausible hostnames", () => {
    expect(validateHostname("example.com")).toBe(true);
    expect(validateHostname("sub.example.com.")).toBe(true);
    expect(validateHostname("-bad.example.com")).toBe(false);
    expect(validateHostname("")).toBe(false);
  });

  it("accepts internationalized email (RFC 6531)", () => {
    // ajv-formats #66: idn-email should accept non-ASCII local part and
    // IDN domains. Samples from the Wikipedia internationalized-email
    // article.
    expect(validateIdnEmail("用户@例子.广告")).toBe(true);
    expect(validateIdnEmail("чебурашка@ящик-с-апельсинами.рф")).toBe(true);
    expect(validateIdnEmail("Dörte@Sörensen.example.com")).toBe(true);
    // Still needs an @ and a non-empty local/domain.
    expect(validateIdnEmail("用户例子.广告")).toBe(false);
    expect(validateIdnEmail("@例子.广告")).toBe(false);
  });
});

describe("ipv4 / ipv6", () => {
  it("accepts well-formed ipv4", () => {
    expect(validateIpv4("192.168.1.1")).toBe(true);
    expect(validateIpv4("0.0.0.0")).toBe(true);
    expect(validateIpv4("255.255.255.255")).toBe(true);
    expect(validateIpv4("256.1.1.1")).toBe(false);
    expect(validateIpv4("1.1.1")).toBe(false);
  });

  it("accepts well-formed ipv6", () => {
    expect(validateIpv6("2001:db8::1")).toBe(true);
    expect(validateIpv6("::1")).toBe(true);
    expect(validateIpv6("::")).toBe(true);
    expect(validateIpv6("::ffff:192.0.2.1")).toBe(true);
    expect(validateIpv6("2001:db8::")).toBe(true);
    expect(validateIpv6("2001:db8:::1")).toBe(false);
    expect(validateIpv6("not-ipv6")).toBe(false);
  });
});

describe("uri / uri-reference / uri-template", () => {
  it("accepts absolute URIs", () => {
    expect(validateUri("https://example.com/path?q=1#frag")).toBe(true);
    expect(validateUri("mailto:user@example.com")).toBe(true);
    expect(validateUri("/relative/path")).toBe(false);
  });

  it("accepts uri-references (absolute or relative)", () => {
    expect(validateUriReference("/relative/path")).toBe(true);
    expect(validateUriReference("https://example.com/")).toBe(true);
  });

  it("accepts RFC 6570 uri-templates", () => {
    expect(validateUriTemplate("/pets/{id}")).toBe(true);
    expect(validateUriTemplate("/search{?q,page}")).toBe(true);
    expect(validateUriTemplate("/pets/{id/")).toBe(false);
  });
});

describe("json-pointer", () => {
  it("accepts RFC 6901 pointers", () => {
    expect(validateJsonPointer("")).toBe(true);
    expect(validateJsonPointer("/foo/bar")).toBe(true);
    expect(validateJsonPointer("/foo~0bar~1baz")).toBe(true);
    expect(validateJsonPointer("foo")).toBe(false);
  });

  it("accepts relative pointers", () => {
    expect(validateRelativeJsonPointer("0")).toBe(true);
    expect(validateRelativeJsonPointer("2/foo/bar")).toBe(true);
    expect(validateRelativeJsonPointer("0#")).toBe(true);
    expect(validateRelativeJsonPointer("/foo")).toBe(false);
  });
});

describe("regex / uuid", () => {
  it("accepts compilable regexes", () => {
    expect(validateRegex("^x$")).toBe(true);
    expect(validateRegex("(unclosed")).toBe(false);
  });

  it("accepts RFC 4122 uuids", () => {
    expect(validateUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(validateUuid("not-a-uuid")).toBe(false);
  });
});

describe("builtInFormats map", () => {
  it("exposes every string format by name, as a bare function", () => {
    const keys = [
      "date-time",
      "date",
      "time",
      "duration",
      "email",
      "idn-email",
      "hostname",
      "idn-hostname",
      "ipv4",
      "ipv6",
      "uri",
      "uri-reference",
      "iri",
      "iri-reference",
      "uri-template",
      "json-pointer",
      "relative-json-pointer",
      "uuid",
    ];
    // The bare-function shorthand, so a string format's entry is the
    // predicate itself and reads the way it always has.
    for (const k of keys) expect(typeof builtInFormats[k]).toBe("function");
  });

  it("exposes the numeric formats with a declared type", () => {
    expect(builtInFormats["int32"]).toEqual({ type: "number", validate: validateInt32 });
    expect(builtInFormats["int64"]).toEqual({ type: "number", validate: validateInt64 });
  });

  it("does not include float or double", () => {
    // Deliberate: every JSON number is already a double, and a
    // Math.fround-based float rejects values a producer legitimately
    // sent.
    expect(builtInFormats["float"]).toBeUndefined();
    expect(builtInFormats["double"]).toBeUndefined();
  });

  it("does not include `regex` (registered by @oaverify/internal-schema's createDeps)", () => {
    expect(builtInFormats["regex"]).toBeUndefined();
  });
});

describe("normalizeFormat", () => {
  it("reads a bare function as a string format", () => {
    const fn = (v: string): boolean => v === "x";
    expect(normalizeFormat(fn)).toEqual({ type: "string", validate: fn });
  });

  it("reads a bare function as a string format even for a numeric built-in name", () => {
    // No name-based inference: the caller wrote a bare function, so it
    // is a string format, and there is no table that says otherwise.
    const fn = ((): boolean => true) as (value: string) => boolean;
    expect(normalizeFormat(fn)?.type).toBe("string");
  });

  it("carries a declared type through", () => {
    const validate = (n: number): boolean => n > 0;
    expect(normalizeFormat({ type: "number", validate })).toEqual({ type: "number", validate });
  });

  it("reads false as registered-and-asserting-nothing", () => {
    // null, not undefined: a caller asking "is this registered" has to
    // tell a deliberate opt-out from a name nobody mentioned.
    expect(normalizeFormat(false)).toBeNull();
  });
});

describe("int32 / int64", () => {
  it("accepts the int32 range and rejects either side of it", () => {
    expect(validateInt32(0)).toBe(true);
    expect(validateInt32(-2147483648)).toBe(true);
    expect(validateInt32(2147483647)).toBe(true);
    expect(validateInt32(-2147483649)).toBe(false);
    expect(validateInt32(2147483648)).toBe(false);
    expect(validateInt32(3000000000)).toBe(false);
  });

  it("rejects a non-integer number under int32", () => {
    expect(validateInt32(1.5)).toBe(false);
    expect(validateInt32(NaN)).toBe(false);
    expect(validateInt32(Infinity)).toBe(false);
  });

  it("accepts int64 over the safe-integer range", () => {
    expect(validateInt64(0)).toBe(true);
    expect(validateInt64(3000000000)).toBe(true);
    expect(validateInt64(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(validateInt64(Number.MIN_SAFE_INTEGER)).toBe(true);
  });

  it("rejects an int64 above 2^53, which JSON has already rounded", () => {
    // Legal int64, illegal JSON number: JSON.parse("9223372036854775807")
    // yields a different value than the one on the wire, and this is
    // the range where that starts.
    expect(validateInt64(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(validateInt64(Number.MIN_SAFE_INTEGER - 1)).toBe(false);
  });

  it("rejects a non-integer number under int64", () => {
    expect(validateInt64(1.5)).toBe(false);
    expect(validateInt64(NaN)).toBe(false);
    expect(validateInt64(Infinity)).toBe(false);
  });
});

describe("fromAjvFormats", () => {
  const asString = (def: FormatDefinition | undefined): ((v: string) => boolean) => {
    const n = def === undefined ? null : normalizeFormat(def);
    expect(n?.type).toBe("string");
    return n?.validate as unknown as (v: string) => boolean;
  };

  it("converts Ajv-shaped definitions to declared format definitions", () => {
    const result = fromAjvFormats({
      duration: { type: "string", validate: (v) => typeof v === "string" && v.startsWith("P") },
    });
    expect(asString(result.duration)("P1D")).toBe(true);
    expect(asString(result.duration)("1D")).toBe(false);
  });

  it("coerces truthy non-boolean returns to true", () => {
    const result = fromAjvFormats({
      truthy: {
        validate: (v) => (typeof v === "string" && v.length > 0 ? 1 : 0) as unknown as boolean,
      },
    });
    expect(asString(result.truthy)("x")).toBe(true);
    expect(asString(result.truthy)("")).toBe(false);
  });

  it("treats an entry without `type` as a string format, as Ajv does", () => {
    const result = fromAjvFormats({ anything: { validate: () => true } });
    expect(normalizeFormat(result.anything!)?.type).toBe("string");
  });

  it('carries `type: "number"` through as a numeric format', () => {
    // Before numeric formats existed this entry landed in the string
    // map and was called with strings.
    const result = fromAjvFormats({
      "x-count": { type: "number", validate: (v) => typeof v === "number" && v > 0 },
    });
    const n = normalizeFormat(result["x-count"]!);
    expect(n?.type).toBe("number");
    const validate = n?.validate as unknown as (v: number) => boolean;
    expect(validate(1)).toBe(true);
    expect(validate(0)).toBe(false);
  });

  it("hands back a map directly usable by createValidator / compileSchema", () => {
    const ajvMap = { foo: { type: "string" as const, validate: (v: unknown) => v === "foo" } };
    const formats = fromAjvFormats(ajvMap);
    expect(Object.keys(formats)).toEqual(["foo"]);
    expect(asString(formats.foo)("foo")).toBe(true);
    expect(asString(formats.foo)("bar")).toBe(false);
  });
});

describe("uri (js/polynomial-redos regression)", () => {
  it("still accepts and rejects the same values after the regex was flattened", () => {
    // The scheme pre-filter dropped a redundant `(?:\/\/[^\s]*)?` group.
    // These pin the boundaries the group might plausibly have been holding.
    for (const ok of [
      "http://example.com",
      "https://a.b/c?d=e#f",
      "mailto:a@b.c",
      "urn:isbn:0451450523",
      "file:///tmp/x",
      "ftp://u:p@h:21/p",
      "a+b-c.d:e//f",
    ]) {
      expect(validateUri(ok), ok).toBe(true);
    }
    for (const bad of [
      "//example.com", // no scheme
      "://x",
      "1http://x", // scheme must start with a letter
      "-a:b",
      "http://x y", // interior whitespace
      "http://x ", // trailing whitespace
      " http://x",
      "/relative/path",
    ]) {
      expect(validateUri(bad), bad).toBe(false);
    }
  });

  it("stays linear on a long non-matching authority", () => {
    // The old pattern had two adjacent unbounded [^\s]* after the scheme.
    // A trailing space makes the overall match fail, forcing the engine to
    // redistribute the split across them: quadratic. At this size the old
    // path takes tens of seconds; the flattened one is sub-millisecond.
    const value = `A://${"!".repeat(200_000)} `;
    const started = performance.now();
    expect(validateUri(value)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

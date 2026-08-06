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
  validateIri,
  validateIriReference,
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

describe("uri / iri (RFC 3986 and RFC 3987 grammar)", () => {
  // A host that looks like a dotted-decimal address but is not one is
  // still a legal `reg-name`, because `IPv4address` is a subset of
  // `reg-name`. `new URL` rejected both of these, which under the
  // OpenAPI dialects refused real traffic.
  it("accepts a dotted-decimal host that is not a valid IPv4 address", () => {
    for (const value of [
      "http://087.10.0.1/",
      "http://999.999.999.999/",
      "http://1.2.3.4.5/",
      "http://0300.0250.0.1/",
    ]) {
      expect(validateUri(value), value).toBe(true);
      expect(validateUriReference(value), value).toBe(true);
    }
  });

  it("still accepts genuine IPv4 and IPv6 hosts", () => {
    expect(validateUri("http://127.0.0.1:8080/x")).toBe(true);
    expect(validateUri("http://[2001:db8::1]/x")).toBe(true);
    expect(validateUri("http://[::ffff:192.0.2.1]/x")).toBe(true);
    expect(validateUri("http://[v7.aBc:1]/x")).toBe(true);
  });

  it("rejects an unterminated IP-literal host", () => {
    expect(validateUri("https://[@example.org/test.txt")).toBe(false);
    expect(validateUri("http://[2001:db8::1/x")).toBe(false);
    expect(validateUri("http://[not-an-address]/x")).toBe(false);
  });

  // `new URL` percent-encoded these instead of rejecting them, so every
  // one was accepted before.
  it("rejects characters the grammar excludes", () => {
    for (const value of [
      "https://example.org/foobar®.txt",
      "https://example.org/foobar\\.txt",
      'https://example.org/foobar".txt',
      "https://example.org/foobar<>.txt",
      "https://example.org/foobar{}.txt",
      "https://example.org/foobar^.txt",
      "https://example.org/foobar`.txt",
      "https://example.org/foobar|.txt",
    ]) {
      expect(validateUri(value), value).toBe(false);
    }
  });

  it("rejects malformed percent-encoding", () => {
    expect(validateUri("http://example.com/%6G")).toBe(false);
    expect(validateUri("http://example.com/%A")).toBe(false);
    expect(validateUri("http://example.com/%")).toBe(false);
    expect(validateUri("http://example.com/%41")).toBe(true);
  });

  it("rejects a backslash in a uri-reference path or fragment", () => {
    expect(validateUriReference("\\\\WINDOWS\\fileshare")).toBe(false);
    expect(validateUriReference("#frag\\ment")).toBe(false);
  });

  // RFC 3987 widens `unreserved` to `iunreserved`, so non-ASCII is legal
  // in an IRI where it is not in a URI. A backslash is excluded by both.
  it("accepts non-ASCII in an iri but not a backslash", () => {
    expect(validateIri("https://example.org/foobar®.txt")).toBe(true);
    expect(validateIriReference("/föö/bär")).toBe(true);
    expect(validateIriReference("#ƒräg\\mênt")).toBe(false);
    expect(validateIriReference("\\\\WINDOWS\\filëré")).toBe(false);
  });

  it("keeps the iri and uri grammars distinct", () => {
    const nonAscii = "https://example.org/é";
    expect(validateIri(nonAscii)).toBe(true);
    expect(validateUri(nonAscii)).toBe(false);
  });

  it("requires a scheme for the absolute forms only", () => {
    expect(validateUri("/relative/path")).toBe(false);
    expect(validateIri("/relative/path")).toBe(false);
    expect(validateUriReference("/relative/path")).toBe(true);
    expect(validateIriReference("/relative/path")).toBe(true);
  });

  it("accepts an empty reference and a bare query or fragment", () => {
    expect(validateUriReference("")).toBe(true);
    expect(validateUriReference("?q=1")).toBe(true);
    expect(validateUriReference("#frag")).toBe(true);
    expect(validateUriReference("//example.com/path")).toBe(true);
  });

  // `segment-nz-nc` forbids a colon in the *first* segment of a relative
  // reference, so a string whose leading segment looks like a scheme but
  // is not a legal one cannot fall back to being read as a path.
  it("forbids a colon in the first segment of a relative reference", () => {
    expect(validateUriReference("1foo:bar")).toBe(false);
    expect(validateUriReference("./foo:bar")).toBe(true);
    expect(validateUriReference("foo:bar")).toBe(true);
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

  // Types refuse all of these, so the callers that reach here are
  // JavaScript and a map deserialized from configuration. Falling
  // through would produce a format with no `validate`, which asserts
  // nothing: a disabled format arrived at by accident, and silent.
  it.each([
    ["true", true],
    ["a number", 42],
    ["a string", "int32"],
    ["null", null],
    ["an object missing validate", { type: "number" }],
    ["an object with an unknown type", { type: "integer", validate: (): boolean => true }],
  ])("refuses %s", (_label, bad) => {
    expect(() => normalizeFormat(bad as unknown as FormatDefinition)).toThrow(
      /format definition must be a function/,
    );
  });

  it("names false as the way to register without asserting", () => {
    // The message has to answer "then how do I turn one off", because
    // reaching for `true` is what someone does when they mean exactly
    // that.
    expect(() => normalizeFormat(true as unknown as FormatDefinition)).toThrow(/use false/);
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

describe("leap seconds and UTC offsets", () => {
  // A leap second is only ever inserted at the end of a UTC day, so
  // whether `:60` is legal depends on the instant rather than on the
  // digits. Each of these spells 23:59:60Z in a different local time.
  it.each([
    ["23:59:60Z", "Zulu"],
    ["23:59:60+00:00", "zero offset"],
    ["15:59:60-08:00", "negative offset"],
    ["01:29:60+01:30", "positive offset, crossing midnight backwards"],
    ["00:29:60-23:30", "maximum negative offset"],
    ["23:29:60+23:30", "maximum positive offset"],
  ])("accepts %s (%s)", (value) => {
    expect(validateTime(value)).toBe(true);
  });

  it.each([
    ["22:59:60Z", "wrong hour"],
    ["23:58:60Z", "wrong minute"],
    ["22:59:60+00:00", "wrong hour, zero offset"],
    ["23:58:60+00:00", "wrong minute, zero offset"],
    ["23:59:60+01:00", "local 23:59 but 22:59 UTC"],
    ["23:59:60+00:30", "local 23:59 but 23:29 UTC"],
    ["23:59:60-01:00", "local 23:59 but 00:59 UTC"],
    ["23:59:60-00:30", "local 23:59 but 00:29 UTC"],
  ])("rejects %s (%s)", (value) => {
    expect(validateTime(value)).toBe(false);
  });

  it("bounds the offset's own fields", () => {
    expect(validateTime("01:02:03+24:00")).toBe(false);
    expect(validateTime("01:02:03+00:60")).toBe(false);
    expect(validateTime("01:02:03+23:59")).toBe(true);
  });

  it("applies the same rule to date-time", () => {
    expect(validateDateTime("1998-12-31T23:59:60Z")).toBe(true);
    expect(validateDateTime("1998-12-31T15:59:60.123-08:00")).toBe(true);
    expect(validateDateTime("1998-12-31T22:59:60Z")).toBe(false);
    expect(validateDateTime("1998-12-31T23:58:60Z")).toBe(false);
    expect(validateDateTime("1990-12-31T15:59:59-24:00")).toBe(false);
    expect(validateDateTime("1990-12-31T10:00:00+10:60")).toBe(false);
  });

  it("leaves ordinary times alone", () => {
    expect(validateTime("12:34:56Z")).toBe(true);
    expect(validateTime("12:34:56+02:00")).toBe(true);
    expect(validateDateTime("2024-01-31T12:34:56-05:00")).toBe(true);
  });
});

import { normalizeFormat, type FormatDefinition } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import {
  builtInFormats,
  fromAjvFormats,
  validateDate,
  validateDateTime,
  validateDateTimeLocal,
  validateDuration,
  validateEmail,
  validateHostname,
  validateIdnHostname,
  validateHttpDate,
  validateIdnEmail,
  validateBase64Url,
  validateByte,
  validateByteRfc4648,
  validateChar,
  validateDoubleInt,
  validateInt16,
  validateInt32,
  validateInt64,
  validateInt8,
  validateIpv4,
  validateIpv4Cidr,
  validateIpv6,
  validateIpv6Cidr,
  validateIri,
  validateIriReference,
  validateJsonPointer,
  validateLanguage,
  validateMediaRange,
  validateRegex,
  validateRelativeJsonPointer,
  validateTime,
  validateTimeLocal,
  validateUnixtime,
  validateUri,
  validateUriReference,
  validateUriTemplate,
  validateUint16,
  validateUint32,
  validateUint64,
  validateUint8,
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

  it("accepts RFC 3339 durations", () => {
    expect(validateDuration("P1Y")).toBe(true);
    expect(validateDuration("P1Y2M10DT2H30M")).toBe(true);
    expect(validateDuration("P")).toBe(false);
    expect(validateDuration("PT")).toBe(false);
    expect(validateDuration("nope")).toBe(false);
  });
});

describe("duration (RFC 3339 ABNF ordering)", () => {
  // Each unit carries only the next smaller one, so an absent middle
  // unit is a syntax error rather than an implied zero.
  it("requires the intervening unit", () => {
    expect(validateDuration("P1Y2M3D")).toBe(true);
    expect(validateDuration("P1Y2D")).toBe(false);
    expect(validateDuration("PT1H2M3S")).toBe(true);
    expect(validateDuration("PT1H2S")).toBe(false);
  });

  it("keeps each unit optional at the outside", () => {
    for (const value of ["P1Y", "P1M", "P1D", "PT1H", "PT1M", "PT1S", "P1M2D", "PT2M3S"]) {
      expect(validateDuration(value), value).toBe(true);
    }
  });

  // `dur-week` is its own top-level alternative, so it combines with
  // nothing: not another date unit, not a zero-valued one, not a time.
  it("only accepts weeks alone", () => {
    expect(validateDuration("P1W")).toBe(true);
    expect(validateDuration("P1Y2W")).toBe(false);
    expect(validateDuration("P0Y1W")).toBe(false);
    expect(validateDuration("P1WT1H")).toBe(false);
    expect(validateDuration("P1W2D")).toBe(false);
  });

  it("rejects a fractional component", () => {
    expect(validateDuration("PT0.5S")).toBe(false);
    expect(validateDuration("PT1.5H")).toBe(false);
    expect(validateDuration("P0.5Y")).toBe(false);
  });

  it("rejects a sign, an exponent, and stray whitespace", () => {
    expect(validateDuration("-P1Y")).toBe(false);
    expect(validateDuration("P-1Y")).toBe(false);
    expect(validateDuration("P1e3Y")).toBe(false);
    expect(validateDuration("P1Y\n")).toBe(false);
    expect(validateDuration("P1D T1H")).toBe(false);
  });

  it("rejects a bare number with no unit", () => {
    expect(validateDuration("P1")).toBe(false);
    expect(validateDuration("P1T1H")).toBe(false);
    expect(validateDuration("PT1")).toBe(false);
  });

  it("accepts multi-digit and zero components", () => {
    expect(validateDuration("P100Y")).toBe(true);
    expect(validateDuration("P0D")).toBe(true);
    expect(validateDuration("PT0S")).toBe(true);
    expect(validateDuration("P0W")).toBe(true);
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

describe("email (RFC 5321 Mailbox grammar)", () => {
  const DQ = '"';
  const BACKSLASH = String.fromCharCode(92);
  const BEL = String.fromCharCode(7);

  // A quoted local part is the one place a space, a double dot and a
  // second `@` are all legal. The unquoted form forbids each of them,
  // which is why the two shapes are checked separately.
  it("accepts a quoted local part", () => {
    expect(validateEmail(`${DQ}joe bloggs${DQ}@example.com`)).toBe(true);
    expect(validateEmail(`${DQ}joe..bloggs${DQ}@example.com`)).toBe(true);
    expect(validateEmail(`${DQ}joe@bloggs${DQ}@example.com`)).toBe(true);
    expect(validateEmail(`${DQ}${DQ}@example.com`)).toBe(true);
  });

  it("keeps the Dot-string rules for an unquoted local part", () => {
    expect(validateEmail("te.s.t@example.com")).toBe(true);
    expect(validateEmail("te..st@example.com")).toBe(false);
    expect(validateEmail(".test@example.com")).toBe(false);
    expect(validateEmail("test.@example.com")).toBe(false);
    expect(validateEmail("joe bloggs@example.com")).toBe(false);
  });

  it("applies quoted-pair rules inside a quoted local part", () => {
    expect(validateEmail(`${DQ}a${BACKSLASH}${DQ}b${DQ}@example.com`)).toBe(true);
    expect(validateEmail(`${DQ}a${DQ}b${DQ}@example.com`)).toBe(false);
    expect(validateEmail(`${DQ}a${BEL}b${DQ}@example.com`)).toBe(false);
    expect(validateEmail(`${DQ}a${BACKSLASH}${DQ}@example.com`)).toBe(false);
  });

  it("accepts an address-literal domain", () => {
    expect(validateEmail("joe.bloggs@[127.0.0.1]")).toBe(true);
    expect(validateEmail("joe.bloggs@[IPv6:::1]")).toBe(true);
    expect(validateEmail("joe.bloggs@[IPv6:2001:db8::1]")).toBe(true);
  });

  it("rejects an address literal that is not an address", () => {
    expect(validateEmail("joe.bloggs@[127.0.0.300]")).toBe(false);
    // The `IPv6:` tag is mandatory, and no General-address-literal tag
    // has been registered, so a bare bracketed IPv6 address is not one.
    expect(validateEmail("joe.bloggs@[::1]")).toBe(false);
    expect(validateEmail("joe.bloggs@[anything]")).toBe(false);
  });

  it("rejects a header or a list rather than a single mailbox", () => {
    expect(validateEmail("user1@oceania.org, user2@oceania.org")).toBe(false);
    expect(
      validateEmail(`${DQ}Winston Smith${DQ} <winston.smith@recdep.minitrue> (Records Department)`),
    ).toBe(false);
  });

  it("widens qtext to non-ASCII for idn-email only", () => {
    expect(validateIdnEmail(`${DQ}δοκιμή${DQ}@example.com`)).toBe(true);
    expect(validateEmail(`${DQ}δοκιμή${DQ}@example.com`)).toBe(false);
    expect(validateIdnEmail(`${DQ}\u{1D54F}${DQ}@example.com`)).toBe(true);
    // The double quote and the backslash stay excluded when the range
    // widens, which a single `]`-to-U+10FFFF range would have lost.
    expect(validateIdnEmail(`${DQ}a${DQ}b${DQ}@example.com`)).toBe(false);
  });

  it("rejects a domain that ends in a dot", () => {
    // `hostname` accepts `iana.org.`: RFC 1123 allows the root label
    // written out. RFC 5321's `Domain` production has no such form, so
    // delegating without saying so inherited an allowance that is not a
    // mailbox's (#944). Both entry points, since both delegate.
    expect(validateEmail("test@iana.org.")).toBe(false);
    expect(validateIdnEmail("test@iana.org.")).toBe(false);
    expect(validateEmail("test@iana.org")).toBe(true);
    expect(validateIdnEmail("test@iana.org")).toBe(true);
  });

  it("reads the address-literal tag case-insensitively", () => {
    // An ABNF string literal is case-insensitive (RFC 5234 section 2.3),
    // so every spelling of the tag is the same production. Matching
    // `IPv6:` exactly sent the rest to the IPv4 branch, which refused a
    // legal address literal (#944).
    expect(validateEmail("joe.bloggs@[ipv6:::1]")).toBe(true);
    expect(validateEmail("joe.bloggs@[IPV6:::1]")).toBe(true);
    expect(validateEmail("joe.bloggs@[iPv6:2001:db8::1]")).toBe(true);
    expect(validateEmail("joe.bloggs@[ipv6:anything]")).toBe(false);
  });

  it("widens an unquoted idn local part to non-ASCII, including whitespace", () => {
    // `UTF8-non-ascii` admits any non-ASCII character, and a character
    // being whitespace in Unicode does not remove it from that set. The
    // old class drew its boundary at whitespace, which is not the
    // boundary `atext` draws, so it refused these (#901).
    expect(validateIdnEmail("a\u00A0b@example.com")).toBe(true);
    expect(validateIdnEmail("a\u2003b@example.com")).toBe(true);
    expect(validateIdnEmail("a\u3000b@example.com")).toBe(true);
    // The ASCII space is still not atext, quoted or nothing.
    expect(validateIdnEmail("a b@example.com")).toBe(false);
  });

  it("keeps atext's ASCII specials out of an unquoted idn local part", () => {
    // The same class was too permissive in the other direction: it
    // admitted every ASCII special that is not whitespace, `@` or `.`,
    // all of which `atext` excludes and which need quoting (#853).
    for (const special of ["(", ")", ",", "<", ">", "[", "]", ":", ";"]) {
      expect(validateIdnEmail(`a${special}b@example.com`), special).toBe(false);
    }
    // Quoted, they are legal, which is what makes the unquoted refusal a
    // narrowing rather than a ban.
    expect(validateIdnEmail(`${DQ}a(b${DQ}@example.com`)).toBe(true);
    // And the atext punctuation stays accepted.
    expect(validateIdnEmail("a!#$%&'*+/=?^_`{|}~-b@example.com")).toBe(true);
  });

  it("caps a local part at 64 characters", () => {
    expect(validateEmail(`${"a".repeat(64)}@example.com`)).toBe(true);
    expect(validateEmail(`${"a".repeat(65)}@example.com`)).toBe(false);
  });

  it("caps an idn local part at 64 octets, not 64 UTF-16 units", () => {
    // RFC 5321's limit is octets, which RFC 6531 does not relax. Each
    // CJK character below is 3 UTF-8 octets, so 22 of them (66 octets)
    // must be rejected even though they are only 22 UTF-16 units;
    // 21 (63 octets) fit.
    expect(validateIdnEmail(`${"用".repeat(21)}@example.com`)).toBe(true);
    expect(validateIdnEmail(`${"用".repeat(22)}@example.com`)).toBe(false);
  });
});

describe("hostname: labels, marks, and where the length cap is measured", () => {
  // Real IANA-delegated IDN ccTLDs whose scripts write with combining
  // marks. Every label under these was refused before, because the label
  // class admitted letters and digits and not marks. RFC 5892 derives
  // marks as PVALID and RFC 5891 section 4.2.3.2 constrains them in one
  // position only, the first.
  const MARK_CARRYING_TLDS = ["भारत", "বাংলা", "ලංකා", "భారత్", "ਭਾਰਤ", "ഭാരതം", "இந்தியா", "ไทย"];

  it("accepts a label carrying a combining mark", () => {
    for (const tld of MARK_CARRYING_TLDS) {
      expect(validateIdnHostname(tld), tld).toBe(true);
      expect(validateIdnHostname(`www.${tld}`), tld).toBe(true);
    }
    expect(validateIdnEmail("user@हिन्दी.भारत")).toBe(true);
  });

  it("still refuses a label that begins with a combining mark", () => {
    // The one position RFC 5891 constrains. Admitting marks everywhere
    // would have been the easy over-correction.
    expect(validateIdnHostname("\u093Eअ")).toBe(false);
    expect(validateIdnHostname("\u0301abc")).toBe(false);
    // A mark anywhere else, including last, is ordinary.
    expect(validateIdnHostname("अ\u093E")).toBe(true);
  });

  it("keeps the hyphen rules while admitting marks", () => {
    expect(validateIdnHostname("-a")).toBe(false);
    expect(validateIdnHostname("a-")).toBe(false);
    expect(validateIdnHostname("a-b")).toBe(true);
  });

  it("measures the 253-character cap without the root dot", () => {
    // The dot is a separator, not part of the name, so writing the root
    // label out cannot change the verdict. Measuring before stripping it
    // made these two disagree.
    const name253 = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
    expect(name253).toHaveLength(253);
    expect(validateHostname(name253)).toBe(true);
    expect(validateHostname(`${name253}.`)).toBe(true);
    const name254 = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62)].join(".");
    expect(validateHostname(name254)).toBe(false);
    expect(validateHostname(`${name254}.`)).toBe(false);
  });
});

describe("email / idn-email: the pair rule", () => {
  // AGENTS.md: names that pair let a reader predict one from the other.
  // `idn-email` widens the ALPHABET of `email`. It must not widen the
  // length bound, and it must not narrow anything.
  //
  // Two defects have now come from the mailbox inheriting an allowance
  // that belongs to a hostname grammar and not to RFC 5321 `Domain`: the
  // root dot (#944) and the total length cap. Both entry points delegate
  // to a different hostname validator, so a rule fixed on one path is
  // silently absent from the other. These are the class, not the two
  // instances.
  const LOCALS = ["a", "user", "first.last", '"quoted local"', "a!#$%&'*+/=?^_`{|}~-b"];
  const DOMAINS = [
    "example.com",
    "a.b.c.example.com",
    "xn--fiqs8s",
    "[127.0.0.1]",
    "[IPv6:::1]",
    "[ipv6:::1]",
    "example.com.",
    ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join("."),
    ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62)].join("."),
  ];

  it("agrees with email on every ASCII mailbox, in both directions", () => {
    // Equality rather than superset: on input with no non-ASCII
    // character there is nothing for the widened alphabet to admit, so
    // any disagreement is a rule living on one path and not the other.
    let checked = 0;
    for (const local of LOCALS) {
      for (const domain of DOMAINS) {
        const address = `${local}@${domain}`;
        checked += 1;
        expect(validateIdnEmail(address), address).toBe(validateEmail(address));
      }
    }
    // Pinned, not bounded: a generator that loses an axis fails here
    // rather than shrinking quietly (#753).
    expect(checked).toBe(45);
  });

  it("caps the domain on both paths, at the same length", () => {
    const at253 = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
    const at254 = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62)].join(".");
    expect(validateEmail(`u@${at253}`)).toBe(true);
    expect(validateIdnEmail(`u@${at253}`)).toBe(true);
    expect(validateEmail(`u@${at254}`)).toBe(false);
    expect(validateIdnEmail(`u@${at254}`)).toBe(false);
    // `idn-hostname` itself still has no cap, deliberately: its limit is
    // on the encoded form it does not compute (#669). The cap is the
    // mailbox's, which is why it lives in the mailbox path.
    expect(validateIdnHostname(at254)).toBe(true);
  });

  it("refuses a root dot on both paths, where the hostname pair accepts it", () => {
    expect(validateHostname("iana.org.")).toBe(true);
    expect(validateIdnHostname("iana.org.")).toBe(true);
    expect(validateEmail("a@iana.org.")).toBe(false);
    expect(validateIdnEmail("a@iana.org.")).toBe(false);
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

  it("reads a varname as varchar *( [.] varchar )", () => {
    // A dot has to be followed by a varchar, so consecutive dots are not a
    // varname. The old pattern was `[A-Za-z0-9_][A-Za-z0-9_.]*`, which let
    // any run of dots through, including a trailing one.
    expect(validateUriTemplate("{a.b}")).toBe(true);
    expect(validateUriTemplate("{a..b}")).toBe(false);
    expect(validateUriTemplate("{a.}")).toBe(false);
    expect(validateUriTemplate("{.a}")).toBe(true); // "." here is the operator
    // A pct-encoded triplet is a varchar, in any position.
    expect(validateUriTemplate("{%41}")).toBe(true);
    expect(validateUriTemplate("{a%41b}")).toBe(true);
    expect(validateUriTemplate("{%4}")).toBe(false);
    expect(validateUriTemplate("{%zz}")).toBe(false);
  });

  it("takes the literal range as far as %x7E, and no further", () => {
    // The literal set stops at "~", so DEL is excluded along with C0. The
    // apostrophe is a literal: it falls in the gap the ABNF's %x26 / %x28-3B
    // span leaves, which errata correct and the suite tests as valid.
    expect(validateUriTemplate("a'b")).toBe(true);
    expect(validateUriTemplate("a~b")).toBe(true);
    expect(validateUriTemplate("ab")).toBe(false);
    expect(validateUriTemplate("a b")).toBe(false);
    expect(validateUriTemplate("ab")).toBe(false);
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

  // ABNF literals are case-insensitive (RFC 5234 2.3), so the `"v"` of
  // `IPvFuture` admits either case. One builder serves all four
  // validators, so a lowercase-only `v` was wrong in each; only the IRI
  // suite carries an upstream case for it.
  it("accepts an IPvFuture host with either case of version letter", () => {
    for (const value of ["http://[v1.fe]", "http://[V1.fe]", "http://[V7.aBc:1]/x"]) {
      expect(validateUri(value), value).toBe(true);
      expect(validateUriReference(value), value).toBe(true);
      expect(validateIri(value), value).toBe(true);
      expect(validateIriReference(value), value).toBe(true);
    }
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
      "date-time-local",
      "time-local",
      "http-date",
      "ipv4-cidr",
      "ipv6-cidr",
    ];
    // The bare-function shorthand, so a string format's entry is the
    // predicate itself and reads the way it always has.
    for (const k of keys) expect(typeof builtInFormats[k]).toBe("function");
  });

  it("exposes the numeric formats with a declared type", () => {
    expect(builtInFormats["int32"]).toEqual({ type: "number", validate: validateInt32 });
    expect(builtInFormats["int64"]).toEqual({ type: "number", validate: validateInt64 });
    expect(builtInFormats["uint64"]).toEqual({ type: "number", validate: validateUint64 });
    expect(builtInFormats["double-int"]).toEqual({
      type: "number",
      validate: validateDoubleInt,
    });
  });

  it("exposes every registry width, so none is left reading as a vendor name", () => {
    const widths = ["int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64"];
    for (const name of widths) {
      expect(builtInFormats[name], name).toMatchObject({ type: "number" });
    }
  });

  it("exposes byte, base64url and char as bare string formats", () => {
    for (const name of ["byte", "base64url", "char"]) {
      expect(typeof builtInFormats[name], name).toBe("function");
    }
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

describe("the exact integer widths", () => {
  const widths: [string, (value: number) => boolean, number, number][] = [
    ["int8", validateInt8, -128, 127],
    ["int16", validateInt16, -32768, 32767],
    ["int32", validateInt32, -2147483648, 2147483647],
    ["uint8", validateUint8, 0, 255],
    ["uint16", validateUint16, 0, 65535],
    ["uint32", validateUint32, 0, 4294967295],
  ];

  it.each(widths)("accepts the %s range and rejects either side of it", (_n, fn, min, max) => {
    expect(fn(min)).toBe(true);
    expect(fn(max)).toBe(true);
    expect(fn(min - 1)).toBe(false);
    expect(fn(max + 1)).toBe(false);
  });

  it.each(widths)("rejects a non-integer under %s", (_n, fn, min) => {
    expect(fn(min + 0.5)).toBe(false);
  });

  it("rejects a negative under every unsigned width", () => {
    expect(validateUint8(-1)).toBe(false);
    expect(validateUint16(-1)).toBe(false);
    expect(validateUint32(-1)).toBe(false);
    expect(validateUint64(-1)).toBe(false);
  });
});

describe("the exact widths: bounds, and the containment between them", () => {
  // The six exact widths delegate to one `inRange`, so the rule is in one
  // place. The bounds are still six pairs of hand-typed literals, and a
  // wrong bound looks exactly like a right one. These derive them.
  const SIGNED: Array<[number, (v: number) => boolean]> = [
    [8, validateInt8],
    [16, validateInt16],
    [32, validateInt32],
  ];
  const UNSIGNED: Array<[number, (v: number) => boolean]> = [
    [8, validateUint8],
    [16, validateUint16],
    [32, validateUint32],
  ];

  it("puts each signed width's boundary exactly where the width says", () => {
    for (const [bits, validate] of SIGNED) {
      const min = -(2 ** (bits - 1));
      const max = 2 ** (bits - 1) - 1;
      expect(validate(min), `int${bits} min`).toBe(true);
      expect(validate(max), `int${bits} max`).toBe(true);
      expect(validate(min - 1), `int${bits} min-1`).toBe(false);
      expect(validate(max + 1), `int${bits} max+1`).toBe(false);
    }
  });

  it("puts each unsigned width's boundary exactly where the width says", () => {
    for (const [bits, validate] of UNSIGNED) {
      const max = 2 ** bits - 1;
      expect(validate(0), `uint${bits} zero`).toBe(true);
      expect(validate(max), `uint${bits} max`).toBe(true);
      expect(validate(-1), `uint${bits} below zero`).toBe(false);
      expect(validate(max + 1), `uint${bits} max+1`).toBe(false);
    }
  });

  it("nests the widths, so a narrower value is always valid in a wider one", () => {
    // 64 is deliberately absent: it is the safe-integer range rather than
    // the width, which the module note explains, so it is not a member of
    // this progression.
    const probes = [0, 1, -1, 127, -128, 32767, -32768, 2147483647, -2147483648, 255, 65535];
    for (const v of probes) {
      if (validateInt8(v)) expect(validateInt16(v), `int8 ${v} in int16`).toBe(true);
      if (validateInt16(v)) expect(validateInt32(v), `int16 ${v} in int32`).toBe(true);
      if (validateUint8(v)) expect(validateUint16(v), `uint8 ${v} in uint16`).toBe(true);
      if (validateUint16(v)) expect(validateUint32(v), `uint16 ${v} in uint32`).toBe(true);
      // An unsigned value is a signed value of the next width up.
      if (validateUint8(v)) expect(validateInt16(v), `uint8 ${v} in int16`).toBe(true);
      if (validateUint16(v)) expect(validateInt32(v), `uint16 ${v} in int32`).toBe(true);
    }
  });
});

describe("uint64 / double-int", () => {
  it("bounds uint64 at the safe-integer ceiling, not 2^64", () => {
    // Same reasoning as int64: a JSON number above 2^53 is provably
    // not the value that was on the wire.
    expect(validateUint64(0)).toBe(true);
    expect(validateUint64(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(validateUint64(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it("rejects a negative under uint64, which is the whole difference from int64", () => {
    expect(validateInt64(-5)).toBe(true);
    expect(validateUint64(-5)).toBe(false);
  });

  it("accepts exactly the losslessly-representable integers under double-int", () => {
    expect(validateDoubleInt(0)).toBe(true);
    expect(validateDoubleInt(-Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(validateDoubleInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(validateDoubleInt(1.5)).toBe(false);
    expect(validateDoubleInt(Number.NaN)).toBe(false);
    expect(validateDoubleInt(Number.POSITIVE_INFINITY)).toBe(false);
  });

  // The safe-integer range is where n and n+1 are both representable,
  // which is a different question from the one this format asks. Every
  // even integer up to 2^54 is exactly representable, every multiple of
  // 4 up to 2^55.
  it("accepts representable integers above the safe-integer range under double-int", () => {
    for (const n of [2 ** 53, 2 ** 53 + 2, -(2 ** 53), 2 ** 54 + 4, 1e21]) {
      expect(validateDoubleInt(n)).toBe(true);
    }
  });

  // What the widened range costs, pinned where it bites. A literal too
  // fine for a double is rounded by the time any validator runs, so
  // double-int now accepts the neighbour it arrives as. The literal was
  // not a double-int before rounding either, which is why this is not
  // int64's situation: there the literal was itself a legal int64.
  it("accepts a too-fine literal as the double it arrives as", () => {
    expect(JSON.parse("9007199254740993")).toBe(2 ** 53);
    expect(validateDoubleInt(JSON.parse("9007199254740993"))).toBe(true);
    expect(validateInt64(JSON.parse("9223372036854775807"))).toBe(false);
  });

  // int64 draws its ceiling where it does because the format names a
  // range wider than a double carries, so a value past 2^53 is provably
  // not the one that was sent. double-int names the doubles themselves,
  // so that argument does not reach it.
  it("parts from int64 above the safe-integer range", () => {
    expect(validateInt64(2 ** 53)).toBe(false);
    expect(validateUint64(2 ** 53)).toBe(false);
    expect(validateDoubleInt(2 ** 53)).toBe(true);
  });
});

describe("byte / base64url", () => {
  it("accepts padded standard base64", () => {
    expect(validateByte("")).toBe(true);
    expect(validateByte("aGVsbG8=")).toBe(true); // "hello"
    expect(validateByte("aGVsbG8h")).toBe(true); // "hello!", no padding needed
    expect(validateByte("YQ==")).toBe(true); // "a"
  });

  it("rejects a byte value whose length is not a multiple of four", () => {
    expect(validateByte("aGVsbG8")).toBe(false);
    expect(validateByte("YQ=")).toBe(false);
  });

  it("rejects the URL-safe alphabet under byte", () => {
    expect(validateByte("a-b_")).toBe(false);
  });

  it("accepts line-wrapped base64 under byte", () => {
    // #705: RFC 2045 wraps at 76 columns. Whitespace carries no data and
    // the value decodes to the same bytes, so rejecting it fails a
    // request over a formatting choice and catches nothing.
    expect(validateByte("aGVs\nbG8h")).toBe(true);
    expect(validateByte("aGVs bG8h")).toBe(true);
    expect(validateByte("aGVs\r\nbG8h")).toBe(true);
    expect(validateByte("aGVs\tbG8h")).toBe(true);
    // Stripping whitespace does not excuse the rest: the alphabet and
    // the padding are still checked on what remains.
    expect(validateByte("aGVs\nbG8")).toBe(false);
    expect(validateByte("aGVs\nbG8!")).toBe(false);
  });

  it("rejects whitespace that base64 decoding does not skip", () => {
    // The stripped set is WHATWG ASCII whitespace, which is what `atob`
    // skips. A value carrying anything outside it does not decode, so
    // accepting it would turn a clean rejection into a failure further
    // downstream. Pins the set against a widening to `\s`.
    for (const ws of ["\v", "\u00a0", "\u2028", "\ufeff"]) {
      expect(validateByte(`aGVs${ws}bG8h`)).toBe(false);
      expect(() => atob(`aGVs${ws}bG8h`)).toThrow();
    }
  });

  it("accepts a whitespace-only value, as it accepts the empty string", () => {
    // Recorded rather than emergent: `byte` does not check for content,
    // and "" passed before this change too. `minLength` is the tool for
    // requiring content.
    expect(validateByte("")).toBe(true);
    expect(validateByte("  \n")).toBe(true);
  });

  it("validateByteRfc4648 is the strict reading, for registering by hand", () => {
    // #705: the literal reading of the registry's plain RFC 4648
    // citation, shipped as a named export rather than as the built-in.
    expect(validateByteRfc4648("aGVsbG8h")).toBe(true);
    expect(validateByteRfc4648("aGVs\nbG8h")).toBe(false);
    expect(validateByteRfc4648("aGVs bG8h")).toBe(false);
    // Everything the built-in rejects, it rejects too.
    expect(validateByteRfc4648("aGVsbG8")).toBe(false);
    expect(validateByteRfc4648("a-b_")).toBe(false);
  });

  it("accepts base64url padded or unpadded", () => {
    expect(validateBase64Url("aGVsbG8")).toBe(true); // unpadded, as a JWT segment
    expect(validateBase64Url("aGVsbG8=")).toBe(true);
    expect(validateBase64Url("a-b_")).toBe(true);
  });

  it("rejects the standard alphabet under base64url", () => {
    // The mistake this format is most useful for catching.
    expect(validateBase64Url("a+b/")).toBe(false);
  });

  it("accepts non-canonical trailing pad bits, deliberately", () => {
    // RFC 4648 section 3.5 wants the unused bits of a partial final
    // group zeroed, and "cE6=" does not satisfy that: it fails a
    // decode/re-encode round trip. Catching it would mean decoding
    // every value on the hot path for a case no encoder emits.
    expect(Buffer.from("cE6=", "base64").toString("base64")).not.toBe("cE6=");
    expect(validateByte("cE6=")).toBe(true);
  });
});

describe("char", () => {
  it("accepts exactly one code point", () => {
    expect(validateChar("a")).toBe(true);
    expect(validateChar("é")).toBe(true);
  });

  it("accepts an astral character despite its two UTF-16 units", () => {
    expect("🎉".length).toBe(2);
    expect(validateChar("🎉")).toBe(true);
  });

  it("rejects the empty string and anything longer than one code point", () => {
    expect(validateChar("")).toBe(false);
    expect(validateChar("ab")).toBe(false);
  });

  it("rejects a combining sequence, which is two code points", () => {
    // The grapheme-cluster reading would accept this; the registry
    // does not ask for it, and code points are predictable.
    expect(validateChar("é")).toBe(false);
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

describe("time-local / date-time-local", () => {
  it("accepts an offsetless wall-clock time", () => {
    expect(validateTimeLocal("12:34:56")).toBe(true);
    expect(validateTimeLocal("00:00:00")).toBe(true);
    expect(validateTimeLocal("23:59:59.999")).toBe(true);
  });

  it("rejects a time-local carrying the offset the name drops", () => {
    expect(validateTimeLocal("12:34:56Z")).toBe(false);
    expect(validateTimeLocal("12:34:56+02:00")).toBe(false);
  });

  it("rejects an out-of-range field under time-local", () => {
    expect(validateTimeLocal("24:00:00")).toBe(false);
    expect(validateTimeLocal("12:60:00")).toBe(false);
    expect(validateTimeLocal("12:34:61")).toBe(false);
    expect(validateTimeLocal("2:34:56")).toBe(false);
  });

  it("accepts :60 at any minute, because no offset means no instant to place", () => {
    // 15:59:60 is a real leap second on a -08:00 clock and 05:44:60
    // is one on +05:45, so the position rule validateTime applies
    // would reject correct values here.
    expect(validateTimeLocal("23:59:60")).toBe(true);
    expect(validateTimeLocal("15:59:60")).toBe(true);
    expect(validateTimeLocal("12:34:60")).toBe(true);
    // The offset-bearing sibling still applies the rule.
    expect(validateTime("12:34:60Z")).toBe(false);
  });

  it("accepts an offsetless date-time", () => {
    expect(validateDateTimeLocal("2024-01-31T12:34:56")).toBe(true);
    expect(validateDateTimeLocal("2024-02-29T00:00:00.5")).toBe(true);
    // RFC 3339 §5.6 NOTE allows a lowercase separator, and the
    // offset-bearing sibling has always taken one.
    expect(validateDateTimeLocal("2024-01-31t12:34:56")).toBe(true);
  });

  it("rejects a date-time-local carrying an offset, and a bare date", () => {
    expect(validateDateTimeLocal("2024-01-31T12:34:56Z")).toBe(false);
    expect(validateDateTimeLocal("2024-01-31T12:34:56-05:00")).toBe(false);
    expect(validateDateTimeLocal("2024-01-31")).toBe(false);
  });

  it("checks the calendar under date-time-local", () => {
    expect(validateDateTimeLocal("2023-02-29T00:00:00")).toBe(false);
    expect(validateDateTimeLocal("2024-13-01T00:00:00")).toBe(false);
  });
});

describe("ipv4-cidr / ipv6-cidr", () => {
  it("accepts an address with a prefix length in range", () => {
    expect(validateIpv4Cidr("192.0.2.0/24")).toBe(true);
    expect(validateIpv4Cidr("0.0.0.0/0")).toBe(true);
    expect(validateIpv4Cidr("255.255.255.255/32")).toBe(true);
    expect(validateIpv6Cidr("2001:db8::/32")).toBe(true);
    expect(validateIpv6Cidr("::/0")).toBe(true);
    expect(validateIpv6Cidr("::ffff:192.0.2.1/128")).toBe(true);
  });

  it("rejects a prefix length past the address width", () => {
    expect(validateIpv4Cidr("192.0.2.0/33")).toBe(false);
    expect(validateIpv6Cidr("2001:db8::/129")).toBe(false);
  });

  it("rejects a bare address, and a malformed prefix", () => {
    expect(validateIpv4Cidr("192.0.2.0")).toBe(false);
    expect(validateIpv6Cidr("2001:db8::")).toBe(false);
    expect(validateIpv4Cidr("192.0.2.0/")).toBe(false);
    expect(validateIpv4Cidr("192.0.2.0/08")).toBe(false);
    expect(validateIpv4Cidr("192.0.2.0/+8")).toBe(false);
    expect(validateIpv4Cidr("192.0.2.0/ 8")).toBe(false);
    expect(validateIpv4Cidr("192.0.2.0/24/24")).toBe(false);
  });

  it("rejects a malformed address under an in-range prefix", () => {
    expect(validateIpv4Cidr("192.0.2.256/24")).toBe(false);
    expect(validateIpv4Cidr("192.0.2/24")).toBe(false);
    expect(validateIpv6Cidr("2001:db8:::/32")).toBe(false);
  });

  it("accepts host bits outside the prefix", () => {
    // The notation names an address and a prefix length; masking is
    // the reader's business, and "this interface, in a /24" is a
    // normal thing to write.
    expect(validateIpv4Cidr("192.0.2.1/24")).toBe(true);
    expect(validateIpv6Cidr("2001:db8::1/32")).toBe(true);
  });
});

describe("http-date", () => {
  it("accepts IMF-fixdate, the form a sender must produce", () => {
    expect(validateHttpDate("Sun, 06 Nov 1994 08:49:37 GMT")).toBe(true);
    expect(validateHttpDate("Thu, 29 Feb 2024 00:00:00 GMT")).toBe(true);
  });

  it("accepts the two obsolete forms the HTTP-date production still admits", () => {
    expect(validateHttpDate("Sunday, 06-Nov-94 08:49:37 GMT")).toBe(true);
    expect(validateHttpDate("Sun Nov  6 08:49:37 1994")).toBe(true);
    expect(validateHttpDate("Sun Nov 16 08:49:37 1994")).toBe(true);
  });

  it("rejects a form no HTTP-date grammar admits", () => {
    expect(validateHttpDate("1994-11-06T08:49:37Z")).toBe(false);
    expect(validateHttpDate("Sun, 06 Nov 1994 08:49:37")).toBe(false);
    expect(validateHttpDate("Sun, 06 Nov 1994 08:49:37 UTC")).toBe(false);
    expect(validateHttpDate("06 Nov 1994 08:49:37 GMT")).toBe(false);
    expect(validateHttpDate("Sun, 6 Nov 1994 08:49:37 GMT")).toBe(false);
    // asctime's date3 spells a single-digit day "SP 1DIGIT", so one
    // space and one digit is a different string from two spaces.
    expect(validateHttpDate("Sun Nov 6 08:49:37 1994")).toBe(false);
    // The RFC 850 form takes a two-digit year and the long day name;
    // neither half borrows from IMF-fixdate.
    expect(validateHttpDate("Sunday, 06-Nov-1994 08:49:37 GMT")).toBe(false);
    expect(validateHttpDate("Sun, 06-Nov-94 08:49:37 GMT")).toBe(false);
    expect(validateHttpDate("")).toBe(false);
  });

  it("rejects lowercase, because every literal in the grammar is case-sensitive", () => {
    expect(validateHttpDate("sun, 06 nov 1994 08:49:37 GMT")).toBe(false);
    expect(validateHttpDate("Sun, 06 Nov 1994 08:49:37 gmt")).toBe(false);
  });

  it("checks the calendar and the clock", () => {
    expect(validateHttpDate("Thu, 29 Feb 2023 00:00:00 GMT")).toBe(false);
    expect(validateHttpDate("Sun, 31 Nov 1994 08:49:37 GMT")).toBe(false);
    expect(validateHttpDate("Sun, 06 Nov 1994 24:00:00 GMT")).toBe(false);
    expect(validateHttpDate("Sun, 06 Nov 1994 08:60:00 GMT")).toBe(false);
    // 60 seconds is a leap second, which a Date field can name.
    expect(validateHttpDate("Sun, 06 Nov 1994 23:59:60 GMT")).toBe(true);
  });

  it("does not check the day name against the date", () => {
    // 6 Nov 1994 was a Sunday. Nothing in RFC 7231 asks a recipient
    // to verify the day name, and a mismatch is a clerical error
    // rather than a value the reader cannot use.
    expect(validateHttpDate("Mon, 06 Nov 1994 08:49:37 GMT")).toBe(true);
  });

  it("treats February as 29 days under a two-digit year, so the verdict is clock-free", () => {
    expect(validateHttpDate("Sunday, 29-Feb-24 00:00:00 GMT")).toBe(true);
    expect(validateHttpDate("Sunday, 30-Feb-24 00:00:00 GMT")).toBe(false);
  });
});

describe("unixtime", () => {
  it("accepts integer seconds either side of the epoch", () => {
    expect(validateUnixtime(0)).toBe(true);
    expect(validateUnixtime(1700000000)).toBe(true);
    expect(validateUnixtime(-86400)).toBe(true);
  });

  it("rejects a fractional count, and one past the safe-integer ceiling", () => {
    expect(validateUnixtime(1700000000.5)).toBe(false);
    expect(validateUnixtime(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(validateUnixtime(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(validateUnixtime(Number.NaN)).toBe(false);
  });

  it("is a numeric format, so a string unixtime is not asserted", () => {
    expect(builtInFormats["unixtime"]).toEqual({ type: "number", validate: validateUnixtime });
  });
});

describe("language", () => {
  it("accepts the shapes a real document uses", () => {
    expect(validateLanguage("en")).toBe(true);
    expect(validateLanguage("en-US")).toBe(true);
    expect(validateLanguage("zh-Hant-CN")).toBe(true);
    expect(validateLanguage("es-419")).toBe(true);
    expect(validateLanguage("de-CH-1901")).toBe(true);
    expect(validateLanguage("sl-rozaj-biske")).toBe(true);
    expect(validateLanguage("hy-Latn-IT-arevela")).toBe(true);
  });

  it("accepts a language of every length the grammar allows", () => {
    expect(validateLanguage("de")).toBe(true);
    expect(validateLanguage("cel")).toBe(true);
    // 4ALPHA is reserved for future use and 5*8ALPHA is registered;
    // both are well-formed today.
    expect(validateLanguage("abcd")).toBe(true);
    expect(validateLanguage("abcdefgh")).toBe(true);
    expect(validateLanguage("a")).toBe(false);
    expect(validateLanguage("abcdefghi")).toBe(false);
  });

  it("accepts extlang subtags, up to the three the ABNF allows", () => {
    expect(validateLanguage("zh-cmn")).toBe(true);
    expect(validateLanguage("zh-min-nan")).toBe(true);
    expect(validateLanguage("zh-aaa-bbb-ccc")).toBe(true);
    expect(validateLanguage("zh-aaa-bbb-ccc-ddd")).toBe(false);
  });

  it("accepts extensions, and requires each singleton to carry a body", () => {
    expect(validateLanguage("de-DE-u-co-phonebk")).toBe(true);
    expect(validateLanguage("en-a-bbb-c-ddd")).toBe(true);
    expect(validateLanguage("en-a")).toBe(false);
    expect(validateLanguage("en-a-b")).toBe(false);
  });

  it("accepts private use, alone and appended", () => {
    expect(validateLanguage("x-whatever")).toBe(true);
    expect(validateLanguage("x-a-b-c")).toBe(true);
    expect(validateLanguage("en-US-x-twain")).toBe(true);
    expect(validateLanguage("en-a-bbb-x-private")).toBe(true);
    // A singleton is any letter or digit except x, in either case, so
    // this is private use rather than a one-letter extension whose
    // body is too short.
    expect(validateLanguage("en-X-a")).toBe(true);
    expect(validateLanguage("x")).toBe(false);
    expect(validateLanguage("en-x")).toBe(false);
  });

  it("rejects a repeated variant or extension singleton", () => {
    // RFC 5646 2.2.5 and 2.2.6. Case does not distinguish two subtags.
    expect(validateLanguage("de-1901-1901")).toBe(false);
    expect(validateLanguage("sl-rozaj-ROZAJ")).toBe(false);
    expect(validateLanguage("en-a-bbb-a-ccc")).toBe(false);
    expect(validateLanguage("en-a-bbb-A-ccc")).toBe(false);
  });

  it("rejects a subtag in the wrong position", () => {
    expect(validateLanguage("en-US-GB")).toBe(false);
    expect(validateLanguage("en-Latn-Cyrl")).toBe(false);
    expect(validateLanguage("419-en")).toBe(false);
  });

  it("rejects a malformed tag outright", () => {
    expect(validateLanguage("")).toBe(false);
    expect(validateLanguage("-en")).toBe(false);
    expect(validateLanguage("en-")).toBe(false);
    expect(validateLanguage("en--US")).toBe(false);
    expect(validateLanguage("en_US")).toBe(false);
    expect(validateLanguage("en US")).toBe(false);
    expect(validateLanguage("en-US!")).toBe(false);
  });

  it("ignores case, which RFC 5646 says carries no meaning", () => {
    expect(validateLanguage("EN-latn-gb")).toBe(true);
    expect(validateLanguage("en-latn-GB")).toBe(true);
  });

  it("accepts grandfathered tags, irregular from a table and regular by parsing", () => {
    for (const tag of ["i-klingon", "en-GB-oed", "sgn-BE-FR", "I-Klingon"]) {
      expect(validateLanguage(tag), tag).toBe(true);
    }
    for (const tag of [
      "art-lojban",
      "cel-gaulish",
      "no-bok",
      "no-nyn",
      "zh-guoyu",
      "zh-hakka",
      "zh-min",
      "zh-min-nan",
      "zh-xiang",
    ]) {
      expect(validateLanguage(tag), tag).toBe(true);
    }
  });

  it("does not check a subtag against the IANA registry", () => {
    // Well-formedness only: qq is not a language and ZZ is not a
    // region, and both sit in legal positions.
    expect(validateLanguage("qq-ZZ")).toBe(true);
  });
});

describe("language: the cases RFC 5646 names by hand", () => {
  it("accepts a repeated singleton when the second one is inside private use", () => {
    // Section 2.2.6 rule 3 gives this exact tag. It works because the
    // "x" is taken as private use before the singleton loop sees it,
    // so moving that check would break it silently.
    expect(validateLanguage("en-a-bbb-x-a-ccc")).toBe(true);
    expect(validateLanguage("en-x-a-a")).toBe(true);
  });

  it("accepts a tag that fills every position at once", () => {
    // Appendix A: language, script, region, variant, extension and
    // private use, in one tag.
    expect(validateLanguage("en-Latn-GB-boont-r-extended-sequence-x-private")).toBe(true);
  });

  it("rejects the malformed examples the RFC lists", () => {
    // 2.2.6 rule 6: an extension needs a body of two or more.
    expect(validateLanguage("tlh-a-b-foo")).toBe(false);
    // Two regions.
    expect(validateLanguage("de-419-DE")).toBe(false);
    // 2.2.6 rule 1: a tag cannot begin with an extension.
    expect(validateLanguage("a-DE")).toBe(false);
  });
});

describe("media-range", () => {
  it("accepts a plain media type", () => {
    expect(validateMediaRange("application/json")).toBe(true);
    expect(validateMediaRange("text/plain")).toBe(true);
    expect(validateMediaRange("application/vnd.api+json")).toBe(true);
    expect(validateMediaRange("application/x-www-form-urlencoded")).toBe(true);
  });

  it("accepts every wildcard shape the grammar derives", () => {
    expect(validateMediaRange("*/*")).toBe(true);
    expect(validateMediaRange("text/*")).toBe(true);
    // Denotes nothing, and the ABNF still derives it: "*" is a tchar,
    // so the `type "/" subtype` alternative covers it. Rejecting it
    // would be overruling the specification the format name cites.
    expect(validateMediaRange("*/plain")).toBe(true);
  });

  it("rejects anything that is not two tokens around one slash", () => {
    expect(validateMediaRange("")).toBe(false);
    expect(validateMediaRange("json")).toBe(false);
    expect(validateMediaRange("/json")).toBe(false);
    expect(validateMediaRange("text/")).toBe(false);
    expect(validateMediaRange("text/plain/extra")).toBe(false);
    expect(validateMediaRange("text plain")).toBe(false);
    expect(validateMediaRange("text/pl ain")).toBe(false);
    expect(validateMediaRange("te(xt)/plain")).toBe(false);
  });

  it("accepts parameters, quoted and bare", () => {
    expect(validateMediaRange("text/html;charset=utf-8")).toBe(true);
    expect(validateMediaRange('text/html;charset="utf-8"')).toBe(true);
    expect(validateMediaRange("multipart/form-data;boundary=--abc;charset=utf-8")).toBe(true);
    expect(validateMediaRange('text/html;title="a;b"')).toBe(true);
    expect(validateMediaRange('text/html;title="say \\"hi\\""')).toBe(true);
  });

  it("takes OWS before the semicolon and after it, and nowhere else", () => {
    expect(validateMediaRange("text/html ;charset=utf-8")).toBe(true);
    expect(validateMediaRange("text/html; charset=utf-8")).toBe(true);
    expect(validateMediaRange("text/html \t; \tcharset=utf-8")).toBe(true);
    // `parameter` puts no OWS around its "=".
    expect(validateMediaRange("text/html;charset =utf-8")).toBe(false);
    expect(validateMediaRange("text/html;charset= utf-8")).toBe(false);
    // Trailing OWS is not part of the production.
    expect(validateMediaRange("text/html ")).toBe(false);
    expect(validateMediaRange(" text/html")).toBe(false);
  });

  it("accepts an empty parameter, which the grammar makes optional", () => {
    // parameters = *( OWS ";" OWS [ parameter ] ), so a stray
    // separator parses rather than failing.
    expect(validateMediaRange("text/html;")).toBe(true);
    expect(validateMediaRange("text/html;;charset=utf-8")).toBe(true);
    expect(validateMediaRange("text/html; ; charset=utf-8")).toBe(true);
    expect(validateMediaRange("text/html; ")).toBe(true);
  });

  it("rejects a malformed parameter", () => {
    expect(validateMediaRange("text/html;charset")).toBe(false);
    expect(validateMediaRange("text/html;=utf-8")).toBe(false);
    expect(validateMediaRange("text/html;charset=")).toBe(false);
    expect(validateMediaRange("text/html;charset=utf 8")).toBe(false);
    expect(validateMediaRange("text/html,charset=utf-8")).toBe(false);
  });

  it("rejects a quoted string that never closes, or escapes nothing", () => {
    expect(validateMediaRange('text/html;title="unterminated')).toBe(false);
    // The closing quote is escaped, so the string never ends.
    expect(validateMediaRange('text/html;title="trailing\\"')).toBe(false);
    expect(validateMediaRange('text/html;title="bad\\')).toBe(false);
    // A raw control character is not qdtext, escaped or not.
    expect(validateMediaRange('text/html;title="a\u0001b"')).toBe(false);
    expect(validateMediaRange('text/html;title="a\\\u0001b"')).toBe(false);
  });

  it("reads a quality value as an ordinary parameter", () => {
    // RFC 9110 separates `weight` from `media-range` in the Accept
    // grammar, above the level this format names.
    expect(validateMediaRange("text/html;q=0.8")).toBe(true);
  });

  it("takes obs-text in a quoted string, but only as a single octet", () => {
    expect(validateMediaRange('text/html;title="café"')).toBe(true);
    // Above U+00FF no single octet spells it.
    expect(validateMediaRange('text/html;title="☃"')).toBe(false);
  });
});

describe("media-range: the boundaries of tchar and quoted-string", () => {
  it("accepts every tchar in a type and a subtype", () => {
    const tchars = "!#$%&'*+-.^_`|~0aZ";
    expect(validateMediaRange(`${tchars}/${tchars}`)).toBe(true);
  });

  it("rejects obs-text outside a quoted string, where tchar is ASCII only", () => {
    expect(validateMediaRange("café/plain")).toBe(false);
    expect(validateMediaRange("text/html;é=b")).toBe(false);
    expect(validateMediaRange("text/html;a=é")).toBe(false);
  });

  it("accepts an empty quoted value, and rejects junk after the closing quote", () => {
    expect(validateMediaRange('text/html;a=""')).toBe(true);
    expect(validateMediaRange('text/html;a="b"c')).toBe(false);
  });

  it("escapes what quoted-pair reaches, and no more", () => {
    expect(validateMediaRange('text/html;a="x\ty"')).toBe(true);
    expect(validateMediaRange('text/html;a="\\\t"')).toBe(true);
    expect(validateMediaRange('text/html;a="\\é"')).toBe(true);
    // DEL is neither qdtext nor a quoted-pair tail.
    expect(validateMediaRange('text/html;a="\u007F"')).toBe(false);
    expect(validateMediaRange('text/html;a="\\\u007F"')).toBe(false);
  });
});

describe("uri-template literals (RFC 6570)", () => {
  it("accepts the templates it always did", () => {
    expect(validateUriTemplate("/pets/{id}")).toBe(true);
    expect(validateUriTemplate("/search{?q,page}")).toBe(true);
    expect(validateUriTemplate("/a%41b")).toBe(true);
    expect(validateUriTemplate("/{+path}/here")).toBe(true);
    expect(validateUriTemplate("/中文")).toBe(true);
  });

  it("accepts a ucschar the `\\s` class excluded", () => {
    // RFC 6570 literals include `ucschar`, which starts at U+00A0, and
    // every `\s` member above U+009F is legal there. Sampled rather than
    // exhaustive: U+2000-200A is a uniform block, so its endpoints
    // stand for the eleven. Each is spelled by code point rather than
    // pasted, so the case survives an editor normalizing whitespace
    // (#854).
    const legal = [0x00a0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
    for (const cp of legal) {
      expect(validateUriTemplate(`/a${String.fromCharCode(cp)}b`), `U+${cp.toString(16)}`).toBe(
        true,
      );
    }
  });

  it("still rejects the space, the C0 controls and DEL", () => {
    // U+0020 is excluded by the ABNF. The C0 controls and DEL come from
    // the explicit U+0000-U+001F and U+007F ranges beside it, not from
    // `\s`, so removing `\s` leaves them rejected.
    expect(validateUriTemplate("/a b")).toBe(false);
    for (const cp of [0x00, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1f, 0x7f]) {
      expect(validateUriTemplate(`/a${String.fromCharCode(cp)}b`), `U+${cp.toString(16)}`).toBe(
        false,
      );
    }
  });

  it("still rejects the other excluded literals and a malformed expression", () => {
    for (const s of ['/a"b', "/a<b", "/a>b", "/a\\b", "/a^b", "/a`b", "/a|b", "/a{", "/a}b"]) {
      expect(validateUriTemplate(s), s).toBe(false);
    }
    // `%` is excluded from the class so that only the pct-encoded
    // alternative can accept one. Nothing else asserted it, so dropping
    // it from the class passed the whole suite.
    expect(validateUriTemplate("/a%zz")).toBe(false);
    expect(validateUriTemplate("/a%41b")).toBe(true);
  });

  it("accepts an astral literal", () => {
    expect(validateUriTemplate("/a\u{1f600}b")).toBe(true);
  });

  it("does not reject a lone surrogate, which the `u` flag does not change", () => {
    // Recorded rather than asserted as correct. RFC 6570's `ucschar`
    // excludes the surrogate range, so a stricter reading would reject
    // this; the class only excludes ASCII, so nothing here tests it.
    // The `u` flag makes no difference for the same reason: the class
    // excludes only ASCII, so both surrogate halves of an astral
    // character sit outside it exactly as the whole code point does.
    // (A sweep over BMP code points would not show this either way; one
    // BMP code point is one UTF-16 unit, so the two modes agree there
    // by construction.)
    expect(validateUriTemplate(`/a${String.fromCharCode(0xd800)}b`)).toBe(true);
  });
});

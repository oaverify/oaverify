/**
 * RFC 3986 (URI) and RFC 3987 (IRI) format validators.
 *
 * @packageDocumentation
 */

// These four validators match the RFC 3986 / RFC 3987 grammars directly.
// They used to delegate to `new URL()`, which cannot do this job in
// either direction, because WHATWG URL is a parser with repairs and not
// a grammar checker:
//
//   - Too strict on the host. For a "special" scheme it interprets a
//     dotted-decimal host as an IPv4 address and throws when the octets
//     do not parse, so it rejected `http://087.10.0.1/` and
//     `http://999.999.999.999/`. RFC 3986 asks for no such thing:
//     `IPv4address` is a strict *subset* of `reg-name`, so a host that
//     looks like an address but is not one is still a legal reg-name.
//     That subset relation is why `host` below is just
//     `IP-literal / reg-name` with no IPv4 branch.
//   - Too loose on everything after it. It silently percent-encodes
//     characters the grammar excludes rather than rejecting them
//     (`foobar<>.txt` becomes `foobar%3C%3E.txt`), rewrites `\` to `/`
//     for special schemes, moves a stray `[` into userinfo as `%5B`,
//     and passes malformed percent-encoding (`%6G`, `%A`, a lone `%`)
//     straight through.
//
// No pre-filter or post-check around `new URL` can fix the first class,
// because the rejection happens inside it. Hence the grammar.
//
// ReDoS: every alternation here is prefix-disjoint (`%` introduces only
// the pct-encoded branch, `[` only the IP-literal branch), so a failing
// match has no split to redistribute across two unbounded quantifiers.
// That is the hazard the previous pre-filter was written to avoid, and
// the `js/polynomial-redos` block in `test/formats.test.ts` still pins
// it: format validators run on untrusted request values, so a quadratic
// path here is a usable DoS vector.

/**
 * Compose the RFC 3986 grammar, optionally widened to RFC 3987.
 *
 * `ucschar` widens `unreserved` to `iunreserved`, and `iprivate` is
 * legal in a query only. Passing empty strings yields the ASCII
 * (RFC 3986) grammar, which is why one builder serves both pairs.
 */
function buildUriGrammar(
  ucschar: string,
  iprivate: string,
): { absolute: RegExp; reference: RegExp } {
  const unreserved = `A-Za-z0-9\\-._~${ucschar}`;
  const subDelims = "!$&'()*+,;=";
  const pctEncoded = "%[0-9A-Fa-f]{2}";
  // `unreserved / sub-delims / pct-encoded`, plus whatever the position adds.
  const charsOf = (extra: string) => `(?:[${unreserved}${subDelims}${extra}]|${pctEncoded})`;
  const pchar = charsOf(":@");

  const h16 = "[0-9A-Fa-f]{1,4}";
  const decOctet = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
  const ipv4 = `${decOctet}(?:\\.${decOctet}){3}`;
  const ls32 = `(?:${h16}:${h16}|${ipv4})`;
  // The nine IPv6 forms of RFC 3986 Appendix A, in order.
  const ipv6 = [
    `(?:${h16}:){6}${ls32}`,
    `::(?:${h16}:){5}${ls32}`,
    `(?:${h16})?::(?:${h16}:){4}${ls32}`,
    `(?:(?:${h16}:){0,1}${h16})?::(?:${h16}:){3}${ls32}`,
    `(?:(?:${h16}:){0,2}${h16})?::(?:${h16}:){2}${ls32}`,
    `(?:(?:${h16}:){0,3}${h16})?::${h16}:${ls32}`,
    `(?:(?:${h16}:){0,4}${h16})?::${ls32}`,
    `(?:(?:${h16}:){0,5}${h16})?::${h16}`,
    `(?:(?:${h16}:){0,6}${h16})?::`,
  ].join("|");
  // `[vV]`, not `v`: ABNF literals are case-insensitive (RFC 5234 2.3),
  // so the `"v"` of RFC 3986's `IPvFuture` admits either case.
  const ipvFuture = `[vV][0-9A-Fa-f]+\\.[${unreserved}${subDelims}:]+`;
  const ipLiteral = `\\[(?:${ipv6}|${ipvFuture})\\]`;
  // No IPv4 branch: `IPv4address` is a subset of `reg-name`, so reg-name
  // already admits every dotted-decimal host, valid octets or not.
  const regName = `${charsOf("")}*`;
  const host = `(?:${ipLiteral}|${regName})`;
  const authority = `(?:${charsOf(":")}*@)?${host}(?::[0-9]*)?`;

  const segment = `${pchar}*`;
  const pathAbempty = `(?:\\/${segment})*`;
  const pathAbsolute = `\\/(?:${pchar}+${pathAbempty})?`;
  const pathRootless = `${pchar}+${pathAbempty}`;
  // `segment-nz-nc`: no colon, so a first relative segment cannot be
  // mistaken for a scheme.
  const pathNoscheme = `${charsOf("@")}+${pathAbempty}`;

  const query = `(?:${pchar}|[/?${iprivate}])*`;
  const fragment = `(?:${pchar}|[/?])*`;
  const tail = `(?:\\?${query})?(?:#${fragment})?`;

  const scheme = "[A-Za-z][A-Za-z0-9+\\-.]*";
  const hierPart = `(?:\\/\\/${authority}${pathAbempty}|${pathAbsolute}|${pathRootless}|)`;
  const relativePart = `(?:\\/\\/${authority}${pathAbempty}|${pathAbsolute}|${pathNoscheme}|)`;

  return {
    absolute: new RegExp(`^${scheme}:${hierPart}${tail}$`, "u"),
    reference: new RegExp(`^(?:${scheme}:${hierPart}|${relativePart})${tail}$`, "u"),
  };
}

/** RFC 3987 `ucschar`: the private-use planes are excluded (that is `iprivate`). */
const UCSCHAR =
  "\\u00A0-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFEF" +
  "\\u{10000}-\\u{1FFFD}\\u{20000}-\\u{2FFFD}\\u{30000}-\\u{3FFFD}" +
  "\\u{40000}-\\u{4FFFD}\\u{50000}-\\u{5FFFD}\\u{60000}-\\u{6FFFD}" +
  "\\u{70000}-\\u{7FFFD}\\u{80000}-\\u{8FFFD}\\u{90000}-\\u{9FFFD}" +
  "\\u{A0000}-\\u{AFFFD}\\u{B0000}-\\u{BFFFD}\\u{C0000}-\\u{CFFFD}" +
  "\\u{D0000}-\\u{DFFFD}\\u{E1000}-\\u{EFFFD}";

/** RFC 3987 `iprivate`: legal in a query component only. */
const IPRIVATE = "\\uE000-\\uF8FF\\u{F0000}-\\u{FFFFD}\\u{100000}-\\u{10FFFD}";

const URI = buildUriGrammar("", "");
const IRI = buildUriGrammar(UCSCHAR, IPRIVATE);

/**
 * RFC 3986 absolute `uri`.
 *
 * @public
 */
export function validateUri(value: string): boolean {
  return URI.absolute.test(value);
}

/**
 * RFC 3986 `uri-reference` (absolute or relative).
 *
 * @public
 */
export function validateUriReference(value: string): boolean {
  return URI.reference.test(value);
}

/**
 * RFC 3987 `iri`: an absolute `uri` widened to allow `ucschar` wherever
 * RFC 3986 allows `unreserved`, plus `iprivate` in the query.
 *
 * @public
 */
export function validateIri(value: string): boolean {
  return IRI.absolute.test(value);
}

/**
 * RFC 3987 `iri-reference` (absolute or relative IRI).
 *
 * @public
 */
export function validateIriReference(value: string): boolean {
  return IRI.reference.test(value);
}

// Built via RegExp() so oxlint's no-control-regex lint doesn't apply to the
// intentional control-range checks that RFC 6570 requires.
//
// `varchar = ALPHA / DIGIT / "_" / pct-encoded`, and
// `varname = varchar *( ["."] varchar )`. Both halves of the varname rule
// matter and both were wrong: a pct-encoded triplet is a varchar, so `{%41}`
// is a legal template, and a dot has to be *followed* by a varchar, so
// `{a..b}` is not.
const VARCHAR = "(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})";
const VARNAME = `${VARCHAR}(?:\\.?${VARCHAR})*`;
const VARSPEC = `${VARNAME}(?:\\*|:[1-9]\\d{0,3})?`;

// The literal range runs to %x7E, so DEL (%x7F) is excluded alongside C0.
// The apostrophe is a literal: it is absent from the ABNF's %x26 / %x28-3B
// span, which errata correct, and the suite tests it as valid.
const LITERAL = '[^\\u0000-\\u001F\\u007F"%<>\\\\^`{|}\\s]';

const URI_TEMPLATE_RE = new RegExp(
  `^(?:${LITERAL}|%[0-9A-Fa-f]{2}|\\{[+#./;?&]?${VARSPEC}(?:,${VARSPEC})*\\})*$`,
);

/**
 * RFC 6570 `uri-template` (e.g. `"/pets/{id}"`, `"/search{?q,page}"`).
 *
 * @public
 */
export function validateUriTemplate(value: string): boolean {
  return URI_TEMPLATE_RE.test(value);
}

const JSON_POINTER_RE = /^(?:\/(?:[^/~]|~0|~1)*)*$/;
const REL_JSON_POINTER_RE = /^(?:0|[1-9]\d*)(?:#|(?:\/(?:[^/~]|~0|~1)*)*)$/;

/**
 * RFC 6901 `json-pointer`.
 *
 * @public
 */
export function validateJsonPointer(value: string): boolean {
  return JSON_POINTER_RE.test(value);
}

/**
 * draft `relative-json-pointer`.
 *
 * @public
 */
export function validateRelativeJsonPointer(value: string): boolean {
  return REL_JSON_POINTER_RE.test(value);
}

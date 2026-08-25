/**
 * Email format validators, following the RFC 5321 `Mailbox` grammar
 * (RFC 6531 for the internationalized form).
 *
 * @packageDocumentation
 */

import { validateHostname, validateIdnHostname } from "./hostname.js";
import { validateIpv4, validateIpv6 } from "./ip.js";

/**
 * RFC 5321 `atext`: printable ASCII minus the specials.
 *
 * `.` is deliberately absent. It is the separator in `Dot-string` rather
 * than an atext character, which is what makes a leading dot, a trailing
 * dot and a double dot all ill-formed without a separate check for each.
 */
const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~-";

const DOT_STRING_RE = new RegExp(`^[${ATEXT}]+(?:\\.[${ATEXT}]+)*$`);

/**
 * RFC 5321 `qtextSMTP`: printable ASCII except the double quote and the
 * backslash, i.e. `%d32-33 / %d35-91 / %d93-126`.
 */
const QTEXT_ASCII = " !\\u0023-\\u005B\\u005D-\\u007E";

/** RFC 5321 `quoted-pairSMTP`: a backslash followed by any printable ASCII. */
const QUOTED_PAIR = "\\\\[\\u0020-\\u007E]";

/**
 * RFC 5321 `Quoted-string`.
 *
 * A quoted local part is why a space, a double dot and a second `@` can
 * all appear legally. Rejecting that class outright is the easy mistake
 * here, and it rejects addresses the RFC allows.
 */
const QUOTED_STRING_RE = new RegExp(`^"(?:[${QTEXT_ASCII}]|${QUOTED_PAIR})*"$`, "u");

/**
 * RFC 6531 widens `qtextSMTP` with `UTF8-non-ascii`, so the same ASCII
 * shape plus any non-ASCII character.
 *
 * The non-ASCII branch is its own alternative rather than an extension
 * of the ASCII range. Spelling it as one range (`]-\u{10FFFF}`)
 * reads like a widening but silently swallows the double quote and the
 * backslash, and which reading an engine takes is not obvious from
 * looking at it.
 *
 * Lone surrogates are excluded: under `u` a surrogate pair is already a
 * single code point above U+FFFF, so `\uD800-\uDFFF` here matches only
 * an unpaired half, which is not a character and cannot appear in UTF-8.
 */
const IDN_QUOTED_STRING_RE = new RegExp(
  `^"(?:[${QTEXT_ASCII}]|[^\\u0000-\\u007F\\uD800-\\uDFFF]|${QUOTED_PAIR})*"$`,
  "u",
);

/** One `atext` character, or one non-ASCII character. */
const IDN_ATOM = `(?:[${ATEXT}]|[^\\u0000-\\u007F\\uD800-\\uDFFF])`;

/**
 * RFC 6531 unquoted local part: `atext` widened to any non-ASCII, with
 * the same `Dot-string` rules about where a `.` may sit.
 *
 * Built the same way as {@link IDN_QUOTED_STRING_RE}, and for the same
 * reason: the ASCII set and the non-ASCII set are separate alternatives.
 * Spelling it as "anything that is not whitespace, `@` or `.`" reads like
 * the same rule and is wrong in both directions at once, because
 * whitespace is not the boundary `atext` draws. It admitted ASCII that
 * `atext` excludes and that needs quoting (#853), and it excluded
 * non-ASCII whitespace, which `UTF8-non-ascii` admits (#901).
 */
const IDN_DOT_STRING_RE = new RegExp(`^${IDN_ATOM}+(?:\\.${IDN_ATOM}+)*$`, "u");

/** RFC 5321 caps a local part at 64 octets. */
const MAX_LOCAL_LENGTH = 64;

/**
 * Octet counter for the idn path, where code points above U+007F make
 * `String.prototype.length` (UTF-16 units) undercount the UTF-8 wire
 * size the RFC's limit is stated in. The ASCII path skips the encode:
 * there, units and octets agree.
 */
const utf8Octets = (s: string): number => new TextEncoder().encode(s).length;

/**
 * RFC 5321 writes the tag `IPv6:`, and an ABNF string literal is
 * case-insensitive (RFC 5234 section 2.3), so `ipv6:` and `IPV6:` are the
 * same production. Matching the tag exactly sent `a@[ipv6:::1]` to the
 * IPv4 branch, which refuses a legal address literal (#944).
 *
 * No `u` flag, so `i` folds ASCII only: U+212A KELVIN SIGN does not
 * become a `k` here, and no non-ASCII spelling of the tag is admitted.
 */
const IPV6_TAG_RE = /^IPv6:/i;

/** Length of the tag {@link IPV6_TAG_RE} matches, which is fixed. */
const IPV6_TAG_LENGTH = "IPv6:".length;

/**
 * RFC 5321 `address-literal`: a bracketed IPv4 address, or an IPv6
 * address behind the mandatory `IPv6:` tag.
 *
 * `General-address-literal` (`tag:content`, for a standardized future
 * tag) is not accepted. No such tag has been registered, so accepting
 * the shape would admit arbitrary text between brackets.
 */
function validateAddressLiteral(domain: string): boolean {
  if (!domain.startsWith("[") || !domain.endsWith("]")) return false;
  const inner = domain.slice(1, -1);
  if (IPV6_TAG_RE.test(inner)) return validateIpv6(inner.slice(IPV6_TAG_LENGTH));
  return validateIpv4(inner);
}

/**
 * RFC 5321 `Domain`: an address literal, or a hostname.
 *
 * The trailing-dot check belongs here rather than in the hostname
 * validators, which are right to accept `iana.org.`: RFC 1123 allows the
 * root label written out, and that is the grammar `hostname` is judged
 * by. RFC 5321's `Domain` production has no such form, so a mailbox that
 * delegates without saying so inherits an allowance that is not its own
 * (#944).
 */
function validateMailboxDomain(domain: string, hostname: (value: string) => boolean): boolean {
  if (domain.startsWith("[")) return validateAddressLiteral(domain);
  if (domain.endsWith(".")) return false;
  return hostname(domain);
}

/**
 * Split a mailbox at the separator `@`.
 *
 * The **last** `@` is the separator: a domain cannot contain one, so any
 * earlier `@` belongs to a quoted local part.
 */
function splitMailbox(value: string): { local: string; domain: string } | undefined {
  const at = value.lastIndexOf("@");
  if (at < 1 || at >= value.length - 1) return undefined;
  return { local: value.slice(0, at), domain: value.slice(at + 1) };
}

/**
 * RFC 5321 `email`.
 *
 * @public
 */
export function validateEmail(value: string): boolean {
  const parts = splitMailbox(value);
  if (parts === undefined) return false;
  const { local, domain } = parts;
  if (local.length > MAX_LOCAL_LENGTH) return false;
  const localOk = local.startsWith('"') ? QUOTED_STRING_RE.test(local) : DOT_STRING_RE.test(local);
  if (!localOk) return false;
  return validateMailboxDomain(domain, validateHostname);
}

/**
 * RFC 6531 internationalized `email`.
 *
 * @public
 */
export function validateIdnEmail(value: string): boolean {
  const parts = splitMailbox(value);
  if (parts === undefined) return false;
  const { local, domain } = parts;
  if (local.length > MAX_LOCAL_LENGTH || utf8Octets(local) > MAX_LOCAL_LENGTH) return false;
  const localOk = local.startsWith('"')
    ? IDN_QUOTED_STRING_RE.test(local)
    : IDN_DOT_STRING_RE.test(local);
  if (!localOk) return false;
  return validateMailboxDomain(domain, validateIdnHostname);
}

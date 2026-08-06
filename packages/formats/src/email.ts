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
 * all appear legally, which is the class this used to reject outright.
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

/**
 * RFC 6531 unquoted local part: `atext` widened to any non-ASCII, with
 * the same `Dot-string` rules about where a `.` may sit.
 */
const IDN_DOT_STRING_RE = /^[^\s@.]+(?:\.[^\s@.]+)*$/u;

/** RFC 5321 caps a local part at 64 octets. */
const MAX_LOCAL_LENGTH = 64;

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
  if (inner.startsWith("IPv6:")) return validateIpv6(inner.slice("IPv6:".length));
  return validateIpv4(inner);
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
  return domain.startsWith("[") ? validateAddressLiteral(domain) : validateHostname(domain);
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
  if (local.length > MAX_LOCAL_LENGTH) return false;
  const localOk = local.startsWith('"')
    ? IDN_QUOTED_STRING_RE.test(local)
    : IDN_DOT_STRING_RE.test(local);
  if (!localOk) return false;
  return domain.startsWith("[") ? validateAddressLiteral(domain) : validateIdnHostname(domain);
}

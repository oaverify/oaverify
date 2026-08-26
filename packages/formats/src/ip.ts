/**
 * IPv4 / IPv6 format validators, and their CIDR-notation pair.
 *
 * @packageDocumentation
 */

const IPV4_OCTET_RE = /^(?:0|[1-9]\d{0,2})$/;
/** A prefix length: decimal, no leading zeros, so `/08` is rejected. */
const PREFIX_LEN_RE = /^(?:0|[1-9]\d{0,2})$/;

/**
 * RFC 2673 `ipv4` (e.g. `"192.168.1.1"`).
 *
 * @see RFC 2673 section 3.2, https://datatracker.ietf.org/doc/html/rfc2673#section-3.2
 * @public
 */
export function validateIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!IPV4_OCTET_RE.test(p)) return false;
    const n = Number.parseInt(p, 10);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

/**
 * RFC 4291 `ipv6` (e.g. `"2001:db8::1"`). Supports compressed forms and
 * embedded IPv4 (e.g. `"::ffff:192.0.2.1"`).
 *
 * @see RFC 4291 section 2.2, https://datatracker.ietf.org/doc/html/rfc4291#section-2.2
 * @public
 */
export function validateIpv6(value: string): boolean {
  if (value.length === 0 || value.length > 45) return false;
  let addr = value;
  // embedded IPv4
  const lastColon = addr.lastIndexOf(":");
  const tail = lastColon >= 0 ? addr.slice(lastColon + 1) : "";
  if (tail.includes(".")) {
    if (!validateIpv4(tail)) return false;
    addr = addr.slice(0, lastColon + 1) + "0:0";
  }

  const doubleColonCount = (addr.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return false;

  let groups: string[];
  if (doubleColonCount === 1) {
    const [head, tailGroups] = addr.split("::");
    const headParts = head === "" ? [] : (head ?? "").split(":");
    const tailParts = tailGroups === "" ? [] : (tailGroups ?? "").split(":");
    if (headParts.length + tailParts.length >= 8) return false;
    const fill = Array.from({ length: 8 - headParts.length - tailParts.length }, () => "0");
    groups = [...headParts, ...fill, ...tailParts];
  } else {
    groups = addr.split(":");
    if (groups.length !== 8) return false;
  }
  if (groups.length !== 8) return false;
  const GROUP_RE = /^[0-9a-fA-F]{1,4}$/;
  return groups.every((g) => GROUP_RE.test(g));
}

/**
 * Split `"<address>/<prefix>"` and bound the prefix length, or
 * `undefined` when either half is malformed.
 *
 * Exactly one `/`, and the prefix is plain decimal digits: `/ 24`,
 * `/+24`, `/08` and `/24/24` are all rejected before the address is
 * looked at.
 */
function cidrAddress(value: string, maxPrefix: number): string | undefined {
  const slash = value.indexOf("/");
  if (slash < 0 || value.indexOf("/", slash + 1) >= 0) return undefined;
  const prefix = value.slice(slash + 1);
  if (!PREFIX_LEN_RE.test(prefix)) return undefined;
  if (Number.parseInt(prefix, 10) > maxPrefix) return undefined;
  return value.slice(0, slash);
}

/**
 * OpenAPI `ipv4-cidr`: an IPv4 address in RFC 4632 CIDR notation
 * (e.g. `"192.0.2.0/24"`). The prefix length runs 0 through 32.
 *
 * Host bits are not required to be zero: `"192.0.2.1/24"` passes. RFC
 * 4632 §3.1 writes the notation as an address followed by a prefix
 * length and leaves the masking to whatever reads it, and the notation
 * is used for a host-within-a-block ("this interface's address, and
 * the size of its subnet") as often as for the block itself.
 *
 * @see RFC 4632 section 3.1, https://datatracker.ietf.org/doc/html/rfc4632#section-3.1
 * @public
 */
export function validateIpv4Cidr(value: string): boolean {
  const address = cidrAddress(value, 32);
  return address !== undefined && validateIpv4(address);
}

/**
 * OpenAPI `ipv6-cidr`: an IPv6 address in RFC 4291 §2.3 prefix
 * notation (e.g. `"2001:db8::/32"`). The prefix length runs 0 through
 * 128.
 *
 * Host bits are not required to be zero, for the reason
 * {@link validateIpv4Cidr} gives; RFC 4291 §2.3 spells out the
 * node-address-plus-prefix-length form explicitly.
 *
 * @see RFC 4291 section 2.3, https://datatracker.ietf.org/doc/html/rfc4291#section-2.3
 * @public
 */
export function validateIpv6Cidr(value: string): boolean {
  const address = cidrAddress(value, 128);
  return address !== undefined && validateIpv6(address);
}

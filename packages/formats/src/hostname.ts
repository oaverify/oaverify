/**
 * RFC 1123 / RFC 5890 hostname format validators.
 *
 * @packageDocumentation
 */

const LDH_LABEL_RE = /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)$/;

/** RFC 1035 section 2.3.4: 253 presentation characters, root dot excluded. */
const MAX_NAME_LENGTH = 253;

/**
 * A U-label: a letter or digit, then letters, digits, marks and hyphens.
 *
 * `\p{M}` is in the tail and not the head, which is the whole rule.
 * RFC 5892 derives combining marks as PVALID, so a name carrying one is
 * ordinary rather than exotic: every Indic, Thai, pointed-Hebrew and
 * NFD-Latin name is a mark-carrying name, and `.भारत` and `.বাংলা` are
 * delegated TLDs. RFC 5891 section 4.2.3.2 constrains marks in exactly
 * one position, the first, which is what this spelling says.
 *
 * Leaving marks out entirely refused every label under ten delegated IDN
 * ccTLDs, which read as one NFC nit in the conformance baseline because
 * the only case covering it was a Latin one.
 */
const U_LABEL_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])?$/u;

/** The labels of a name, with the root label's dot removed if written out. */
function labelsOf(value: string): string[] {
  return value.endsWith(".") ? value.slice(0, -1).split(".") : value.split(".");
}

/**
 * RFC 1123 `hostname` (ASCII). Maximum 253 chars; each label 1-63 chars;
 * letters, digits, hyphens; no leading/trailing hyphen.
 *
 * The length cap is measured after the root dot is removed, because the
 * dot is a separator rather than part of the name. Measuring before it
 * made `<253 chars>.` and `<253 chars>` different verdicts for the same
 * name.
 *
 * @specCites RFC 1123 section 2.1, https://datatracker.ietf.org/doc/html/rfc1123#section-2.1
 * @public
 */
export function validateHostname(value: string): boolean {
  if (value.length === 0) return false;
  const labels = labelsOf(value);
  if (labels.join(".").length > MAX_NAME_LENGTH) return false;
  return labels.every((l) => LDH_LABEL_RE.test(l));
}

/**
 * RFC 5890 internationalized `hostname`, checked structurally without
 * punycoding: each label is Unicode letters, digits, marks and hyphens,
 * with no leading mark, no leading or trailing hyphen, and at most 63
 * UTF-16 units. Unlike {@link validateHostname} there is no cap on the
 * whole name, because the RFC's cap is on the encoded A-label form and
 * this does not punycode (#669).
 *
 * A caller that needs the cap anyway is a mailbox: see
 * `validateMailboxDomain`, which applies it to both alphabets so the
 * pair cannot disagree on an ASCII domain.
 *
 * @specCites RFC 5890 section 2.3.2.3, https://datatracker.ietf.org/doc/html/rfc5890#section-2.3.2.3
 * @specCites RFC 5891 section 4.2.3.2, https://datatracker.ietf.org/doc/html/rfc5891#section-4.2.3.2
 * @specCites RFC 5892 section 2, https://datatracker.ietf.org/doc/html/rfc5892#section-2
 * @specBoundary under-asserts https://datatracker.ietf.org/doc/html/rfc5890#section-2.3.2.1
 * An internationalized hostname can exceed DNS's total length limit and
 * still pass validation. That limit applies to the ASCII encoding of the
 * name, including any Punycode-encoded Unicode labels. This validator
 * checks each dot-separated part but does not encode and measure the whole
 * name (#669).
 * @specBoundary under-asserts https://datatracker.ietf.org/doc/html/rfc5891#section-4.2
 * Some internationalized hostnames pass even though IDNA, the standard for
 * internationalized domain names, would reject them. The validator checks
 * basic character and label structure. It does not fully validate encoded
 * `xn--` labels or apply rules for characters whose validity depends on
 * neighboring characters or on mixing right-to-left and left-to-right text.
 * @public
 */
export function validateIdnHostname(value: string): boolean {
  if (value.length === 0) return false;
  return labelsOf(value).every((l) => l.length <= 63 && U_LABEL_RE.test(l));
}

/**
 * RFC 1123 / RFC 5890 hostname format validators.
 *
 * @packageDocumentation
 */

const LDH_LABEL_RE = /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)$/;

/**
 * RFC 1123 `hostname` (ASCII). Maximum 253 chars; each label 1-63 chars;
 * letters, digits, hyphens; no leading/trailing hyphen.
 *
 * @public
 */
export function validateHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.endsWith(".") ? value.slice(0, -1).split(".") : value.split(".");
  if (labels.length === 0) return false;
  return labels.every((l) => LDH_LABEL_RE.test(l));
}

/**
 * RFC 5890 internationalized `hostname`, checked structurally without
 * punycoding: each label is Unicode letters, digits, and hyphens, with
 * no leading or trailing hyphen, at most 63 UTF-16 units long. Unlike
 * {@link validateHostname} there is no 253-char cap on the whole name.
 *
 * @public
 */
export function validateIdnHostname(value: string): boolean {
  if (value.length === 0) return false;
  const labels = value.endsWith(".") ? value.slice(0, -1).split(".") : value.split(".");
  if (labels.length === 0) return false;
  const LABEL_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
  return labels.every((l) => {
    if (l.length === 0 || l.length > 63) return false;
    if (l.startsWith("-") || l.endsWith("-")) return false;
    return LABEL_RE.test(l);
  });
}

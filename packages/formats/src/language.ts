/**
 * The OpenAPI registry's `language`: an RFC 5646 (BCP 47) language tag.
 *
 * @packageDocumentation
 */

/** 1 to 8 letters or digits, which every subtag position narrows further. */
const SUBTAG_RE = /^[a-z0-9]{1,8}$/i;
const ALPHA_RE = /^[a-z]+$/i;
const DIGIT_RE = /^\d+$/;
const ALPHANUM_RE = /^[a-z0-9]+$/i;

/**
 * The irregular grandfathered tags, RFC 5646 §2.1, lowercased.
 *
 * These predate the current grammar and do not parse as `langtag`, so
 * they have to be recognised whole. The nine *regular* grandfathered
 * tags need no such table: each is a well-formed `langtag` already
 * (`art-lojban` is a language plus a variant, `zh-min-nan` a language
 * plus two extlangs), so the parser accepts them on the ordinary path.
 */
const IRREGULAR_GRANDFATHERED = new Set([
  "en-gb-oed",
  "i-ami",
  "i-bnn",
  "i-default",
  "i-enochian",
  "i-hak",
  "i-klingon",
  "i-lux",
  "i-mingo",
  "i-navajo",
  "i-pwn",
  "i-tao",
  "i-tay",
  "i-tsu",
  "sgn-be-fr",
  "sgn-be-nl",
  "sgn-ch-de",
]);

/** `language = 2*3ALPHA / 4ALPHA / 5*8ALPHA`, so 2 to 8 letters. */
function isLanguageSubtag(subtag: string): boolean {
  return subtag.length >= 2 && subtag.length <= 8 && ALPHA_RE.test(subtag);
}

/** `extlang` component: `3ALPHA`, up to three of them. */
function isExtlang(subtag: string | undefined): boolean {
  return subtag !== undefined && subtag.length === 3 && ALPHA_RE.test(subtag);
}

/** `script = 4ALPHA`. */
function isScript(subtag: string | undefined): boolean {
  return subtag !== undefined && subtag.length === 4 && ALPHA_RE.test(subtag);
}

/** `region = 2ALPHA / 3DIGIT`. */
function isRegion(subtag: string | undefined): boolean {
  return (
    subtag !== undefined &&
    ((subtag.length === 2 && ALPHA_RE.test(subtag)) ||
      (subtag.length === 3 && DIGIT_RE.test(subtag)))
  );
}

/** `variant = 5*8alphanum / (DIGIT 3alphanum)`. */
function isVariant(subtag: string | undefined): subtag is string {
  if (subtag === undefined) return false;
  if (subtag.length >= 5 && subtag.length <= 8 && ALPHANUM_RE.test(subtag)) return true;
  return subtag.length === 4 && DIGIT_RE.test(subtag[0] ?? "") && ALPHANUM_RE.test(subtag);
}

/**
 * `singleton`: one letter or digit, `x` excluded because `x` opens the
 * private-use sequence instead.
 */
function isSingleton(subtag: string | undefined): subtag is string {
  return (
    subtag !== undefined &&
    subtag.length === 1 &&
    ALPHANUM_RE.test(subtag) &&
    // The ABNF excludes both cases (%x41-57 skips X, %x61-77 skips x),
    // so `"en-X-a"` is private use rather than a one-letter extension.
    subtag.toLowerCase() !== "x"
  );
}

/** An extension's body subtag: `2*8alphanum`. */
function isExtensionBody(subtag: string | undefined): boolean {
  return subtag !== undefined && subtag.length >= 2 && ALPHANUM_RE.test(subtag);
}

/**
 * OpenAPI `language`: an RFC 5646 language tag (e.g. `"en"`,
 * `"en-US"`, `"zh-Hant-CN"`, `"de-CH-1901"`).
 *
 * **Well-formed, plus the validity conditions that need no registry.**
 * RFC 5646 §2.2.9 defines *well-formed* as conforming to the ABNF, and
 * *valid* as well-formed plus three more conditions: every subtag is
 * registered with IANA, no variant repeats, and no extension singleton
 * repeats. The last two are asserted here, because they are properties
 * of the tag itself. The registry condition is not, so `"qq-ZZ"`
 * passes: legal positions, subtags naming a language and a region that
 * do not exist.
 *
 * That line is where it is because the IANA Language Subtag Registry is
 * a ~1MB file that changes on IANA's schedule rather than this
 * package's, and a validator that silently goes stale is worse than one
 * that states its boundary. It also means the two rules that cost
 * nothing are not thrown away with it: a repeated variant is a defect
 * this can see.
 *
 * Case is not asserted either. RFC 5646 §2.1.1 recommends a
 * conventional casing (`en-Latn-GB`) and says explicitly that case
 * carries no meaning, so `"EN-latn-gb"` is the same tag and passes.
 *
 * The 17 irregular grandfathered tags (`"i-klingon"`, `"en-GB-oed"`)
 * are accepted from a table, since they predate the grammar. The nine
 * regular ones parse as ordinary tags and need no table.
 *
 * @see RFC 5646 (BCP 47) section 2.1, https://datatracker.ietf.org/doc/html/rfc5646#section-2.1
 * @public
 */
export function validateLanguage(value: string): boolean {
  if (IRREGULAR_GRANDFATHERED.has(value.toLowerCase())) return true;

  const subtags = value.split("-");
  // Every subtag is 1-8 alphanumerics before position is considered,
  // which is what rejects an empty subtag from a leading, trailing or
  // doubled hyphen.
  if (!subtags.every((subtag) => SUBTAG_RE.test(subtag))) return false;

  let index = 0;
  const next = (): string | undefined => subtags[index];

  // A tag that is nothing but a private-use sequence. `privateuse` is
  // `"x"` and at least one body subtag; every subtag is already known
  // to be 1-8 alphanumerics, so having one is the whole condition.
  if (next()?.toLowerCase() === "x") return subtags.length > index + 1;

  // `split` always yields at least one element and the loop above
  // rejected the empty subtag, so this is a real string.
  const language = subtags[0] ?? "";
  if (!isLanguageSubtag(language)) return false;
  index += 1;

  // extlang, up to three. No other position takes a bare 3ALPHA
  // subtag (a region of that length is 3DIGIT), so consuming greedily
  // cannot steer a later position wrong.
  if (language.length <= 3) {
    for (let seen = 0; seen < 3 && isExtlang(next()); seen += 1) index += 1;
  }

  if (isScript(next())) index += 1;
  if (isRegion(next())) index += 1;

  // Both sets stay unallocated for `en` / `en-US` / `zh-Hant-CN`,
  // which is the shape of nearly every tag a document carries.
  let variants: Set<string> | undefined;
  for (let subtag = next(); isVariant(subtag); subtag = next()) {
    // §2.2.9: the same variant may not appear twice, and case is not
    // what distinguishes two subtags.
    const variant = subtag.toLowerCase();
    variants ??= new Set<string>();
    if (variants.has(variant)) return false;
    variants.add(variant);
    index += 1;
  }

  let singletons: Set<string> | undefined;
  for (let subtag = next(); isSingleton(subtag); subtag = next()) {
    const singleton = subtag.toLowerCase();
    // §2.2.9 again: one extension per singleton.
    singletons ??= new Set<string>();
    if (singletons.has(singleton)) return false;
    singletons.add(singleton);
    index += 1;
    // `extension = singleton 1*("-" (2*8alphanum))`, so at least one
    // body subtag, and a lone singleton is not an extension.
    let body = 0;
    while (isExtensionBody(next())) {
      index += 1;
      body += 1;
    }
    if (body === 0) return false;
  }

  // A trailing private-use sequence, under the same rule.
  if (next()?.toLowerCase() === "x") return subtags.length > index + 1;

  return index === subtags.length;
}

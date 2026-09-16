/**
 * RFC 3339 `date` / `time` / `date-time` / `duration` format
 * validators, plus the OpenAPI registry's offsetless `time-local` and
 * `date-time-local`.
 *
 * @packageDocumentation
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
const TIME_LOCAL_RE = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;
const DATE_TIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/i;

/** Minutes past midnight of the last minute of a UTC day, `23:59`. */
const LAST_MINUTE_UTC = 23 * 60 + 59;
/**
 * RFC 3339 Appendix A `duration`, composed from the ABNF.
 *
 * The nesting is the point, and a flat run of optional components does
 * not express it: each unit carries **only the next smaller one**, so a
 * missing middle unit is a syntax error rather than an implied zero.
 * `P1Y2D` is invalid because `dur-year` reaches days only through
 * `dur-month`, and `PT1H2S` is invalid because `dur-hour` reaches
 * seconds only through `dur-minute`.
 *
 * `dur-week` is its own alternative at the top, so weeks combine with
 * nothing, not even a zero-valued component (`P0Y1W`) or a time part
 * (`P1WT1H`). And no component takes a fraction: `PT0.5S` is ISO 8601
 * but not RFC 3339.
 */
const DURATION_RE = (() => {
  const digits = "[0-9]+";
  const second = `${digits}S`;
  const minute = `${digits}M(?:${second})?`;
  const hour = `${digits}H(?:${minute})?`;
  const time = `T(?:${hour}|${minute}|${second})`;
  const day = `${digits}D`;
  const month = `${digits}M(?:${day})?`;
  const year = `${digits}Y(?:${month})?`;
  const date = `(?:${year}|${month}|${day})(?:${time})?`;
  const week = `${digits}W`;
  return new RegExp(`^P(?:${date}|${time}|${week})$`);
})();

/** Days in each month of a common year, January first. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * True when `day` exists in that month of that year.
 *
 * Shared with `http-date.ts`: a calendar is a calendar whatever
 * grammar spells it.
 *
 * The century rule is spelled out here rather than delegated to
 * `Date.UTC`, which cannot express it over the whole range RFC 3339
 * admits: ECMA-262 `MakeFullYear` maps a year argument in `0..99` to
 * `1900 + year`, so `Date.UTC(0, 2, 0)` asks about 1900 and reports
 * February as 28 days. Year 0 is a leap year in the proleptic
 * Gregorian calendar and 1900 is not.
 *
 * @internal
 */
export function isValidMonthDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  return day <= daysInMonth;
}

/**
 * RFC 3339 `full-date` (e.g. `"2024-01-31"`).
 *
 * @specCites RFC 3339 section 5.6, https://datatracker.ietf.org/doc/html/rfc3339#section-5.6
 * @public
 */
export function validateDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number.parseInt(match[1] ?? "0", 10);
  const month = Number.parseInt(match[2] ?? "0", 10);
  const day = Number.parseInt(match[3] ?? "0", 10);
  return isValidMonthDay(year, month, day);
}

/**
 * The time of day in minutes past midnight **UTC**, or `undefined` when
 * the local time or the offset is out of range.
 *
 * The offset is what makes this worth computing rather than checking the
 * fields where they are written. RFC 3339 puts a leap second at
 * `23:59:60Z` and nowhere else, but a local time may spell that instant
 * as `15:59:60-08:00` or `00:29:60-23:30`, so whether `:60` is legal is a
 * property of the instant rather than of the digits. Normalising first
 * makes the leap-second rule one comparison.
 *
 * The offset's own fields are bounded here too: `+24:00` and `+00:60`
 * match the shape and are not offsets.
 */
function utcMinuteOfDay(hour: number, minute: number, offset: string): number | undefined {
  if (hour > 23 || minute > 59) return undefined;
  let offsetMinutes = 0;
  if (offset !== "Z" && offset !== "z") {
    const offsetHour = Number.parseInt(offset.slice(1, 3), 10);
    const offsetMinute = Number.parseInt(offset.slice(4, 6), 10);
    if (offsetHour > 23 || offsetMinute > 59) return undefined;
    const sign = offset.startsWith("-") ? -1 : 1;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }
  // Wrap into [0, 1440): an offset can carry the instant across midnight
  // in either direction, and `00:29:60-23:30` is the same instant as
  // `23:59:60Z`.
  return (((hour * 60 + minute - offsetMinutes) % 1440) + 1440) % 1440;
}

/**
 * True when a `:60` seconds field names a real leap second.
 *
 * Leap seconds are only ever inserted at the end of a UTC day, so the
 * instant has to be `23:59:60Z` once the offset is applied. `22:59:60Z`
 * and `23:58:60Z` are the near misses this rejects.
 */
function isLeapSecondPosition(second: number, utcMinute: number): boolean {
  return second !== 60 || utcMinute === LAST_MINUTE_UTC;
}

/**
 * RFC 3339 `full-time` (e.g. `"12:34:56Z"` or `"12:34:56+02:00"`).
 *
 * @specCites RFC 3339 section 5.6, https://datatracker.ietf.org/doc/html/rfc3339#section-5.6
 * @public
 */
export function validateTime(value: string): boolean {
  const match = TIME_RE.exec(value);
  if (!match) return false;
  const hour = Number.parseInt(match[1] ?? "0", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const second = Number.parseInt(match[3] ?? "0", 10);
  if (second > 60) return false;
  const utcMinute = utcMinuteOfDay(hour, minute, match[4] ?? "Z");
  if (utcMinute === undefined) return false;
  return isLeapSecondPosition(second, utcMinute);
}

/**
 * RFC 3339 `date-time` (e.g. `"2024-01-31T12:34:56Z"`).
 *
 * @specCites RFC 3339 section 5.6, https://datatracker.ietf.org/doc/html/rfc3339#section-5.6
 * @public
 */
export function validateDateTime(value: string): boolean {
  const match = DATE_TIME_RE.exec(value);
  if (!match) return false;
  const year = Number.parseInt(match[1] ?? "0", 10);
  const month = Number.parseInt(match[2] ?? "0", 10);
  const day = Number.parseInt(match[3] ?? "0", 10);
  const hour = Number.parseInt(match[4] ?? "0", 10);
  const minute = Number.parseInt(match[5] ?? "0", 10);
  const second = Number.parseInt(match[6] ?? "0", 10);
  if (!isValidMonthDay(year, month, day)) return false;
  if (second > 60) return false;
  const utcMinute = utcMinuteOfDay(hour, minute, match[7] ?? "Z");
  if (utcMinute === undefined) return false;
  return isLeapSecondPosition(second, utcMinute);
}

/**
 * True when a local wall-clock time is in range.
 *
 * The seconds field admits `60` at any minute, which is looser than
 * {@link validateTime}'s rule and is the whole difference the missing
 * offset makes. A leap second is inserted at the end of a UTC day, so
 * whether `:60` is legal is a property of the instant; with no offset
 * there is no instant to check. `15:59:60` is a real leap second on a
 * `-08:00` clock and `05:44:60` is one on `+05:45`, so pinning the
 * rule to `23:59` would reject correct values to catch incorrect ones.
 * Under-asserting is the same call `numeric.ts` makes for `float`.
 */
function isLocalTimeOfDay(hour: number, minute: number, second: number): boolean {
  return hour <= 23 && minute <= 59 && second <= 60;
}

/**
 * OpenAPI `time-local`: RFC 3339 `partial-time`, an offsetless
 * wall-clock time (e.g. `"12:34:56"` or `"12:34:56.789"`).
 *
 * @specCites the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @specBoundary under-asserts
 * A `:60` second passes at any minute. The registry defines this as RFC
 * 3339 `partial-time`, whose `time-second` admits `:60` only where the
 * leap-second rules put one, and with no offset there is no instant to
 * check a leap second against. `validateTime`, which has one, does
 * apply the rule.
 * @public
 */
export function validateTimeLocal(value: string): boolean {
  const match = TIME_LOCAL_RE.exec(value);
  if (!match) return false;
  return isLocalTimeOfDay(
    Number.parseInt(match[1] ?? "0", 10),
    Number.parseInt(match[2] ?? "0", 10),
    Number.parseInt(match[3] ?? "0", 10),
  );
}

/**
 * OpenAPI `date-time-local`: RFC 3339 `date-time` with the offset
 * dropped (e.g. `"2024-01-31T12:34:56"`).
 *
 * The date half is checked exactly as {@link validateDateTime} checks
 * it, February included.
 *
 * @specCites the OpenAPI Format Registry, https://spec.openapis.org/registry/format/
 * @specBoundary under-asserts
 * A `:60` second passes at any minute, for the reason
 * `validateTimeLocal` gives: with no offset there is no instant to
 * check a leap second against.
 * @public
 */
export function validateDateTimeLocal(value: string): boolean {
  const match = DATE_TIME_LOCAL_RE.exec(value);
  if (!match) return false;
  const year = Number.parseInt(match[1] ?? "0", 10);
  const month = Number.parseInt(match[2] ?? "0", 10);
  const day = Number.parseInt(match[3] ?? "0", 10);
  if (!isValidMonthDay(year, month, day)) return false;
  return isLocalTimeOfDay(
    Number.parseInt(match[4] ?? "0", 10),
    Number.parseInt(match[5] ?? "0", 10),
    Number.parseInt(match[6] ?? "0", 10),
  );
}

/**
 * RFC 3339 `duration` (e.g. `"P1Y2M10DT2H30M"`).
 *
 * Implements the Appendix A ABNF as written, which is what JSON Schema
 * 2020-12 section 7.3.1 defines the `duration` format against. So unit
 * ordering is enforced and a missing middle unit is a syntax error
 * rather than an implied zero (`P1Y2D` is invalid, because `dur-year`
 * reaches days only through `dur-month`), weeks stand alone, and no
 * component carries a fraction (`PT0.5S` is ISO 8601 and not this
 * grammar).
 *
 * `dur-time` attaches to `dur-date`, after the whole
 * `(dur-day / dur-month / dur-year)` alternation, so `P1YT2H` is legal
 * and this accepts it. Reading the nesting as though `dur-time` were
 * reachable only through `dur-day` makes that look like a defect, and
 * it is the ABNF.
 *
 * @specCites RFC 3339 appendix A, https://datatracker.ietf.org/doc/html/rfc3339#appendix-A
 * @public
 */
export function validateDuration(value: string): boolean {
  return DURATION_RE.test(value);
}

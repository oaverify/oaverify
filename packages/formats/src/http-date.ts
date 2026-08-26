/**
 * The OpenAPI registry's `http-date`: RFC 7231 §7.1.1.1 `HTTP-date`,
 * the timestamp a `Date` or `Last-Modified` field carries.
 *
 * @packageDocumentation
 */

import { isValidMonthDay } from "./date.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = MONTHS.join("|");
const DAY_NAME = "Mon|Tue|Wed|Thu|Fri|Sat|Sun";
const DAY_NAME_L = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";
const TIME_OF_DAY = String.raw`(\d{2}):(\d{2}):(\d{2})`;

/**
 * The three grammars, in the order RFC 7231 lists them. Every literal
 * is case-sensitive there (`%x47.4D.54 ; "GMT", case-sensitive`), so
 * none of these carries the `i` flag: `sun, 06 nov 1994 08:49:37 gmt`
 * is not an HTTP-date.
 */
const IMF_FIXDATE_RE = new RegExp(
  String.raw`^(?:${DAY_NAME}), (\d{2}) (${MONTH}) (\d{4}) ${TIME_OF_DAY} GMT$`,
);
const RFC850_DATE_RE = new RegExp(
  String.raw`^(?:${DAY_NAME_L}), (\d{2})-(${MONTH})-(\d{2}) ${TIME_OF_DAY} GMT$`,
);
const ASCTIME_DATE_RE = new RegExp(
  String.raw`^(?:${DAY_NAME}) (${MONTH}) ([ \d]\d) ${TIME_OF_DAY} (\d{4})$`,
);

/**
 * True when the time of day is in range.
 *
 * `60` seconds passes: a `Date` field naming an instant during a leap
 * second is spelled that way, and RFC 9110 writes the bound as
 * `00-60` where RFC 7231 left it to prose.
 */
function isTimeOfDay(hour: string, minute: string, second: string): boolean {
  return (
    Number.parseInt(hour, 10) <= 23 &&
    Number.parseInt(minute, 10) <= 59 &&
    Number.parseInt(second, 10) <= 60
  );
}

/** 1-based month number for a three-letter month name known to be in the table. */
function monthNumber(name: string): number {
  return MONTHS.indexOf(name) + 1;
}

/**
 * OpenAPI `http-date`: an HTTP timestamp
 * (e.g. `"Sun, 06 Nov 1994 08:49:37 GMT"`).
 *
 * All three forms of RFC 7231's `HTTP-date` are accepted, because the
 * registry names that production and the production is
 * `IMF-fixdate / obs-date`. A sender must emit IMF-fixdate, so the
 * other two arriving in a request is a sign of something old on the
 * other end; they are legal HTTP-dates all the same, and rejecting
 * them would fail values the cited grammar admits. The two obsolete
 * forms are the RFC 850 one (`"Sunday, 06-Nov-94 08:49:37 GMT"`) and
 * ANSI C's `asctime` (`"Sun Nov  6 08:49:37 1994"`).
 *
 * Two things this does not assert:
 *
 * - **The day name is not checked against the date.** `"Mon, 06 Nov
 *   1994 08:49:37 GMT"` passes even though that day was a Sunday.
 *   Nothing in RFC 7231 asks a recipient to verify it, and a
 *   mismatch is a producer's clerical error rather than a value the
 *   reader cannot use.
 * - **An RFC 850 date's day-of-month check treats February as having
 *   29 days.** RFC 7231 §7.1.1.1 does say how to read the two-digit
 *   year: a timestamp more than 50 years in the future names the most
 *   recent past year ending in those digits. Applying that here would
 *   make the verdict depend on the clock, so `"29-Feb-24"` would turn
 *   invalid some time after 2074. A validator that changes its mind
 *   about a fixed input is worse than one that accepts a February 29th
 *   in a year that had no February 29th. A four-digit year gets the
 *   exact check, leap years included.
 *
 * @see RFC 9110 section 5.6.7, https://datatracker.ietf.org/doc/html/rfc9110#section-5.6.7
 * @public
 */
export function validateHttpDate(value: string): boolean {
  const fixdate = IMF_FIXDATE_RE.exec(value);
  if (fixdate) {
    return isTimestamp(
      Number.parseInt(fixdate[3] ?? "", 10),
      fixdate[2] ?? "",
      fixdate[1] ?? "",
      fixdate.slice(4),
    );
  }

  const rfc850 = RFC850_DATE_RE.exec(value);
  if (rfc850) {
    // 2000, a leap year, is the "February has 29 days" reading the
    // TSDoc promises: resolving the century would make the verdict
    // depend on today's date.
    return isTimestamp(2000, rfc850[2] ?? "", rfc850[1] ?? "", rfc850.slice(4));
  }

  const asctime = ASCTIME_DATE_RE.exec(value);
  if (asctime) {
    return isTimestamp(
      Number.parseInt(asctime[6] ?? "", 10),
      asctime[1] ?? "",
      asctime[2] ?? "",
      asctime.slice(3),
    );
  }

  return false;
}

/**
 * The shared tail of all three forms: a real calendar day, and a time
 * of day in range.
 *
 * `time` is the hour / minute / second slice of the match, which each
 * grammar spells identically and puts in a different position.
 */
function isTimestamp(year: number, month: string, day: string, time: string[]): boolean {
  return (
    isValidMonthDay(year, monthNumber(month), Number.parseInt(day, 10)) &&
    isTimeOfDay(time[0] ?? "", time[1] ?? "", time[2] ?? "")
  );
}

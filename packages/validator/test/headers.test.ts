import { markLowercaseKeys } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { getHeaderValue, getHeaderValueFast } from "../src/headers.js";

describe("header lookups", () => {
  it("gives an unmarked record case-insensitive semantics", () => {
    // A hand-built record keeps HTTP's rule: the caller wrote the key
    // the way their tooling spells it, and the lookup meets them there.
    const headers = { "X-Tenant": "t1" };
    expect(getHeaderValue(headers, "x-tenant")).toBe("t1");
    expect(getHeaderValueFast(headers, "x-tenant")).toBe("t1");
  });

  it("trusts the lowercase mark and skips the fallback scan", () => {
    // The mark is the adapter's promise that every key is lowercase, so
    // a direct miss is final. A declared-but-absent header used to pay
    // a full-record scan per request that could never find anything.
    const headers = markLowercaseKeys({ "x-tenant": "t1" });
    expect(getHeaderValue(headers, "x-tenant")).toBe("t1");
    expect(getHeaderValueFast(headers, "x-tenant")).toBe("t1");
    expect(getHeaderValue(headers, "x-absent")).toBeUndefined();
    expect(getHeaderValueFast(headers, "x-absent")).toBeUndefined();
    // The contract's edge: a mixed-case key on a marked record is
    // unreachable, which is why only key-lowercasing builders mark.
    const broken = markLowercaseKeys({ "X-Tenant": "t1" });
    expect(getHeaderValue(broken, "x-tenant")).toBeUndefined();
  });

  it("keeps the mark invisible to enumeration and serialization", () => {
    const headers = markLowercaseKeys({ a: "1" });
    expect(Object.keys(headers)).toEqual(["a"]);
    expect(JSON.stringify(headers)).toBe('{"a":"1"}');
  });
});

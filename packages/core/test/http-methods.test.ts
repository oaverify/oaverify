/**
 * `HTTP_METHODS` is the source `HttpMethod` is derived from, and seven
 * packages walk a Path Item's methods through it. Before #898 each kept
 * its own copy, which failed silently in the direction that bites: a
 * method added to the union and missed at one site simply disappeared
 * from whatever that site did.
 *
 * The derivation makes the type half impossible. `check-http-methods`
 * guards the other half, a new local copy. These pin the contents.
 */
import { describe, expect, it } from "vitest";
import { HTTP_METHODS, type HttpMethod } from "../src/index.js";

describe("HTTP_METHODS", () => {
  it("carries every method OpenAPI can declare an operation for", () => {
    // `query` is OpenAPI 3.2's addition and the reason #898 exists.
    expect([...HTTP_METHODS]).toEqual([
      "get",
      "put",
      "post",
      "delete",
      "options",
      "head",
      "patch",
      "trace",
      "query",
    ]);
  });

  it("declares each method once", () => {
    expect(new Set(HTTP_METHODS).size).toBe(HTTP_METHODS.length);
  });

  it("is lower-case, which every lookup assumes", () => {
    // Callers lower-case the request method before indexing a Path Item.
    for (const m of HTTP_METHODS) expect(m).toBe(m.toLowerCase());
  });

  it("types every member as an HttpMethod, and nothing else", () => {
    // Compile-time, not runtime: the assignment fails to typecheck if
    // the derivation is ever replaced by a hand-written union that
    // disagrees. `pnpm typecheck` is what enforces it.
    const all: readonly HttpMethod[] = HTTP_METHODS;
    const missing: Exclude<HttpMethod, (typeof HTTP_METHODS)[number]> extends never ? true : never =
      true;
    expect(all.length).toBe(9);
    expect(missing).toBe(true);
  });
});

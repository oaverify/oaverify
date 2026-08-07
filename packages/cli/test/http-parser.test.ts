import { describe, expect, it } from "vitest";
import { parseHttpFile } from "../src/http-parser.js";

describe("parseHttpFile", () => {
  it("parses a method, path, query, headers, and JSON body", () => {
    const text =
      "POST /pets?limit=10&tag=dog HTTP/1.1\n" +
      "Content-Type: application/json\n" +
      "X-Tenant-Id: abc-123\n" +
      "\n" +
      '{"name":"Fido","species":"dog"}';
    const req = parseHttpFile(text);
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/pets");
    expect(req.query).toEqual({ limit: "10", tag: "dog" });
    expect(req.contentType).toBe("application/json");
    expect(req.headers?.["x-tenant-id"]).toBe("abc-123");
    expect(req.body).toEqual({ name: "Fido", species: "dog" });
  });

  it("accepts CRLF line endings", () => {
    const text = "GET /x HTTP/1.1\r\nX-H: v\r\n\r\n";
    const req = parseHttpFile(text);
    expect(req.method).toBe("GET");
    expect(req.headers?.["x-h"]).toBe("v");
  });

  it("returns undefined body when none is provided", () => {
    const req = parseHttpFile("GET /pets HTTP/1.1\n\n");
    expect(req.body).toBeUndefined();
  });

  it("keeps a non-JSON body as a raw string", () => {
    const text = "POST /p HTTP/1.1\nContent-Type: text/plain\n\nhello world";
    const req = parseHttpFile(text);
    expect(req.body).toBe("hello world");
  });

  it("throws on a missing request line", () => {
    expect(() => parseHttpFile("")).toThrow();
  });

  // Query parsing goes through URLSearchParams, the same machinery the
  // fetch adapter uses, so one request text means one query whichever
  // door it comes in through.
  it('keeps "=" inside a query value', () => {
    const req = parseHttpFile("GET /p?tok=a=b&pad=YQ== HTTP/1.1\n\n");
    expect(req.query).toEqual({ tok: "a=b", pad: "YQ==" });
  });

  it('decodes "+" as a space, matching URLSearchParams', () => {
    const req = parseHttpFile("GET /p?q=hello+world HTTP/1.1\n\n");
    expect(req.query).toEqual({ q: "hello world" });
  });

  it('keeps a second "?" as query text (RFC 3986 allows it there)', () => {
    const req = parseHttpFile("GET /p?a=1?b=2 HTTP/1.1\n\n");
    expect(req.path).toBe("/p");
    expect(req.query).toEqual({ a: "1?b=2" });
  });

  it("tolerates a malformed percent escape instead of throwing", () => {
    const req = parseHttpFile("GET /p?bad=%zz HTTP/1.1\n\n");
    expect(req.query).toEqual({ bad: "%zz" });
  });

  it("throws a clear error when a declared-JSON body does not parse", () => {
    const text = 'POST /p HTTP/1.1\nContent-Type: application/json\n\n{"a":';
    // Silent fallback validated the broken text as a string body, and
    // the resulting schema error pointed everywhere except the typo.
    expect(() => parseHttpFile(text)).toThrow(/not valid JSON/);
  });

  it("keeps the sniffed-JSON fallback for undeclared bodies", () => {
    const req = parseHttpFile("POST /p HTTP/1.1\n\n{oops");
    expect(req.body).toBe("{oops");
  });
});

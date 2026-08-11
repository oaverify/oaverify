import { httpStatusFor, type OpenAPIDocument, type ValidationError } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TOTAL_BYTES,
  FetchBodyParseError,
  FetchBodyTooLargeError,
  httpRequestFromFetch,
  httpResponseFromFetch,
  readBodyFromFetch,
} from "../src/from-fetch.js";
import { combineValidators } from "../src/combine.js";
import { createValidator } from "../src/validator.js";

/**
 * The Fetch reader's byte budget (#430). The adapter drains the body
 * stream itself, with no framework body parser beneath it, so the
 * bound has to live here.
 *
 * Four concerns:
 *   - the two enforcement points, and that they report distinct
 *     reasons (a `Content-Length` we were handed vs a count we took);
 *   - that the bound holds on every media-type branch, multipart
 *     included, without a large body being relabelled as a malformed
 *     one;
 *   - the verdict conversion at the validating entry points, and its
 *     413;
 *   - the option's plumbing: default, override precedence, validation.
 */

/** A `Request` whose body arrives in chunks with no `Content-Length`. */
function chunkedRequest(chunks: string[], contentType = "application/json"): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("https://example.com/items", {
    method: "POST",
    headers: { "content-type": contentType },
    body: stream,
    // Required by undici for a streaming request body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function multipartRequest(fieldSize: number): Request {
  const form = new FormData();
  form.set("caption", "x".repeat(fieldSize));
  return new Request("https://example.com/items", { method: "POST", body: form });
}

function spec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/items": {
        post: {
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  };
}

/**
 * A `Request` carrying an honest `Content-Length`.
 *
 * Constructing a `Request` from a string does not populate the header;
 * a runtime populates it from the wire. So the pre-check is reachable
 * in a server, and unreachable here unless the header is set by hand.
 */
function declaredRequest(payload: string, declared = payload.length): Request {
  const req = new Request("https://example.com/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  req.headers.set("content-length", String(declared));
  return req;
}

describe("the Content-Length pre-check", () => {
  it("refuses a declared length over the cap, reporting it as declared", async () => {
    const payload = JSON.stringify({ padding: "x".repeat(200) });
    const req = declaredRequest(payload);

    const err = await readBodyFromFetch(req, { maxTotalBytes: 64 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchBodyTooLargeError);
    expect(err).toMatchObject({ limit: 64, reason: "declared", bytes: payload.length });
  });

  it("leaves the body unread when it fires", async () => {
    const req = declaredRequest(JSON.stringify({ padding: "x".repeat(200) }));
    await readBodyFromFetch(req, { maxTotalBytes: 64 }).catch(() => undefined);
    // A pre-check that read the stream would have consumed it. This is
    // the whole point of the branch: refuse without buffering.
    expect(req.bodyUsed).toBe(false);
  });

  it("does not fire when the header is absent, leaving the count to bound", async () => {
    const req = new Request("https://example.com/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(200) }),
    });
    expect(req.headers.get("content-length")).toBeNull();

    const err = await readBodyFromFetch(req, { maxTotalBytes: 64 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "read" });
  });

  it("ignores a malformed Content-Length and falls through to the count", async () => {
    // Not a rejection: the header is unusable, and the streamed count
    // is the actual bound. Refusing here would reject a body the real
    // bound would have accepted.
    const req = chunkedRequest(['{"a":', '"' + "x".repeat(200) + '"}']);
    req.headers.set("content-length", "not-a-number");

    const err = await readBodyFromFetch(req, { maxTotalBytes: 64 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchBodyTooLargeError);
    expect(err).toMatchObject({ reason: "read" });
  });
});

describe("the streamed byte count", () => {
  it("refuses a body whose declared length lied, reporting it as read", async () => {
    const req = chunkedRequest(['{"a":', '"' + "x".repeat(500) + '"}']);
    // The attacker-controlled case: a small declared length, a large body.
    req.headers.set("content-length", "10");

    const err = await readBodyFromFetch(req, { maxTotalBytes: 64 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchBodyTooLargeError);
    expect(err).toMatchObject({ limit: 64, reason: "read" });
    // An observation, not the number we were handed.
    expect((err as FetchBodyTooLargeError).bytes).toBeGreaterThan(64);
  });

  it("accepts a body of exactly the cap", async () => {
    const payload = JSON.stringify({ a: "x".repeat(20) });
    const req = chunkedRequest([payload]);
    await expect(readBodyFromFetch(req, { maxTotalBytes: payload.length })).resolves.toMatchObject({
      a: "x".repeat(20),
    });
  });

  it("refuses a body one byte over the cap", async () => {
    const payload = JSON.stringify({ a: "x".repeat(20) });
    const req = chunkedRequest([payload]);
    await expect(readBodyFromFetch(req, { maxTotalBytes: payload.length - 1 })).rejects.toThrow(
      FetchBodyTooLargeError,
    );
  });

  it("reads unbounded under an infinite cap", async () => {
    const payload = JSON.stringify({ a: "x".repeat(5000) });
    const req = chunkedRequest([payload]);
    await expect(
      readBodyFromFetch(req, { maxTotalBytes: Number.POSITIVE_INFINITY }),
    ).resolves.toMatchObject({ a: "x".repeat(5000) });
  });

  it("defaults to 1 MiB", async () => {
    expect(DEFAULT_MAX_TOTAL_BYTES).toBe(1024 * 1024);
    const req = chunkedRequest([JSON.stringify({ a: "x".repeat(DEFAULT_MAX_TOTAL_BYTES) })]);
    const err = await readBodyFromFetch(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchBodyTooLargeError);
    expect(err).toMatchObject({ limit: DEFAULT_MAX_TOTAL_BYTES });
  });
});

describe("the bound across media types", () => {
  const oversized = "x".repeat(500);

  it("bounds JSON", async () => {
    const req = chunkedRequest([JSON.stringify({ a: oversized })]);
    await expect(readBodyFromFetch(req, { maxTotalBytes: 64 })).rejects.toThrow(
      FetchBodyTooLargeError,
    );
  });

  it("bounds urlencoded forms", async () => {
    const req = chunkedRequest([`a=${oversized}`], "application/x-www-form-urlencoded");
    await expect(readBodyFromFetch(req, { maxTotalBytes: 64 })).rejects.toThrow(
      FetchBodyTooLargeError,
    );
  });

  it("bounds text/*", async () => {
    const req = chunkedRequest([oversized], "text/plain");
    await expect(readBodyFromFetch(req, { maxTotalBytes: 64 })).rejects.toThrow(
      FetchBodyTooLargeError,
    );
  });

  it("bounds an unknown media type read as raw bytes", async () => {
    const req = chunkedRequest([oversized], "application/octet-stream");
    await expect(readBodyFromFetch(req, { maxTotalBytes: 64 })).rejects.toThrow(
      FetchBodyTooLargeError,
    );
  });

  it("bounds a body with no content-type at all", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });
    const req = new Request("https://example.com/items", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    req.headers.delete("content-type");
    await expect(readBodyFromFetch(req, { maxTotalBytes: 64 })).rejects.toThrow(
      FetchBodyTooLargeError,
    );
  });

  it("bounds multipart as too-large, not as malformed", async () => {
    // The hazard: `formData()` reads and parses in one call, so the
    // stream error surfaces inside the branch that wraps everything in
    // FetchBodyParseError. A well-formed upload relabelled as garbage
    // would answer 400, and the client's 413 handling would never run.
    const err = await readBodyFromFetch(multipartRequest(500), { maxTotalBytes: 64 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FetchBodyTooLargeError);
    expect(err).not.toBeInstanceOf(FetchBodyParseError);
  });

  it("still reports a genuinely malformed multipart body as a parse failure", async () => {
    // The other side of the precedence rule: under the cap, nothing
    // about the size check changes how a bad payload is classified.
    const req = new Request("https://example.com/items", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----nope" },
      body: "not a multipart payload",
    });
    await expect(readBodyFromFetch(req, { maxTotalBytes: 1024 })).rejects.toThrow(
      FetchBodyParseError,
    );
  });

  it("leaves GET and HEAD unread whatever the cap", async () => {
    const req = new Request("https://example.com/items", { method: "GET" });
    await expect(readBodyFromFetch(req, { maxTotalBytes: 1 })).resolves.toBeUndefined();
  });

  it("still parses a body under the cap on every branch", async () => {
    // Guards the instrumented path itself: a counting stream that
    // corrupted the body would fail here rather than in a size test.
    await expect(
      readBodyFromFetch(chunkedRequest(['{"a":1}']), { maxTotalBytes: 1024 }),
    ).resolves.toEqual({ a: 1 });
    await expect(
      readBodyFromFetch(chunkedRequest(["a=1&b=2"], "application/x-www-form-urlencoded"), {
        maxTotalBytes: 1024,
      }),
    ).resolves.toEqual({ a: "1", b: "2" });
    await expect(
      readBodyFromFetch(chunkedRequest(["hello"], "text/plain"), { maxTotalBytes: 1024 }),
    ).resolves.toBe("hello");
    await expect(readBodyFromFetch(multipartRequest(4), { maxTotalBytes: 1024 })).resolves.toEqual({
      caption: "xxxx",
    });
    await expect(
      readBodyFromFetch(chunkedRequest(["ÿþ"], "application/octet-stream"), {
        maxTotalBytes: 1024,
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it("reassembles a multi-chunk body across the counting stream", async () => {
    // The counting transform enqueues chunk by chunk; a decode that
    // ran per chunk instead of over the whole stream would split a
    // multi-byte character or truncate the JSON.
    const req = chunkedRequest(['{"a":"', "café", '"}']);
    await expect(readBodyFromFetch(req, { maxTotalBytes: 1024 })).resolves.toEqual({ a: "café" });
  });
});

describe("the extraction helpers", () => {
  it("applies the cap through httpRequestFromFetch", async () => {
    const req = chunkedRequest([JSON.stringify({ a: "x".repeat(500) })]);
    await expect(httpRequestFromFetch(req, { maxTotalBytes: 64 })).rejects.toThrow(
      FetchBodyTooLargeError,
    );
  });

  it("applies the cap through httpResponseFromFetch", async () => {
    const res = new Response(JSON.stringify({ a: "x".repeat(500) }), {
      headers: { "content-type": "application/json" },
    });
    await expect(httpResponseFromFetch(res, { maxTotalBytes: 64 })).rejects.toThrow(
      FetchBodyTooLargeError,
    );
  });

  it("leaves a custom readBody to own its own budget", async () => {
    // The callback is documented to receive the original Request.
    // Wrapping it would silently hand back a different object than the
    // one the caller asked for.
    const req = chunkedRequest([JSON.stringify({ a: "x".repeat(500) })]);
    const { body } = await httpRequestFromFetch(req, {
      maxTotalBytes: 64,
      readBody: async (r) => ({ raw: (await r.text()).length }),
    });
    expect(body).toEqual({ raw: expect.any(Number) as number });
  });
});

describe("the verdict at the validating entry points", () => {
  it("returns a body-too-large leaf rather than throwing", async () => {
    const v = createValidator(spec(), { maxTotalBytes: 64, output: "tree" });
    const result = await v.validateFetchRequest(
      chunkedRequest([JSON.stringify({ a: "x".repeat(500) })]),
    );
    expect(result.ok).toBe(false);
    const error = (result as { error: ValidationError }).error;
    expect(error.code).toBe("body-too-large");
    expect(error.path).toEqual(["body"]);
    expect(error.params).toMatchObject({ limit: 64, reason: "read" });
  });

  it("maps that leaf to 413", async () => {
    const v = createValidator(spec(), { maxTotalBytes: 64 });
    const result = await v.validateFetchRequest(
      chunkedRequest([JSON.stringify({ a: "x".repeat(500) })]),
    );
    const errors = (result as { errors: ValidationError[] }).errors;
    expect(httpStatusFor(errors)).toBe(413);
  });

  it("carries the declared reason through when the pre-check fires", async () => {
    const v = createValidator(spec(), { maxTotalBytes: 64, output: "tree" });
    const result = await v.validateFetchRequest(
      declaredRequest(JSON.stringify({ a: "x".repeat(500) })),
    );
    const error = (result as { error: ValidationError }).error;
    expect(error.params).toMatchObject({ reason: "declared" });
  });

  it("applies on the response side too", async () => {
    const v = createValidator(spec(), { maxTotalBytes: 64, output: "tree" });
    const result = await v.validateFetchResponse(
      new Request("https://example.com/items", { method: "POST" }),
      new Response(JSON.stringify({ a: "x".repeat(500) }), {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(result.ok).toBe(false);
    expect((result as { error: ValidationError }).error.code).toBe("body-too-large");
  });

  it("carries the returnValues channel like the parse failure does", async () => {
    const v = createValidator(spec(), { maxTotalBytes: 64, returnValues: true });
    const result = await v.validateFetchRequest(
      chunkedRequest([JSON.stringify({ a: "x".repeat(500) })]),
    );
    // Empty rather than absent: the body failed before any parameter
    // was reached, and the type promises the channel on both branches.
    expect(result).toHaveProperty("value");
  });
});

describe("the option's plumbing", () => {
  it("lets a per-call cap override the validator-level one", async () => {
    const v = createValidator(spec(), { maxTotalBytes: 8 });
    const result = await v.validateFetchRequest(chunkedRequest(['{"a":1}']), {
      maxTotalBytes: 1024,
    });
    expect(result.ok).toBe(true);
  });

  it("falls back to the validator-level cap when the call passes other options", async () => {
    const v = createValidator(spec(), { maxTotalBytes: 8 });
    const result = await v.validateFetchRequest(
      chunkedRequest([JSON.stringify({ a: "x".repeat(500) })]),
      { readBody: undefined },
    );
    expect(result.ok).toBe(false);
  });

  it("keeps the validator-level cap when the call passes an explicit undefined", async () => {
    // What `{ ...opts }` produces when the caller's own options object
    // has no `maxTotalBytes`. Letting that reset the cap to the
    // reader's default would quietly tighten a validator configured
    // for large uploads.
    const v = createValidator(spec(), { maxTotalBytes: 8 * 1024 * 1024 });
    const result = await v.validateFetchRequest(
      chunkedRequest([JSON.stringify({ a: "x".repeat(2 * 1024 * 1024) })]),
      { maxTotalBytes: undefined },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a non-positive or non-integer cap at construction", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => createValidator(spec(), { maxTotalBytes: bad })).toThrow(/maxTotalBytes/);
    }
  });

  it("rejects NaN and -Infinity rather than reading them as uncapped", () => {
    // The `isFinite`-guarded shape `maxErrors` and `maxDepth` use would
    // pass both of these, and the reader's `!isFinite` test would then
    // treat them as infinity. A cap that exists to refuse hostile input
    // must not fail open, least of all silently.
    for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(() => createValidator(spec(), { maxTotalBytes: bad })).toThrow(/maxTotalBytes/);
    }
  });

  it("rejects the same values at the reader, which has no construction step", async () => {
    await expect(
      readBodyFromFetch(chunkedRequest(['{"a":1}']), { maxTotalBytes: Number.NaN }),
    ).rejects.toThrow(TypeError);
  });

  it("accepts an infinite cap at construction", () => {
    expect(() =>
      createValidator(spec(), { maxTotalBytes: Number.POSITIVE_INFINITY }),
    ).not.toThrow();
  });
});

describe("the composite validator", () => {
  it("returns a body-too-large verdict rather than throwing", async () => {
    // The composite reads the body before routing, so it has its own
    // reader call and its own conversion. Without one, a caller moving
    // from a validator to a composite of that validator would see a
    // throw where they had a verdict.
    const composite = combineValidators([createValidator(spec(), { maxTotalBytes: 64 })], {
      maxTotalBytes: 64,
    });
    const result = await composite.validateFetchRequest(
      chunkedRequest([JSON.stringify({ a: "x".repeat(500) })]),
    );
    expect(result.ok).toBe(false);
    expect((result as { errors: ValidationError[] }).errors[0]?.code).toBe("body-too-large");
  });

  it("applies its own cap on the response side", async () => {
    const composite = combineValidators([createValidator(spec())], { maxTotalBytes: 64 });
    const result = await composite.validateFetchResponse(
      new Request("https://example.com/items", { method: "POST" }),
      new Response(JSON.stringify({ a: "x".repeat(500) }), {
        headers: { "content-type": "application/json" },
      }),
    );
    expect(result.ok).toBe(false);
    expect((result as { errors: ValidationError[] }).errors[0]?.code).toBe("body-too-large");
  });

  it("converts an unparseable response body instead of throwing", async () => {
    // Pre-existing on the response side: the request wrapper converted
    // a parse failure and this one did not, so an unparseable upstream
    // response escaped a composite where a single validator returned a
    // verdict.
    const composite = combineValidators([createValidator(spec())]);
    const result = await composite.validateFetchResponse(
      new Request("https://example.com/items", { method: "POST" }),
      new Response('{"a":', { headers: { "content-type": "application/json" } }),
    );
    expect(result.ok).toBe(false);
    expect((result as { errors: ValidationError[] }).errors[0]?.code).toBe("body");
  });

  it("rejects a bad cap at construction rather than on every request", async () => {
    // Without a construction guard the value reaches the reader, which
    // throws a TypeError per request: a config typo becomes a stream of
    // 500s instead of a startup failure.
    for (const bad of [0, -1, Number.NaN]) {
      expect(() => combineValidators([createValidator(spec())], { maxTotalBytes: bad })).toThrow(
        /maxTotalBytes/,
      );
    }
  });

  it("takes the composite's cap, since no member owns the route yet", async () => {
    // The read happens before dispatch, so a member's own cap cannot
    // apply. A permissive member does not widen a strict composite.
    const composite = combineValidators(
      [createValidator(spec(), { maxTotalBytes: Number.POSITIVE_INFINITY })],
      { maxTotalBytes: 64 },
    );
    const result = await composite.validateFetchRequest(
      chunkedRequest([JSON.stringify({ a: "x".repeat(500) })]),
    );
    expect(result.ok).toBe(false);
  });
});

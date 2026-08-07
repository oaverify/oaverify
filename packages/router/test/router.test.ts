import { describe, expect, it } from "vitest";
import type { PathItem } from "@oaverify/internal-core";
import {
  createRouter,
  parseTemplate,
  type MethodNotAllowed,
  type RouteMatch,
} from "../src/matcher.js";

const op = (id: string) => ({ operationId: id, responses: { "200": { description: "ok" } } });

/**
 * Narrow a match to the `"match"` branch. `router.match` returns
 * `RouteMatch | MethodNotAllowed | undefined`, so `m?.operation` is a
 * type error, and the optional-chaining workaround would let a 405 or a
 * miss pass an assertion silently.
 */
function matched(m: RouteMatch | MethodNotAllowed | undefined): RouteMatch {
  if (m?.kind !== "match") {
    throw new Error(`expected a route match, got ${m === undefined ? "undefined" : m.kind}`);
  }
  return m;
}

describe("parseTemplate", () => {
  it("splits on slashes and identifies {param} segments", () => {
    expect(parseTemplate("/pets/{id}/tags/{tag}")).toEqual([
      { kind: "literal", value: "pets" },
      { kind: "template", name: "id" },
      { kind: "literal", value: "tags" },
      { kind: "template", name: "tag" },
    ]);
  });

  it("returns [] for root path", () => {
    expect(parseTemplate("/")).toEqual([]);
  });

  it("recognizes compound segments with multiple {name} parts and a literal separator", () => {
    const segs = parseTemplate("/commits/{sha}.{ext}");
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ kind: "literal", value: "commits" });
    expect(segs[1]?.kind).toBe("compound");
    if (segs[1]?.kind === "compound") {
      expect(segs[1].names).toEqual(["sha", "ext"]);
      expect(segs[1].raw).toBe("{sha}.{ext}");
    }
  });

  it("treats unterminated `{` in a segment as a literal rather than throwing", () => {
    // path-to-regexp tolerates malformed templates; mirror that.
    const segs = parseTemplate("/files/{name");
    expect(segs[1]).toEqual({ kind: "literal", value: "{name" });
  });
});

describe("router", () => {
  const paths: Record<string, PathItem> = {
    "/pets": { get: op("listPets"), post: op("createPet") },
    "/pets/{id}": { get: op("getPet"), put: op("replacePet") },
    "/pets/mine": { get: op("mine") },
    "/pets/{id}/tags/{tag}": { get: op("getTag") },
  };
  const r = createRouter(paths);

  it("matches exact literal paths", () => {
    const m = r.match("get", "/pets");
    expect(matched(m).operation.operationId).toBe("listPets");
    expect(matched(m).pathParams).toEqual({});
  });

  it("matches template parameters and extracts them", () => {
    const m = r.match("get", "/pets/42");
    expect(matched(m).operation.operationId).toBe("getPet");
    expect(matched(m).pathParams).toEqual({ id: "42" });
  });

  it("stores a __proto__ template parameter as an own capture", () => {
    const router = createRouter({ "/items/{__proto__}": { get: op("getItem") } });
    const params = matched(router.match("get", "/items/abc")).pathParams;
    expect(Object.hasOwn(params, "__proto__")).toBe(true);
    expect(params["__proto__"]).toBe("abc");
  });

  it("stores a __proto__ compound parameter as an own capture", () => {
    const router = createRouter({ "/items/{__proto__}.{ext}": { get: op("getItem") } });
    const params = matched(router.match("get", "/items/abc.json")).pathParams;
    expect(Object.hasOwn(params, "__proto__")).toBe(true);
    expect(params["__proto__"]).toBe("abc");
    expect(params.ext).toBe("json");
  });

  it("picks the literal specificity winner over a template sibling", () => {
    const m = r.match("get", "/pets/mine");
    expect(matched(m).operation.operationId).toBe("mine");
  });

  it("enumerates declared (method, pathPattern) pairs, uppercased, in sort order", () => {
    const list = r.routes();
    // Sort: more literal segments first (mine and .../tags/... both have
    // 2), then longer paths first, then ALL_METHODS order (get before
    // put/post) within a path.
    expect(list).toEqual([
      { method: "GET", pathPattern: "/pets/{id}/tags/{tag}" },
      { method: "GET", pathPattern: "/pets/mine" },
      { method: "GET", pathPattern: "/pets/{id}" },
      { method: "PUT", pathPattern: "/pets/{id}" },
      { method: "GET", pathPattern: "/pets" },
      { method: "POST", pathPattern: "/pets" },
    ]);
  });

  it("does not synthesize HEAD for a GET-only path", () => {
    const getOnly = createRouter({ "/ping": { get: op("ping") } });
    expect(getOnly.routes()).toEqual([{ method: "GET", pathPattern: "/ping" }]);
  });

  it("returns a frozen, stable array across calls", () => {
    expect(Object.isFrozen(r.routes())).toBe(true);
    expect(r.routes()).toBe(r.routes());
  });

  it("matches methods independently on the same path", () => {
    expect(matched(r.match("get", "/pets")).kind).toBe("match");
    expect(matched(r.match("post", "/pets")).kind).toBe("match");
    // DELETE isn't declared on /pets → method-not-allowed, not a path miss.
    const m = r.match("delete", "/pets");
    expect(m?.kind).toBe("method-not-allowed");
  });

  it("decodes percent-encoded segments", () => {
    const m = r.match("get", "/pets/foo%2Fbar");
    expect(matched(m).pathParams).toEqual({ id: "foo/bar" });
  });

  it("does not throw on malformed percent-encoding", () => {
    // decodeURIComponent throws URIError on a bad escape; the request
    // path is attacker-controlled, so matching must stay total. The
    // malformed token falls back to its raw form and captures cleanly.
    expect(() => r.match("get", "/pets/%E0%A4%A")).not.toThrow();
    const m = r.match("get", "/pets/%zz");
    expect(matched(m).operation.operationId).toBe("getPet");
    expect(matched(m).pathParams).toEqual({ id: "%zz" });
  });

  it("does not throw on a spec path template with a bad escape", () => {
    // #708: request-path decoding was guarded, spec-path literal decoding
    // was not, so `/bad%zz` in the spec threw URIError out of
    // parseTemplate (and so out of createValidator). The literal keeps its
    // raw form; `lintResolvedSpec` reports the escape as a located finding.
    expect(() => parseTemplate("/bad%zz")).not.toThrow();
    expect(parseTemplate("/bad%zz")).toEqual([{ kind: "literal", value: "bad%zz" }]);
    // Trailing `%`, and the degenerate `{`-bearing segment that falls
    // through to the literal branch.
    expect(parseTemplate("/a%")).toEqual([{ kind: "literal", value: "a%" }]);
    expect(parseTemplate("/x%zz{")).toEqual([{ kind: "literal", value: "x%zz{" }]);
    // Well-formed escapes still decode.
    expect(parseTemplate("/a%2Fb")).toEqual([{ kind: "literal", value: "a/b" }]);

    const rt = createRouter({ "/bad%zz": { get: op("bad") } } as Record<string, PathItem>);
    expect(matched(rt.match("get", "/bad%zz")).operation.operationId).toBe("bad");
  });

  it("decodes literal runs inside a compound segment", () => {
    // #715: `match` decodes the request token, so an undecoded spec
    // literal here could never meet it. The same escape worked in a
    // whole literal segment and silently failed in a compound one.
    const rt = createRouter({
      "/caf%C3%A9-{id}": { get: op("cafe") },
      "/caf%C3%A9": { get: op("plain") },
    } as Record<string, PathItem>);
    expect(matched(rt.match("get", "/caf%C3%A9-42")).operation.operationId).toBe("cafe");
    expect(matched(rt.match("get", "/caf%C3%A9-42")).pathParams).toEqual({ id: "42" });
    // The pure-literal sibling behaved correctly all along; the point is
    // that the two now agree.
    expect(matched(rt.match("get", "/caf%C3%A9")).operation.operationId).toBe("plain");
  });

  it("detects ambiguity between compound segments that decode alike", () => {
    // The ambiguity index compares a literal segment by its decoded
    // value, so a compound built from raw text would call these two
    // distinct while both match "caf\u00e9-42", and one would silently
    // shadow the other.
    expect(() =>
      createRouter({
        "/caf%C3%A9-{id}": { get: op("encoded") },
        "/caf\u00e9-{slug}": { get: op("literal") },
      } as Record<string, PathItem>),
    ).toThrow(/same path structure/);
    // Genuinely distinct compounds stay distinct.
    expect(() =>
      createRouter({
        "/a-{id}": { get: op("dash") },
        "/a.{id}": { get: op("dot") },
      } as Record<string, PathItem>),
    ).not.toThrow();
  });

  it("leaves an undecodable literal run raw inside a compound segment", () => {
    // decodePathToken is total, so a bad escape falls back to raw here
    // exactly as it does for a whole literal segment.
    const rt = createRouter({ "/a%zz-{id}": { get: op("bad") } } as Record<string, PathItem>);
    expect(matched(rt.match("get", "/a%zz-7")).pathParams).toEqual({ id: "7" });
  });

  it("ignores trailing slashes", () => {
    expect(matched(r.match("get", "/pets/")).operation.operationId).toBe("listPets");
  });

  it("ignores query strings", () => {
    expect(matched(r.match("get", "/pets?limit=10")).operation.operationId).toBe("listPets");
  });

  it("returns undefined for unknown paths", () => {
    expect(r.match("get", "/vets")).toBeUndefined();
    expect(r.match("get", "/pets/1/2/3")).toBeUndefined();
  });

  it("handles method casing", () => {
    expect(matched(r.match("GET", "/pets")).operation.operationId).toBe("listPets");
    expect(matched(r.match("Get", "/pets")).operation.operationId).toBe("listPets");
  });

  it("extracts multiple template params", () => {
    const m = r.match("get", "/pets/42/tags/vet");
    expect(matched(m).pathParams).toEqual({ id: "42", tag: "vet" });
  });

  it("routes HEAD to the GET operation when no explicit HEAD is declared", () => {
    // RFC 9110 §9.3.2: resources that answer GET must answer HEAD.
    const m = r.match("head", "/pets");
    expect(matched(m).operation.operationId).toBe("listPets");
  });

  it("prefers an explicit HEAD operation over the GET fallback", () => {
    const paths2: Record<string, PathItem> = {
      "/pets": { get: op("listPets"), head: op("headPets") },
    };
    const r2 = createRouter(paths2);
    expect(matched(r2.match("head", "/pets")).operation.operationId).toBe("headPets");
  });

  it("does not invent a HEAD route when the path has no GET", () => {
    const paths2: Record<string, PathItem> = { "/write-only": { post: op("post") } };
    const r2 = createRouter(paths2);
    // Path matches; HEAD isn't implicitly available without GET → 405.
    const m = r2.match("head", "/write-only");
    expect(m?.kind).toBe("method-not-allowed");
  });

  it("matches path segments containing a literal colon", () => {
    const p: Record<string, PathItem> = { "/users/me:follow": { get: op("follow") } };
    const rc = createRouter(p);
    expect(matched(rc.match("get", "/users/me:follow")).operation.operationId).toBe("follow");
  });

  it("decodes percent-encoded colons in request paths", () => {
    const p: Record<string, PathItem> = { "/users/me:follow": { get: op("follow") } };
    const rc = createRouter(p);
    expect(matched(rc.match("get", "/users/me%3Afollow")).operation.operationId).toBe("follow");
  });

  it("rejects two path templates that differ only in parameter names when methods overlap", () => {
    expect(() =>
      createRouter({
        "/items/{id}": { get: op("byId") },
        "/items/{slug}": { get: op("bySlug") },
      }),
    ).toThrow(/both declare GET/);
  });

  it("allows structurally-identical templates with disjoint methods", () => {
    // Real-world pattern from GitHub / Jira / Gmail / several AWS specs:
    // two paths describing the same URL shape but disjoint HTTP methods
    // (e.g. one declares only DELETE, the other only GET). They never
    // collide at match time, so construction must not throw.
    const rc = createRouter({
      "/orgs/{org}/attestations/{attestation_id}": { delete: op("deleteById") },
      "/orgs/{org}/attestations/{subject_digest}": { get: op("listByDigest") },
    });
    const del = rc.match("delete", "/orgs/acme/attestations/42");
    expect(matched(del).operation.operationId).toBe("deleteById");
    expect(matched(del).pathParams).toEqual({ org: "acme", attestation_id: "42" });
    const get = rc.match("get", "/orgs/acme/attestations/sha256:abc");
    expect(matched(get).operation.operationId).toBe("listByDigest");
    expect(matched(get).pathParams).toEqual({ org: "acme", subject_digest: "sha256:abc" });
  });

  it("flags GET-vs-explicit-HEAD as ambiguous on identical structure", () => {
    // GET implicitly answers HEAD via the runtime fallback (RFC 9110).
    // A sibling pattern declaring explicit HEAD on the same structure
    // would silently win at match time depending on sort order; surface
    // it at construction.
    expect(() =>
      createRouter({
        "/things/{id}": { get: op("get") },
        "/things/{slug}": { head: op("head") },
      }),
    ).toThrow(/both declare HEAD/);
  });

  it("routes compound segments and captures both parameters", () => {
    // Real-world Gitea-style spec: `{sha}` and `{sha}.{diffType}` are
    // distinct structures and must coexist; both have to route.
    const rc = createRouter({
      "/repos/{owner}/{repo}/git/commits/{sha}": { get: op("commit") },
      "/repos/{owner}/{repo}/git/commits/{sha}.{diffType}": { get: op("commitDiff") },
    });
    const plain = rc.match("get", "/repos/foo/bar/git/commits/abc123");
    expect(matched(plain).operation.operationId).toBe("commit");
    expect(matched(plain).pathParams).toEqual({ owner: "foo", repo: "bar", sha: "abc123" });
    const diff = rc.match("get", "/repos/foo/bar/git/commits/abc123.diff");
    expect(matched(diff).operation.operationId).toBe("commitDiff");
    expect(matched(diff).pathParams).toEqual({
      owner: "foo",
      repo: "bar",
      sha: "abc123",
      diffType: "diff",
    });
  });

  it("compound segment captures resolve left-to-right (lazy) when params could span the separator", () => {
    // `{x}.{y}` against `a.b.c` → x="a", y="b.c" (path-to-regexp /
    // hono / find-my-way / werkzeug all share this rule).
    const rc = createRouter({ "/x/{x}.{y}": { get: op("xy") } });
    const m = rc.match("get", "/x/a.b.c");
    expect(matched(m).pathParams).toEqual({ x: "a", y: "b.c" });
  });

  it("compound segment with three params resolves to one capture per part", () => {
    const rc = createRouter({ "/v/{a}.{b}.{c}": { get: op("abc") } });
    const m = rc.match("get", "/v/x.y.z");
    expect(matched(m).pathParams).toEqual({ a: "x", b: "y", c: "z" });
  });

  it("compound segment with non-matching literal separator returns 404", () => {
    const rc = createRouter({ "/v/{a}.{b}": { get: op("ab") } });
    expect(rc.match("get", "/v/xy")).toBeUndefined();
  });

  it("two compound siblings differing only in parameter names flag as ambiguous on overlapping methods", () => {
    expect(() =>
      createRouter({
        "/x/{a}.{b}": { get: op("ab") },
        "/x/{p}.{q}": { get: op("pq") },
      }),
    ).toThrow(/both declare GET/);
  });

  it("compound and pure-template siblings are distinct structures (signatures differ)", () => {
    // `{sha}` and `{sha}.{ext}` are different shapes. Both must compile
    // even when they declare overlapping methods.
    expect(() =>
      createRouter({
        "/c/{sha}": { get: op("plain") },
        "/c/{sha}.{ext}": { get: op("withExt") },
      }),
    ).not.toThrow();
  });

  it("ignores path items declaring no methods when checking ambiguity", () => {
    // A PathItem with only `parameters` and no methods can never match
    // a request, so it shouldn't conflict with a sibling that does.
    expect(() =>
      createRouter({
        "/things/{id}": { get: op("get") },
        "/things/{slug}": { parameters: [] } as PathItem,
      }),
    ).not.toThrow();
  });

  it("returns method-not-allowed with an allowed set (405 shape)", () => {
    const m = r.match("delete", "/pets");
    expect(m).toEqual({
      kind: "method-not-allowed",
      pathPattern: "/pets",
      allowed: ["GET", "HEAD", "POST"],
    });
  });

  it("unions allowed methods across every path template that matches the path", () => {
    // /items/42 and /items/{id} both structurally match POST /items/42.
    // Neither declares POST, so the allowed union is {GET (from /items/42),
    // HEAD (implicit via GET), PUT (from /items/{id})}.
    const rc = createRouter({
      "/items/42": { get: op("literal") },
      "/items/{id}": { put: op("byId") },
    });
    const m = rc.match("post", "/items/42");
    expect(m).toEqual({
      kind: "method-not-allowed",
      pathPattern: "/items/42",
      allowed: ["GET", "HEAD", "PUT"],
    });
  });

  it("falls through to a matching method on a less-specific path", () => {
    // /items/42 has GET only; /items/{id} has POST. A POST /items/42
    // should hit the {id} route, not return method-not-allowed.
    const rc = createRouter({
      "/items/42": { get: op("literal") },
      "/items/{id}": { post: op("byId") },
    });
    const m = rc.match("post", "/items/42");
    expect(m?.kind).toBe("match");
    if (m?.kind === "match") {
      expect(m.operation.operationId).toBe("byId");
      expect(m.pathPattern).toBe("/items/{id}");
      // Falling through must still capture the matched template's params,
      // otherwise the operation would receive an empty / stale param map.
      expect(m.pathParams).toEqual({ id: "42" });
    }
  });
});

describe("slash trimming (js/polynomial-redos regression)", () => {
  const r = createRouter({ "/pets/{id}": { get: op("getPet") } });

  it("collapses leading and trailing slash runs", () => {
    expect(parseTemplate("///pets///")).toEqual([{ kind: "literal", value: "pets" }]);
    expect(parseTemplate("")).toEqual([]);
    expect(parseTemplate("///")).toEqual([]);
    expect(matched(r.match("get", "///pets/42///")).pathParams).toEqual({ id: "42" });
  });

  it("leaves interior slash runs alone (they are empty segments, not trimmed)", () => {
    // Only the outer runs are stripped; an interior run still splits into
    // empty tokens, so this must not match /pets/{id}.
    expect(parseTemplate("/a//b/")).toEqual([
      { kind: "literal", value: "a" },
      { kind: "literal", value: "" },
      { kind: "literal", value: "b" },
    ]);
    // An interior run splits into an empty token, so this must not match.
    expect(r.match("get", "/pets//42")).toBeUndefined();
  });

  it("stays linear on a long interior slash run", () => {
    // The trailing-slash strip used to be /\/+$/, which has no anchor to
    // pin the `+`: on a long INTERIOR run it retries at every slash and
    // fails the `$` each time. A leading run alone is harmless, since the
    // anchored /^\/+/ eats it first -- so the run must sit in the middle.
    //
    // At this size the old quadratic path takes tens of seconds; the
    // linear one is sub-millisecond. The 2s budget is ~4000x the honest
    // cost, so it absorbs any CI jitter while still failing decisively.
    const path = `/a${"/".repeat(200_000)}b`;
    const started = performance.now();
    r.match("get", path);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

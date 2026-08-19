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

  it("splits a compound segment into names and the literals around them", () => {
    // The equivalence test rebuilds the old regex from `literals`, so a
    // mis-split would agree with itself and stay green. These pin the
    // split independently.
    const compound = (template: string): { names: string[]; literals: string[] } => {
      const seg = parseTemplate(template).at(-1);
      if (seg?.kind !== "compound") throw new Error(`${template} is not compound`);
      return { names: seg.names, literals: seg.literals };
    };
    expect(compound("/{a}.{b}")).toEqual({ names: ["a", "b"], literals: ["", ".", ""] });
    expect(compound("/{a}{b}")).toEqual({ names: ["a", "b"], literals: ["", "", ""] });
    expect(compound("/pre-{a}-{b}.json")).toEqual({
      names: ["a", "b"],
      literals: ["pre-", "-", ".json"],
    });
    // The literal runs decode, which is what #715 fixed.
    expect(compound("/caf%C3%A9-{id}")).toEqual({ names: ["id"], literals: ["caf\u00e9-", ""] });
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
    // Sort: left-to-right positional specificity ("/pets/mine" pins its
    // second segment with a literal, so it precedes both templated
    // siblings), longer paths first among positional ties, then
    // ALL_METHODS order (get before put/post) within a path.
    expect(list).toEqual([
      { method: "GET", pathPattern: "/pets/mine" },
      { method: "GET", pathPattern: "/pets/{id}/tags/{tag}" },
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
    // And the unencoded request form, which is what a client actually sends.
    expect(matched(rt.match("get", "/caf\u00e9-42")).operation.operationId).toBe("cafe");
  });

  it("treats a decoded separator character as literal in a compound segment", () => {
    // "%2E" decodes to a dot, and the dot is a literal separator here:
    // it has to match a dot and nothing else.
    const rt = createRouter({ "/a%2Eb-{id}": { get: op("dot") } } as Record<string, PathItem>);
    expect(matched(rt.match("get", "/a.b-7")).pathParams).toEqual({ id: "7" });
    expect(rt.match("get", "/aXb-7")).toBeUndefined();
  });

  it("explains a literal collision without blaming parameter names", () => {
    // #725: these two name the same path once decoded and carry no
    // placeholder, so the parameter-name clause sent the reader looking
    // for one neither template has.
    expect(() =>
      createRouter({
        "/bad%zz": { get: op("a") },
        "/bad%25zz": { get: op("b") },
      } as Record<string, PathItem>),
    ).toThrow(/both declare GET on the same path structure \(they name the same path\)/);
  });

  it("explains a trailing-slash collision the same way", () => {
    // Likelier in a real spec than the encoding case: trimSlashes gives
    // "/a" and "/a/" the same signature, and neither carries a placeholder.
    expect(() =>
      createRouter({
        "/a": { get: op("a") },
        "/a/": { get: op("b") },
      } as Record<string, PathItem>),
    ).toThrow(/\(they name the same path\)/);
  });

  it("reports a {-bearing literal as a literal collision", () => {
    // `/a{b` has an unterminated brace, so parseSegment treats it as
    // literal text. Reading the signature rather than the raw text is
    // what keeps the message off parameter names here.
    expect(() =>
      createRouter({
        "/a{b": { get: op("a") },
        "/a%7Bb": { get: op("b") },
      } as Record<string, PathItem>),
    ).toThrow(/\(they name the same path\)/);
  });

  it("keeps the parameter-name clause when a placeholder is involved", () => {
    expect(() =>
      createRouter({
        "/pets/{id}": { get: op("a") },
        "/pets/{slug}": { get: op("b") },
      } as Record<string, PathItem>),
    ).toThrow(/parameter names differ but every GET request would match both/);
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

  it("lets a compound capture hold a decoded slash, as a bare {param} does", () => {
    // #724. See `matchCompound` for why a capture admits a decoded slash.
    const rt = createRouter({
      "/{id}": { get: op("bare") },
      "/{a}-{b}": { get: op("comp") },
    } as Record<string, PathItem>);
    // A bare template has always captured a decoded slash.
    expect(matched(rt.match("get", "/a%2Fb")).pathParams).toEqual({ id: "a/b" });
    // The compound now does too, instead of losing the request to `{id}`.
    const m = matched(rt.match("get", "/a%2Fb-z"));
    expect(m.operation.operationId).toBe("comp");
    expect(m.pathParams).toEqual({ a: "a/b", b: "z" });
  });

  it("still refuses to match a compound across real segment boundaries", () => {
    // The token split happens before matching, so a structural `/` never
    // reaches a capture; admitting a decoded one cannot let a compound
    // span two segments.
    const rt = createRouter({ "/{a}-{b}": { get: op("comp") } } as Record<string, PathItem>);
    expect(rt.match("get", "/x/y-z")).toBeUndefined();
    expect(rt.match("get", "/x-y/z")).toBeUndefined();
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

describe("fragment handling", () => {
  // A request target never carries a fragment on the wire (RFC 9112),
  // so one in `path` is a hand-built URL-shaped string. `?` was already
  // tolerated; stopping there let "#section" corrupt the last capture.
  it("strips a #fragment before matching, as it does a ?query", () => {
    const router = createRouter({ "/pets/{id}": { get: op("pet") } as PathItem });
    const m = matched(router.match("get", "/pets/1#section"));
    expect(m.pathParams).toEqual({ id: "1" });
    const withQuery = matched(router.match("get", "/pets/1?x=2#section"));
    expect(withQuery.pathParams).toEqual({ id: "1" });
  });

  it("still delivers a literal # sent as %23", () => {
    // Decoding happens after the strip, so an encoded "#" is data.
    const router = createRouter({ "/pets/{id}": { get: op("pet") } as PathItem });
    const m = matched(router.match("get", "/pets/a%23b"));
    expect(m.pathParams).toEqual({ id: "a#b" });
  });
});

describe("route precedence is positional", () => {
  // Left-to-right, static-beats-parameter at the first differing
  // position: the rule find-my-way, path-to-regexp orderings, and
  // gorilla/mux all apply. The count-based sort this replaces called
  // /a/{x}/c and /{y}/b/c equally specific (two literals each) and let
  // the alphabetical tie-break route the request.
  it("prefers the route whose literal comes first", () => {
    const router = createRouter({
      "/{y}/b/c": { get: op("late-literal") } as PathItem,
      "/a/{x}/c": { get: op("early-literal") } as PathItem,
    });
    const m = matched(router.match("get", "/a/b/c"));
    expect(m.operation.operationId).toBe("early-literal");
  });

  it("an early literal beats a higher literal count later", () => {
    const router = createRouter({
      "/{x}/b/c": { get: op("two-late-literals") } as PathItem,
      "/a/{x}/{y}": { get: op("one-early-literal") } as PathItem,
    });
    const m = matched(router.match("get", "/a/b/c"));
    expect(m.operation.operationId).toBe("one-early-literal");
  });

  it("a compound beats a bare template at the same position", () => {
    const router = createRouter({
      "/p/{v}": { get: op("template") } as PathItem,
      "/p/{v}.json": { get: op("compound") } as PathItem,
    });
    const m = matched(router.match("get", "/p/x.json"));
    expect(m.operation.operationId).toBe("compound");
  });
});

describe("route sort determinism", () => {
  // The final specificity tie-break orders by code point, so the route
  // list is identical on every host. `localeCompare` consults the ICU
  // locale, and "/" (0x2F) sorting relative to letters is exactly the
  // kind of comparison collation tables reorder; route precedence must
  // not vary with LANG.
  it("breaks specificity ties by code point, not locale collation", () => {
    // Structurally identical positions (literal, template) on disjoint
    // methods, so the sort falls through position, length, and lands on
    // the name comparison. Code-point order puts "/p/{a}" before
    // "/pz/{b}" ("/" is 0x2F); a collation that weighs punctuation
    // lightly compares "{" (0x7B) against "z" (0x7A) instead and could
    // swap them, so route order would vary with the host locale.
    const router = createRouter({
      "/pz/{b}": { post: op("second") } as PathItem,
      "/p/{a}": { get: op("first") } as PathItem,
    });
    expect(router.routes().map((r) => r.pathPattern)).toEqual(["/p/{a}", "/pz/{b}"]);
  });
});

describe("malformed path items", () => {
  // A YAML author writing `/b:` with nothing under it produces `null`,
  // not `{}`. `null` passes an `!== undefined` presence check, so it
  // reached the route table as a declaration and threw a raw TypeError
  // while the table was being built, before any pass could locate it
  // (#794).
  it("does not throw on a null path item", () => {
    const router = createRouter({ "/b": null as unknown as PathItem });
    expect(router.match("get", "/b")).toEqual({
      kind: "method-not-allowed",
      pathPattern: "/b",
      allowed: [],
    });
  });

  it("does not count a null operation as declared", () => {
    const router = createRouter({ "/b": { get: null } as unknown as PathItem });
    expect(router.match("get", "/b")).toEqual({
      kind: "method-not-allowed",
      pathPattern: "/b",
      allowed: [],
    });
  });

  // The HEAD fallback reads the GET slot directly, so it needs the same
  // guard: a null GET must not be handed back as the HEAD operation.
  it("does not fall back to a null GET for HEAD", () => {
    const router = createRouter({ "/b": { get: null } as unknown as PathItem });
    expect(router.match("head", "/b")).toEqual({
      kind: "method-not-allowed",
      pathPattern: "/b",
      allowed: [],
    });
  });

  it("keeps the valid siblings of a null operation", () => {
    const router = createRouter({ "/b": { get: null, post: op("live") } as unknown as PathItem });
    expect(matched(router.match("post", "/b")).operation.operationId).toBe("live");
    expect(router.match("get", "/b")).toEqual({
      kind: "method-not-allowed",
      pathPattern: "/b",
      allowed: ["POST"],
    });
  });

  it("omits a null operation from the route list", () => {
    const router = createRouter({ "/b": { get: null, post: op("live") } as unknown as PathItem });
    expect(router.routes()).toEqual([{ method: "POST", pathPattern: "/b" }]);
  });
});

describe("a request method that is not an HTTP method (#855)", () => {
  // `match` lower-cased and cast to `HttpMethod`, and `operationOn`
  // guards only "is this an object". `METHOD_SET`'s comment in
  // `matcher.ts` carries the rule and why it is a rule; these are the
  // cases it was worth pinning.
  const router = createRouter({
    "/pets/{id}": {
      get: op("getPet"),
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    },
    "/x": { servers: [{ url: "http://a" }], get: op("getX") },
  } as unknown as Record<string, PathItem>);

  it("does not route a PARAMETERS request against the parameters array", () => {
    const m = router.match("PARAMETERS", "/pets/42");
    expect(m?.kind).toBe("method-not-allowed");
  });

  it("does not route a SERVERS request against the servers array", () => {
    // `servers` is the sibling `parameters` has: a Path Item field a
    // conformant document gives an object value.
    const m = router.match("SERVERS", "/x");
    expect(m?.kind).toBe("method-not-allowed");
  });

  it("does not route a lowercase x- extension that holds an object", () => {
    // A real shape: `x-amazon-apigateway-any-method` is a published AWS
    // extension declared at Path Item level whose value is an Operation
    // Object. Extensions are open-ended, which is why `METHOD_SET`'s
    // comment states a rule rather than a list; see it for the rule.
    const withExt = createRouter({
      "/z": {
        get: op("getZ"),
        "x-amazon-apigateway-any-method": op("anyMethod"),
      },
    } as unknown as Record<string, PathItem>);
    expect(withExt.match("X-AMAZON-APIGATEWAY-ANY-METHOD", "/z")?.kind).toBe("method-not-allowed");
  });

  it("does not route a summary that a malformed document wrote as an object", () => {
    // `summary` is a string in a conformant document, so the object
    // guard rejected it there. Malformed input is what these guards are
    // for, and it is where the string assumption stops holding.
    const malformed = createRouter({
      "/m": { get: op("getM"), summary: op("summaryOp") },
    } as unknown as Record<string, PathItem>);
    expect(malformed.match("SUMMARY", "/m")?.kind).toBe("method-not-allowed");
  });

  it("does not route __proto__ against Object.prototype", () => {
    // The widest of them: `item["__proto__"]` is
    // `Object.prototype`, which is an object, so this matched against
    // any document at all rather than only one declaring an
    // object-valued Path Item field. `constructor` and `toString`
    // resolve to functions, which the object guard already rejected.
    const plain = createRouter({
      "/pets/{id}": { get: op("getPet") },
    } as unknown as Record<string, PathItem>);
    expect(plain.match("__proto__", "/pets/42")?.kind).toBe("method-not-allowed");
    expect(plain.match("__PROTO__", "/pets/42")?.kind).toBe("method-not-allowed");
  });

  it("does not route an own __proto__ field the document declared", () => {
    // The second way `__proto__` reached an operation. `JSON.parse` and
    // the YAML reader both define the key rather than invoking the
    // setter, so a document can carry it as an own object-valued field
    // and it routed as that value rather than as `Object.prototype`.
    const doc = JSON.parse(
      '{"/j":{"get":{"operationId":"getJ","responses":{"200":{"description":"ok"}}},' +
        '"__proto__":{"operationId":"declared"}}}',
    ) as Record<string, PathItem>;
    // Pin the parser behaviour the case rests on. Without this the test
    // passes either way: if `JSON.parse` invoked the setter instead, the
    // lookup would still find the same object, just on the prototype.
    expect(Object.prototype.hasOwnProperty.call(doc["/j"], "__proto__")).toBe(true);
    expect(createRouter(doc).match("__proto__", "/j")?.kind).toBe("method-not-allowed");
  });

  it("does not route an own constructor the document declared", () => {
    // The inherited `constructor` is a function, which the object guard
    // rejects. An own one declared as an object is not, and routed.
    const declared = createRouter({
      "/c": { get: op("getC"), constructor: op("ctor") },
    } as unknown as Record<string, PathItem>);
    expect(declared.match("CONSTRUCTOR", "/c")?.kind).toBe("method-not-allowed");
  });

  it("answers exactly as any other unknown method does", () => {
    // 405 with the declared set, not 404: that is what `SUMMARY` and
    // `POST` already returned here, and suppressing the operation
    // lookup rather than returning early is what keeps them agreeing.
    const shape = (method: string) => {
      const m = router.match(method, "/pets/42");
      return m?.kind === "method-not-allowed" ? m.allowed : m?.kind;
    };
    expect(shape("PARAMETERS")).toEqual(["GET", "HEAD"]);
    expect(shape("SUMMARY")).toEqual(["GET", "HEAD"]);
    expect(shape("POST")).toEqual(["GET", "HEAD"]);
  });

  it("still routes the declared methods, and still misses an unknown path", () => {
    expect(matched(router.match("GET", "/pets/42")).operation).toEqual(op("getPet"));
    // GET implicitly answers HEAD (RFC 9110 9.3.2); the suppression
    // must not break the fallback.
    expect(matched(router.match("HEAD", "/pets/42")).operation).toEqual(op("getPet"));
    expect(router.match("GET", "/nope")).toBeUndefined();
  });
});

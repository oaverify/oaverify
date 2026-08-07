import { describe, expect, it } from "vitest";
import type { DocumentReader } from "@oaverify/internal-spec";
import {
  DEFAULT_MAX_BYTES,
  UNTRUSTED_MAX_BYTES,
  confineRootFor,
  entryRefusal,
  fileOptionsFor,
  httpOptionsFor,
  originOf,
  parseRemoteRefs,
  policyHttpReader,
  remoteRefsNotice,
  type ReaderPolicy,
} from "../src/reader-policy.js";

const REMOTE_ENTRY = "https://api.example.com/openapi.json";

function policy(over: Partial<ReaderPolicy> = {}): ReaderPolicy {
  return { entry: "./spec.yaml", remoteRefs: "allow", untrusted: false, ...over };
}

/** An http reader that records what it was asked for and always succeeds. */
function stubHttp(): DocumentReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    canRead: (uri) => /^https?:/i.test(uri),
    read: async (uri) => {
      reads.push(uri);
      return {};
    },
  };
}

describe("parseRemoteRefs", () => {
  it("names the legal set rather than defaulting on a typo", () => {
    expect(() => parseRemoteRefs("same_origin")).toThrow(/expected allow, same-origin, deny/);
  });

  it("accepts each mode", () => {
    expect(parseRemoteRefs("allow")).toBe("allow");
    expect(parseRemoteRefs("same-origin")).toBe("same-origin");
    expect(parseRemoteRefs("deny")).toBe("deny");
  });
});

describe("entryRefusal", () => {
  it("refuses a remote entry under deny, naming the contradiction", () => {
    const message = entryRefusal(policy({ entry: REMOTE_ENTRY, remoteRefs: "deny" }));
    expect(message).toContain(REMOTE_ENTRY);
    expect(message).toContain("--remote-refs same-origin");
  });

  it("allows a local entry under deny", () => {
    expect(entryRefusal(policy({ remoteRefs: "deny" }))).toBeUndefined();
  });

  it("allows a remote entry under same-origin and allow", () => {
    expect(
      entryRefusal(policy({ entry: REMOTE_ENTRY, remoteRefs: "same-origin" })),
    ).toBeUndefined();
    expect(entryRefusal(policy({ entry: REMOTE_ENTRY, remoteRefs: "allow" }))).toBeUndefined();
  });
});

describe("httpOptionsFor", () => {
  it("leaves allow unrestricted apart from the caps", () => {
    const options = httpOptionsFor(policy());
    expect(options.allowUri).toBeUndefined();
    expect(options.redirects).toBeUndefined();
    expect(options.maxBytes).toBe(DEFAULT_MAX_BYTES);
  });

  it("pairs every restricting posture with redirects: error", () => {
    // An allowlist that follows redirects is not an allowlist: fetch
    // never consults allowUri for the hop.
    expect(httpOptionsFor(policy({ remoteRefs: "deny" })).redirects).toBe("error");
    expect(
      httpOptionsFor(policy({ entry: REMOTE_ENTRY, remoteRefs: "same-origin" })).redirects,
    ).toBe("error");
  });

  it("admits the entry's origin and refuses another under same-origin", () => {
    const { allowUri } = httpOptionsFor(policy({ entry: REMOTE_ENTRY, remoteRefs: "same-origin" }));
    expect(allowUri?.("https://api.example.com/schemas/pet.json")).toBe(true);
    expect(allowUri?.("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(allowUri?.("https://evil.example.com/x.json")).toBe(false);
  });

  it("admits nothing under same-origin when the entry is local or stdin", () => {
    const local = httpOptionsFor(policy({ remoteRefs: "same-origin" }));
    expect(local.allowUri?.("https://api.example.com/x.json")).toBe(false);
    const stdin = httpOptionsFor(policy({ entry: "-", remoteRefs: "same-origin" }));
    expect(stdin.allowUri?.("https://api.example.com/x.json")).toBe(false);
  });

  it("tightens the caps under untrusted", () => {
    expect(httpOptionsFor(policy({ untrusted: true })).maxBytes).toBe(UNTRUSTED_MAX_BYTES);
  });
});

describe("fileOptionsFor and confineRootFor", () => {
  it("leaves confine off by default, because ../shared is a correct ref", () => {
    expect(fileOptionsFor(policy()).confine).toBeUndefined();
    expect(confineRootFor(policy())).toBeUndefined();
  });

  it("confines to the entry's directory under untrusted", () => {
    const p = policy({ entry: "/tmp/specs/openapi.yaml", untrusted: true });
    expect(fileOptionsFor(p).confine).toBe(true);
    expect(confineRootFor(p)).toBe("/tmp/specs");
  });

  it("has no confine root for a remote or stdin entry", () => {
    expect(confineRootFor(policy({ entry: REMOTE_ENTRY, untrusted: true }))).toBeUndefined();
    expect(confineRootFor(policy({ entry: "-", untrusted: true }))).toBeUndefined();
  });
});

describe("policyHttpReader", () => {
  it("counts only what a stricter default would refuse", async () => {
    // The notice says "cross-origin", so the count has to mean that.
    // The entry is not a $ref at all, and a sibling on the entry's own
    // origin survives same-origin, so neither is news.
    const inner = stubHttp();
    let count = 0;
    const reader = policyHttpReader(
      inner,
      policy({ entry: REMOTE_ENTRY, remoteRefs: "allow" }),
      () => (count += 1),
    );
    await reader.read(REMOTE_ENTRY);
    expect(count).toBe(0);
    await reader.read("https://api.example.com/schemas/pet.json");
    expect(count).toBe(0);
    await reader.read("https://elsewhere.example/x.json");
    expect(count).toBe(1);
  });

  it("counts every remote read when the entry is local", async () => {
    // A local entry opted into no origin, so every remote ref is one
    // same-origin would refuse.
    let count = 0;
    const reader = policyHttpReader(
      stubHttp(),
      policy({ remoteRefs: "allow" }),
      () => (count += 1),
    );
    await reader.read("https://api.example.com/pet.json");
    expect(count).toBe(1);
  });

  it("names the posture that refused rather than the mechanism", async () => {
    const reader = policyHttpReader(stubHttp(), policy({ remoteRefs: "deny" }), () => {});
    await expect(reader.read("https://internal.corp/x.json")).rejects.toThrow(
      /refused by --remote-refs deny/,
    );
  });

  it("explains a same-origin refusal by naming the origin opted into", async () => {
    const reader = policyHttpReader(
      stubHttp(),
      policy({ entry: REMOTE_ENTRY, remoteRefs: "same-origin" }),
      () => {},
    );
    await expect(reader.read("http://169.254.169.254/")).rejects.toThrow(
      /the entry's origin is https:\/\/api\.example\.com/,
    );
  });

  it("says no origin was opted into when the entry is local", async () => {
    const reader = policyHttpReader(stubHttp(), policy({ remoteRefs: "same-origin" }), () => {});
    await expect(reader.read("https://api.example.com/x.json")).rejects.toThrow(
      /the entry is not remote/,
    );
  });

  it("does not read at all when the posture refuses", async () => {
    const inner = stubHttp();
    const reader = policyHttpReader(inner, policy({ remoteRefs: "deny" }), () => {});
    await expect(reader.read("https://internal.corp/x.json")).rejects.toThrow();
    expect(inner.reads).toEqual([]);
  });
});

describe("remoteRefsNotice", () => {
  it("says nothing when nothing remote was read", () => {
    expect(remoteRefsNotice("check", 0)).toBe("");
  });

  it("names both the restore and the adopt-now flag", () => {
    const notice = remoteRefsNotice("check", 3);
    expect(notice).toContain("resolved 3 cross-origin $refs");
    expect(notice).toContain("--remote-refs allow");
    expect(notice).toContain("--remote-refs same-origin");
  });

  it("agrees with itself about the count", () => {
    expect(remoteRefsNotice("check", 1)).toContain("1 cross-origin $ref ");
  });
});

describe("originOf", () => {
  it("is undefined for anything that is not an http(s) URI", () => {
    expect(originOf("./spec.yaml")).toBeUndefined();
    expect(originOf("-")).toBeUndefined();
  });

  it("ignores path and query, which is what makes a sibling ref legal", () => {
    expect(originOf("https://h.example/a/b.json?v=1")).toBe("https://h.example");
  });

  it("separates origins that differ only by port or scheme", () => {
    expect(originOf("https://h.example:8443/a")).not.toBe(originOf("https://h.example/a"));
    expect(originOf("http://h.example/a")).not.toBe(originOf("https://h.example/a"));
  });
});

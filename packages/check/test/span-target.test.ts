import { describe, expect, it } from "vitest";
import {
  createSourceSpanResolver,
  type SourceSpan,
  type SpanRequest,
} from "@oaverify/internal-spec";
import { createYamlSpanBackend } from "@oaverify/syntax";
import { spanFor, spanRequestsFor, spanTargetFor } from "../src/span-target.js";
import type { CheckFinding } from "../src/finding.js";

/**
 * The recommendation, the batch it implies, and the fallback.
 *
 * The guard at the bottom is the one that matters over time: a code on
 * the key list that cannot resolve a key fails silently in production,
 * because the fallback hides it behind a value span.
 */

const SPEC = `openapi: 3.1.0
paths:
  /orders/{id}:
    get:
      responses:
        "200":
          description: ok
tags:
  - name: unused
components:
  schemas:
    Order:
      type: object
      nullable: true
      $defs:
        Dead:
          type: string
`;

function finding(code: string, pointer: string): CheckFinding {
  return {
    class: "hygiene",
    severity: "warning",
    code,
    location: pointer,
    message: `${code} at ${pointer}`,
    target: { pointer, anchor: "node", source: { uri: "spec.yaml", pointer, via: [] } },
  };
}

function lookupOver(
  findings: readonly CheckFinding[],
): (of: SpanRequest) => SourceSpan | undefined {
  const resolver = createSourceSpanResolver({
    texts: { textFor: (uri) => (uri === "spec.yaml" ? { text: SPEC, syntax: "yaml" } : undefined) },
    backends: [createYamlSpanBackend()],
  });
  const requests = spanRequestsFor(findings);
  const spans = new Map<string, SourceSpan>();
  for (const [i, span] of resolver.spansFor(requests).entries()) {
    const request = requests[i];
    if (span === undefined || request === undefined) continue;
    spans.set(`${request.uri} ${request.pointer} ${request.want ?? "value"}`, span);
  }
  return (of) => spans.get(`${of.uri} ${of.pointer} ${of.want ?? "value"}`);
}

function text(span: SourceSpan | undefined): string | undefined {
  return span === undefined ? undefined : SPEC.slice(span.start.offset, span.end.offset);
}

describe("the recommendation", () => {
  it("defaults to the value, including for a code it has never heard of", () => {
    expect(spanTargetFor("type")).toBe("value");
    expect(spanTargetFor("a-code-from-a-later-version")).toBe("value");
  });

  it("asks for the key where the name is the subject", () => {
    expect(spanTargetFor("unused-component")).toBe("key");
    expect(spanTargetFor("unknown-keyword")).toBe("key");
  });
});

describe("the batch a lookup has to answer", () => {
  it("carries both wants for a key code, so the fallback has something to fall back to", () => {
    const requests = spanRequestsFor([finding("unused-component", "/components/schemas/Order")]);
    expect(requests).toEqual([
      { uri: "spec.yaml", pointer: "/components/schemas/Order", want: "key" },
      { uri: "spec.yaml", pointer: "/components/schemas/Order", want: "value" },
    ]);
  });

  it("carries one for a value code", () => {
    expect(spanRequestsFor([finding("unused-tag", "/tags/0")])).toEqual([
      { uri: "spec.yaml", pointer: "/tags/0", want: "value" },
    ]);
  });

  it("asks for hops as values, whatever the code recommends", () => {
    const f = finding("unused-component", "/components/schemas/Order");
    const withHop = {
      ...f,
      target: {
        ...f.target!,
        source: { ...f.target!.source!, via: [{ uri: "entry.yaml", pointer: "/paths" }] },
      },
    } as CheckFinding;
    expect(spanRequestsFor([withHop])).toContainEqual({
      uri: "entry.yaml",
      pointer: "/paths",
      want: "value",
    });
  });
});

describe("applying it", () => {
  it("narrows a key code to the name rather than the body", () => {
    const f = finding("unused-component", "/components/schemas/Order");
    expect(text(spanFor(f, lookupOver([f])))).toBe("Order");
  });

  it("points unknown-keyword at the keyword, not at its value", () => {
    const f = finding("unknown-keyword", "/components/schemas/Order/nullable");
    expect(text(spanFor(f, lookupOver([f])))).toBe("nullable");
  });

  it("falls back to the value where the code recommends a key and none exists", () => {
    // `/tags/0` is an array element. Were `unused-tag` ever marked
    // "key", this is the case that would silently lose its region.
    const f: CheckFinding = { ...finding("unused-tag", "/tags/0"), code: "unused-component" };
    expect(spanTargetFor(f.code)).toBe("key");
    expect(text(spanFor(f, lookupOver([f])))).toBe("name: unused\n");
  });

  it("leaves a value code alone", () => {
    const f = finding("unused-tag", "/tags/0");
    expect(text(spanFor(f, lookupOver([f])))).toBe("name: unused\n");
  });
});

describe("every code on the key list can resolve a key", () => {
  // Silent in production: a key that never resolves is hidden by the
  // fallback, so the finding keeps a span and nobody notices the
  // recommendation is dead.
  const KEY_CODE_FIXTURES: Record<string, string> = {
    "unused-component": "/components/schemas/Order",
    "unreachable-defs": "/components/schemas/Order/$defs/Dead",
    "path-template-malformed": "/paths/~1orders~1{id}",
    "unknown-keyword": "/components/schemas/Order/nullable",
  };

  it.each(Object.entries(KEY_CODE_FIXTURES))("%s resolves a key", (code, pointer) => {
    expect(spanTargetFor(code)).toBe("key");
    const f = finding(code, pointer);
    const lookup = lookupOver([f]);
    const key = lookup({ uri: "spec.yaml", pointer, want: "key" });
    expect(key, `${code} recommends a key but ${pointer} resolves none`).toBeDefined();
    // and the recommendation is what gets used, not the fallback
    expect(spanFor(f, lookup)).toEqual(key);
  });
});

import type { OpenAPIDocument } from "@oaverify/internal-core";
import { describe, expect, it } from "vitest";
import { createValidator } from "./fixtures.js";

/**
 * A parameter or `apiKey` named after an `Object.prototype` member must
 * never be satisfied by the inherited value. Indexing a caller-supplied
 * record directly resolves "constructor" / "toString" / ... to the
 * inherited function, which reads as present, so a client sending
 * nothing passes a `required` check or an `apiKey` security check.
 *
 * The parameters here deliberately declare no schema. With
 * `schema: { type: "string" }` an absent parameter fails on a `type`
 * error against the inherited function instead, which would mask a
 * regression in the presence check itself.
 */

const PROTO_MEMBERS = ["constructor", "hasOwnProperty", "toString", "valueOf"] as const;

const LOCATIONS = ["header", "query", "cookie"] as const;

function apiKeySpec(name: string, location: (typeof LOCATIONS)[number]): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    components: { securitySchemes: { k: { type: "apiKey", name, in: location } } as never },
    security: [{ k: [] }],
    paths: { "/ping": { get: { responses: { "200": { description: "ok" } } } } },
  };
}

function requiredParamSpec(name: string, location: (typeof LOCATIONS)[number]): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/ping": {
        get: {
          parameters: [{ name, in: location, required: true }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

function requiredPathParamSpec(name: string): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/ping": {
        get: {
          parameters: [{ name, in: "path", required: true }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

function mixedRequiredQueryParamSpec(): OpenAPIDocument {
  return {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/ping": {
        get: {
          parameters: [
            { name: "id", in: "query", required: true },
            { name: "constructor", in: "query", required: true },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

const EMPTY_REQUEST = {
  method: "GET",
  path: "/ping",
  headers: {},
  query: {},
  cookies: {},
} as const;

describe("inherited Object.prototype members never satisfy a presence check", () => {
  for (const member of PROTO_MEMBERS) {
    for (const location of LOCATIONS) {
      it(`apiKey in ${location} named "${member}" is unsatisfied when absent`, () => {
        const v = createValidator(apiKeySpec(member, location), {
          validateSecurity: "strict",
        });
        expect(v.validateRequest({ ...EMPTY_REQUEST })).not.toBeNull();
      });

      it(`required ${location} parameter "${member}" is unsatisfied when absent`, () => {
        const v = createValidator(requiredParamSpec(member, location));
        const error = v.validateRequest({ ...EMPTY_REQUEST });
        expect(error).not.toBeNull();
        expect(JSON.stringify(error)).toContain("missing required");
      });
    }

    it(`required path parameter "${member}" is unsatisfied when absent`, () => {
      const v = createValidator(requiredPathParamSpec(member));
      const error = v.validateRequest({ ...EMPTY_REQUEST });
      expect(error).not.toBeNull();
      expect(JSON.stringify(error)).toContain("missing required");
    });
  }
});

describe("mixed ordinary and prototype-member parameters stay guarded", () => {
  it("does not let a safe sibling put a hazardous query parameter on the fast path", () => {
    const v = createValidator(mixedRequiredQueryParamSpec());
    const error = v.validateRequest({ ...EMPTY_REQUEST, query: { id: "sent" } });
    expect(error).not.toBeNull();
    expect(error?.children?.[0]?.message).toBe('missing required query parameter "constructor"');
  });
});

describe("a parameter named after a prototype member still works when supplied", () => {
  for (const member of PROTO_MEMBERS) {
    it(`required header parameter "${member}" passes when sent`, () => {
      const v = createValidator(requiredParamSpec(member, "header"));
      const req = { ...EMPTY_REQUEST, headers: { [member.toLowerCase()]: "sent" } };
      expect(v.validateRequest(req)).toBeNull();
    });

    it(`required query parameter "${member}" passes when sent`, () => {
      const v = createValidator(requiredParamSpec(member, "query"));
      expect(v.validateRequest({ ...EMPTY_REQUEST, query: { [member]: "sent" } })).toBeNull();
    });

    it(`required cookie parameter "${member}" passes when sent`, () => {
      const v = createValidator(requiredParamSpec(member, "cookie"));
      expect(v.validateRequest({ ...EMPTY_REQUEST, cookies: { [member]: "sent" } })).toBeNull();
    });

    it(`apiKey in header named "${member}" passes when sent`, () => {
      const v = createValidator(apiKeySpec(member, "header"), { validateSecurity: "strict" });
      const req = { ...EMPTY_REQUEST, headers: { [member.toLowerCase()]: "k" } };
      expect(v.validateRequest(req)).toBeNull();
    });
  }
});

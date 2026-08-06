import { describe, expect, it } from "vitest";
import {
  compileSchema,
  jsonSchemaDialect,
  openapi31Dialect,
  type CompiledRegex,
  type RegexCompiler,
} from "../src/index.js";
import { createDeps } from "../src/compiler/runtime.js";

describe("regexCompiler option", () => {
  it("default: `pattern` validation behaves as before", () => {
    const { validate } = compileSchema(
      { type: "string", pattern: "^\\d+$" },
      { dialect: jsonSchemaDialect },
    );
    expect(validate("123")).toEqual({ valid: true });
    expect(validate("abc").valid).toBe(false);
  });

  it('default: `format: "regex"` is auto-registered (no formats option needed)', () => {
    // The OpenAPI dialects activate format-assertion. Auto-registration
    // means callers no longer need to thread builtInFormats just to get
    // the regex format.
    const { validate } = compileSchema(
      { type: "string", format: "regex" },
      { dialect: openapi31Dialect },
    );
    expect(validate("^abc$")).toEqual({ valid: true });
    expect(validate("(unclosed").valid).toBe(false);
  });

  it("custom regexCompiler is invoked for the `pattern` keyword", () => {
    const calls: string[] = [];
    const compiler: RegexCompiler = (pattern) => {
      calls.push(pattern);
      // Reject everything, exercise the pattern keyword's failure path.
      return { test: () => false };
    };
    const { validate } = compileSchema(
      { type: "string", pattern: "^x$" },
      { dialect: jsonSchemaDialect, regexCompiler: compiler },
    );
    const result = validate("x");
    expect(result.valid).toBe(false);
    expect(calls).toEqual(["^x$"]);
  });

  it('custom regexCompiler is invoked for `format: "regex"`', () => {
    const calls: string[] = [];
    const accepting: RegexCompiler = (pattern) => {
      calls.push(pattern);
      return { test: () => true };
    };
    const { validate } = compileSchema(
      { type: "string", format: "regex" },
      { dialect: openapi31Dialect, regexCompiler: accepting },
    );
    // The format dispatch compiles the value-as-pattern. A custom
    // compiler that accepts everything makes every string a "valid"
    // regex, so validation passes.
    expect(validate("anything-goes")).toEqual({ valid: true });
    expect(calls).toEqual(["anything-goes"]);
  });

  it("rejects from a custom regexCompiler surface as format-validation failures", () => {
    const rejecting: RegexCompiler = (pattern) => {
      if (pattern.includes("(a+)+")) throw new Error("redos suspect");
      return new RegExp(pattern);
    };
    const { validate } = compileSchema(
      { type: "string", format: "regex" },
      { dialect: openapi31Dialect, regexCompiler: rejecting },
    );
    expect(validate("ok").valid).toBe(true);
    expect(validate("(a+)+").valid).toBe(false);
  });

  it("compiler is called once per unique pattern (memoized)", () => {
    let calls = 0;
    const compiler: RegexCompiler = (pattern) => {
      calls += 1;
      return new RegExp(pattern, "u");
    };
    const { validate } = compileSchema(
      {
        type: "array",
        items: { type: "string", pattern: "^id-" },
      },
      { dialect: jsonSchemaDialect, regexCompiler: compiler },
    );
    validate(["id-1", "id-2", "id-3"]);
    validate(["id-4", "id-5"]);
    expect(calls).toBe(1);
  });

  it('format: "regex" does NOT memoize runtime values (bounded memory)', () => {
    // The `pattern` keyword caches schema-authored strings (bounded
    // by spec size). The `regex` format runs against user data; if
    // that path used the same cache, a long-lived validator
    // receiving many unique regex inputs would grow memory without
    // bound. Pin the no-cache behavior: many unique inputs => many
    // compiler calls; the cache stays empty.
    let calls = 0;
    const compiler: RegexCompiler = (pattern) => {
      calls += 1;
      return new RegExp(pattern, "u");
    };
    const { validate } = compileSchema(
      { type: "string", format: "regex" },
      { dialect: openapi31Dialect, regexCompiler: compiler },
    );
    const distinctValues = ["^a$", "^b$", "^c$", "^d$", "^e$"];
    for (const v of distinctValues) validate(v);
    expect(calls).toBe(distinctValues.length);
    // Repeating the same value also re-invokes the compiler (no cache).
    validate("^a$");
    expect(calls).toBe(distinctValues.length + 1);
  });

  it("user-supplied `regex` format overrides the auto-registered one", () => {
    let userCompilerCalls = 0;
    const userRegex = (_value: string): boolean => {
      userCompilerCalls += 1;
      return false; // always fail
    };
    const { validate } = compileSchema(
      { type: "string", format: "regex" },
      {
        dialect: openapi31Dialect,
        formats: { regex: userRegex },
      },
    );
    expect(validate("^x$").valid).toBe(false);
    expect(userCompilerCalls).toBe(1);
  });

  // `\a` is a legal ECMA-262 regex outside `u` mode (Annex B identity
  // escape) and a SyntaxError inside it. That makes it the case where
  // the keyword and the format have to disagree, so it pins both halves.
  const ANNEX_B_ONLY = `${String.fromCharCode(92)}a`;

  it("the `regex` format asserts u-mode and rejects an Annex B escape", () => {
    const { validate } = compileSchema(
      { type: "string", format: "regex" },
      { dialect: openapi31Dialect },
    );
    expect(validate(ANNEX_B_ONLY).valid).toBe(false);
    // Still accepts what u-mode accepts.
    expect(validate("^a+$").valid).toBe(true);
    expect(validate("\\u{1F600}").valid).toBe(true);
  });

  it("the `pattern` keyword keeps its no-flag fallback for the same source", () => {
    // Deliberately asymmetric with the format above. A pattern is spec
    // input: refusing it means the document cannot be opened, so the
    // fallback stays. Dropping it here would turn a loadable spec into a
    // compile error.
    const { validate } = compileSchema(
      { type: "string", pattern: ANNEX_B_ONLY },
      { dialect: jsonSchemaDialect },
    );
    expect(validate("a").valid).toBe(true);
    expect(validate("b").valid).toBe(false);
  });

  it("a custom regexCompiler still governs the `regex` format's policy", () => {
    // The strict path is only the default. A caller who wants one policy
    // for both supplies a compiler, and it wins.
    const permissive: RegexCompiler = (pattern) => new RegExp(pattern);
    const { validate } = compileSchema(
      { type: "string", format: "regex" },
      { dialect: openapi31Dialect, regexCompiler: permissive },
    );
    expect(validate(ANNEX_B_ONLY).valid).toBe(true);
  });

  it("createDeps(maxErrors) legacy positional form still works", () => {
    // AOT-emitted modules built before the options-bag landed call
    // `createDeps()` and `createDeps(N)`. Pin both shapes to catch a
    // future change that silently breaks the standalone emit path
    // (no static guard exists outside of running an emitted module).
    const defaultDeps = createDeps();
    expect(defaultDeps.maxErrors).toBe(Number.POSITIVE_INFINITY);
    expect(defaultDeps.errorsRemaining).toBe(Number.POSITIVE_INFINITY);
    expect(defaultDeps.formats.has("regex")).toBe(true);

    const cappedDeps = createDeps(5);
    expect(cappedDeps.maxErrors).toBe(5);
    expect(cappedDeps.errorsRemaining).toBe(5);

    const optionsDeps = createDeps({ maxErrors: 7 });
    expect(optionsDeps.maxErrors).toBe(7);
    expect(optionsDeps.errorsRemaining).toBe(7);
  });

  it("CompiledRegex shape: returning a duck-typed object with .test() works", () => {
    // Pin the contract: the runtime only reads .test(s). Anything that
    // satisfies CompiledRegex is acceptable as a compiler return value.
    const compiler: RegexCompiler = (pattern): CompiledRegex => ({
      test(s) {
        return s === pattern.replace(/^\^|\$$/g, "");
      },
    });
    const { validate } = compileSchema(
      { type: "string", pattern: "^hello$" },
      { dialect: jsonSchemaDialect, regexCompiler: compiler },
    );
    expect(validate("hello").valid).toBe(true);
    expect(validate("world").valid).toBe(false);
  });
});

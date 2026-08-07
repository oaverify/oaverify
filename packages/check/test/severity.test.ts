import { describe, expect, it } from "vitest";
import { CHECK_CODES, CHECK_FAMILIES } from "../src/codes.js";
import {
  defaultSeverityFor,
  EMPTY_SEVERITY_MAP,
  parseSeverityMap,
  severityFor,
  SeverityMapError,
} from "../src/severity.js";

const parse = (...entries: string[]) => parseSeverityMap(entries);

const grade = (map: ReturnType<typeof parse>, cls: string, code: string) =>
  severityFor(map, { class: cls, code }, "warning");

describe("what oaverify grades by default", () => {
  it("keeps the table and the two hygiene exceptions", () => {
    expect(defaultSeverityFor("conformance", "type")).toBe("error");
    expect(defaultSeverityFor("schema", "unsatisfiable/pattern-length")).toBe("warning");
    expect(defaultSeverityFor("examples", "example-invalid")).toBe("warning");
    expect(defaultSeverityFor("redos", "ambiguous-pattern")).toBe("warning");
    // Spec violations, not taste.
    expect(defaultSeverityFor("hygiene", "path-param-undeclared")).toBe("error");
    expect(defaultSeverityFor("hygiene", "path-param-unused")).toBe("error");
    expect(defaultSeverityFor("hygiene", "path-template-malformed")).toBe("error");
    // Legal and merely dead.
    expect(defaultSeverityFor("hygiene", "unused-component")).toBe("warning");
  });
});

describe("the three key spaces", () => {
  it("maps a whole class", () => {
    expect(grade(parse("redos=error"), "redos", "ambiguous-pattern")).toBe("error");
  });

  it("maps a code family", () => {
    const map = parse("unsatisfiable/*=error");
    expect(grade(map, "schema", "unsatisfiable/pattern-length")).toBe("error");
    expect(grade(map, "schema", "unsatisfiable/enum-member-type")).toBe("error");
    // A different family in the same class is untouched.
    expect(grade(map, "schema", "silent-rewrite/ref-siblings-oas30")).toBe("warning");
  });

  it("maps an exact code", () => {
    expect(
      grade(parse("unsatisfiable/pattern-length=fatal"), "schema", "unsatisfiable/pattern-length"),
    ).toBe("fatal");
  });

  it("maps a code with no family in its name", () => {
    // Both `hygiene`; refused before the registry existed.
    const map = parse("unused-component=error");
    expect(grade(map, "hygiene", "unused-component")).toBe("error");
    expect(grade(map, "hygiene", "unused-tag")).toBe("warning");
  });

  it("leaves anything unmapped on its default", () => {
    expect(grade(parse("redos=error"), "schema", "unknown-keyword")).toBe("warning");
  });
});

describe("precedence: most specific wins, whatever the order", () => {
  const both = [
    "unsatisfiable/*=error,unsatisfiable/pattern-length=warning",
    "unsatisfiable/pattern-length=warning,unsatisfiable/*=error",
  ];

  it.each(both)("resolves code over family for %s", (entry) => {
    const map = parse(entry);
    expect(grade(map, "schema", "unsatisfiable/pattern-length")).toBe("warning");
    expect(grade(map, "schema", "unsatisfiable/enum-member-type")).toBe("error");
  });

  it("resolves family over class", () => {
    const map = parse("schema=fatal,unsatisfiable/*=warning");
    expect(grade(map, "schema", "unsatisfiable/pattern-length")).toBe("warning");
    expect(grade(map, "schema", "unknown-keyword")).toBe("fatal");
  });
});

describe("input the flag refuses rather than half-applies", () => {
  it("refuses malformed, by class and by code", () => {
    // The exit code for a malformed document is 4 and outranks
    // `--fail-on`, so a remap would change the printed severity and
    // nothing else. Looking like it worked is the failure to avoid.
    for (const key of ["malformed", "malformed-schema"]) {
      expect(() => parse(`${key}=warning`)).toThrow(SeverityMapError);
      expect(() => parse(`${key}=warning`)).toThrow(/always fatal and always exit 4/);
    }
  });

  it("refuses an entry that is not key=level", () => {
    expect(() => parse("redos")).toThrow(/is not <key>=<level>/);
  });

  it("refuses a level that is not a severity, naming the ones that are", () => {
    expect(() => parse("redos=nope")).toThrow(/expected warning, error, fatal/);
    expect(() => parse("redos=")).toThrow(/no level/);
  });

  it("refuses a bare word that is neither a class nor a code", () => {
    // Accepting it as a code would match nothing and grade nothing,
    // which is the silent failure this option exists to prevent.
    expect(() => parse("typo=error")).toThrow(/is not a class .* or a code oaverify emits/);
  });

  it("refuses a star anywhere but a trailing /*", () => {
    expect(() => parse("un*safe=error")).toThrow(/only allowed as a trailing/);
  });

  // #632: both parsed, graded nothing, exited 0.
  it("refuses a code no check emits, naming the family's real members", () => {
    expect(() => parse("unsatisfiable/patern-length=error")).toThrow(
      /is not a code oaverify emits/,
    );
    expect(() => parse("unsatisfiable/patern-length=error")).toThrow(
      /"unsatisfiable\/" holds unsatisfiable\/enum-member-type, unsatisfiable\/pattern-length/,
    );
  });

  it("falls back to naming the families when the family is wrong too", () => {
    expect(() => parse("unsatisfyable/pattern-length=error")).toThrow(
      /known families are silent-rewrite, unsatisfiable/,
    );
  });

  it("refuses a family no code sits in", () => {
    expect(() => parse("unsatisfyable/*=error")).toThrow(/is not a code family/);
  });

  it("still accepts every real code and family", () => {
    for (const code of CHECK_CODES) {
      if (code === "malformed-schema") continue; // refused as malformed, before the lookup
      expect(() => parse(`${code}=error`)).not.toThrow();
    }
    for (const family of CHECK_FAMILIES) {
      expect(() => parse(`${family}/*=error`)).not.toThrow();
    }
  });
});

describe("parsing shape", () => {
  it("splits on commas and accepts a repeated flag", () => {
    const map = parse("redos=error,examples=fatal", "conformance=warning");
    expect(grade(map, "redos", "x")).toBe("error");
    expect(grade(map, "examples", "x")).toBe("fatal");
    expect(grade(map, "conformance", "x")).toBe("warning");
  });

  it("tolerates whitespace and empty entries", () => {
    const map = parse(" redos = error , , examples=fatal ");
    expect(grade(map, "redos", "x")).toBe("error");
    expect(grade(map, "examples", "x")).toBe("fatal");
  });

  it("an empty map grades nothing", () => {
    expect(grade(EMPTY_SEVERITY_MAP, "schema", "anything")).toBe("warning");
  });
});

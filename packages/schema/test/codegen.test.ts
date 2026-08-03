import { describe, expect, it } from "vitest";
import { CodeGen, Scope, pathJoinExpr, quoteString, rawExpr } from "../src/codegen/index.js";

describe("CodeGen", () => {
  it("produces valid JavaScript that eval survives", () => {
    const gen = new CodeGen();
    gen.const("x", "1 + 2");
    gen.line("return x;");
    const body = gen.toString();
    const fn = new Function(body);
    expect(fn()).toBe(3);
  });

  it("emits a for-of loop body", () => {
    const gen = new CodeGen();
    gen.let("total", "0");
    gen.forOf("v", "[1, 2, 3]", (g) => g.line("total += v;"));
    gen.line("return total;");
    const fn = new Function(gen.toString());
    expect(fn()).toBe(6);
  });
});

describe("Scope", () => {
  it("hands out unique names per prefix", () => {
    const s = new Scope();
    expect(s.name("i")).toBe("i0");
    expect(s.name("i")).toBe("i1");
    expect(s.name("j")).toBe("j0");
  });
});

describe("quoteString", () => {
  it("escapes quotes, newlines, and backslashes", () => {
    expect(quoteString('a"b\n\\c')).toBe('"a\\"b\\n\\\\c"');
  });
});

describe("pathJoinExpr", () => {
  it("returns the base expression when no segments are appended", () => {
    expect(pathJoinExpr("path", [])).toBe("path");
  });

  it("appends quoted strings and numbers", () => {
    expect(pathJoinExpr("path", ["foo", 3])).toBe('[...path, "foo", 3]');
  });

  it("embeds raw expressions verbatim", () => {
    expect(pathJoinExpr("path", ["users", rawExpr("i0")])).toBe('[...path, "users", i0]');
  });
});

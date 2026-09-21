/**
 * The docs/spec-boundaries.md renderer in `scripts/spec-boundary-doc.mjs`.
 *
 * Tested here for the reason `test/spec-boundary-lint.test.ts` gives:
 * `scripts/` has no vitest of its own.
 *
 * The page is asserted against the source by `pnpm check:boundaries-doc`, so a
 * rendering bug cannot make the gate red on its own: the gate compares the
 * committed page against this renderer's output, and both move together. What
 * these cover is how source tags become readable entries and how readers
 * navigate the generated inventory.
 */

import { describe, expect, it } from "vitest";
import {
  collectBoundaries,
  labelFromUrl,
  renderDoc,
  unlink,
  // @ts-expect-error -- plain ESM module, no declarations emitted for scripts/
} from "../scripts/spec-boundary-doc.mjs";

const RFC = "https://www.rfc-editor.org/rfc/rfc9562#section-4";
const SUB = "https://www.rfc-editor.org/rfc/rfc4648#section-3.5";

/** A source file carrying one documented, tagged declaration. */
const file = (path: string, body: string[], decl = "export function validateThing() {}") => ({
  path,
  source: `/**\n${body.map((l) => ` * ${l}`).join("\n")}\n */\n${decl}\n`,
});

const rows = (files: Array<{ path: string; source: string }>) =>
  collectBoundaries(files) as Array<Record<string, string | number>>;

describe("unlink", () => {
  it("resolves an inline link to a bare symbol", () => {
    expect(unlink("see {@link validateTime} for the rule")).toBe("see `validateTime` for the rule");
  });

  it("keeps only the member name of a qualified target", () => {
    expect(unlink("{@link CompileOptions.maxDepth}")).toBe("`maxDepth`");
  });

  it("drops the display-text half of a piped link", () => {
    expect(unlink("{@link validateByteRfc4648 | the strict reading}")).toBe(
      "`validateByteRfc4648`",
    );
  });

  it("leaves prose with no link untouched", () => {
    expect(unlink("a plain sentence")).toBe("a plain sentence");
  });
});

describe("labelFromUrl", () => {
  it.each([
    "https://json-schema.org.example.test/draft/2020-12/",
    "https://example.test/json-schema.org",
    "https://yaml.org.example.test/spec/1.2.2/",
    "https://example.test/?spec=yaml.org",
    "https://yaml.org@example.test/spec/1.2.2/",
    "https://example.test/spec.openapis.org/registry/format/",
    "https://example.test/spec.openapis.org/overlay/v1.0.0.html",
    "https://example.test/spec.openapis.org/oas/v3.1.0",
    "https://example.test/oasis-open.org/sarif/v2.1.0/",
    "https://example.test/rfc/rfc9562#section-4",
    "https://spec.openapis.org/?next=/oas/v3.1.0",
    "not a URL: json-schema.org",
  ])("does not infer a specification label from %s", (url) => {
    expect(labelFromUrl(url)).toBe(url);
  });

  it("names an RFC section", () => {
    expect(labelFromUrl(SUB)).toBe("RFC 4648 section 3.5");
  });

  it("names an RFC appendix as an appendix", () => {
    expect(labelFromUrl("https://datatracker.ietf.org/doc/html/rfc3339#appendix-A")).toBe(
      "RFC 3339 appendix A",
    );
  });

  it("names a bare RFC", () => {
    expect(labelFromUrl("https://www.rfc-editor.org/rfc/rfc9457")).toBe("RFC 9457");
  });

  it("names the non-RFC specification hosts", () => {
    expect(labelFromUrl("https://spec.openapis.org/registry/format/")).toBe(
      "the OpenAPI Format Registry",
    );
    expect(labelFromUrl("https://spec.openapis.org/overlay/v1.0.0.html")).toBe(
      "OpenAPI Overlay 1.0",
    );
    expect(labelFromUrl("https://spec.openapis.org/oas/v3.1.0#paths-object")).toBe("OpenAPI 3.1.0");
    expect(labelFromUrl("https://yaml.org/spec/1.2.2/")).toBe("YAML 1.2");
    expect(labelFromUrl("https://docs.oasis-open.org/sarif/sarif/v2.1.0/x.html")).toBe(
      "SARIF 2.1.0",
    );
  });

  it("falls back to the URL it cannot name", () => {
    expect(labelFromUrl("https://tc39.es/ecma262/#sec-patterns")).toBe(
      "https://tc39.es/ecma262/#sec-patterns",
    );
  });
});

describe("collectBoundaries", () => {
  it("prefers the boundary's own URL over the declaration's citation", () => {
    // The case the ambiguous-anchor rule produces: taking cites[0] here would
    // label a section-3.5 boundary as section 4.
    const got = rows([
      file("packages/formats/src/base64.ts", [
        `@specCites RFC 4648 section 4, ${RFC}`,
        `@specBoundary under-asserts ${SUB}`,
        "Unused bits are not checked.",
      ]),
    ]);
    expect(got[0]?.url).toBe(SUB);
    expect(got[0]?.label).toBe("RFC 4648 section 3.5");
  });

  it("uses the citation's own label when the boundary shares its URL", () => {
    const got = rows([
      file("packages/formats/src/misc.ts", [
        `@specCites RFC 9562 section 4, ${RFC}`,
        "@specBoundary under-asserts",
        "A UUID carrying an undefined version passes.",
      ]),
    ]);
    expect(got[0]?.label).toBe("RFC 9562 section 4");
  });

  it("records the package, symbol and line a boundary sits on", () => {
    const got = rows([
      file("packages/router/src/matcher.ts", [
        `@specCites OpenAPI 3.1, ${RFC}`,
        "@specBoundary chooses",
        "A request matching both routes to the first.",
      ]),
    ]);
    expect(got[0]).toMatchObject({ pkg: "router", symbol: "validateThing", line: 1 });
  });

  it("keeps both halves of one decision carried at two layers", () => {
    // `maxDepth` is tagged on the compiler and on the validator. They are two
    // entries on purpose; a reader arrives at one surface or the other.
    const got = rows([
      file("packages/schema/src/compiler/compiler.ts", [
        `@specCites JSON Schema, ${RFC}`,
        "@specBoundary narrows",
        "Deeper than the cap is invalid.",
      ]),
      file("packages/validator/src/validator.ts", [
        `@specCites JSON Schema, ${RFC}`,
        "@specBoundary narrows",
        "Deeper than the cap is a 400.",
      ]),
    ]);
    expect(got).toHaveLength(2);
  });

  it("sorts by package so the page groups", () => {
    const got = rows([
      file("packages/validator/src/v.ts", [`@specCites x, ${RFC}`, "@specBoundary narrows", "B."]),
      file("packages/core/src/c.ts", [`@specCites x, ${RFC}`, "@specBoundary narrows", "A."]),
    ]);
    expect(got.map((r) => r.pkg)).toEqual(["core", "validator"]);
  });

  it("returns nothing for a file with citations but no boundaries", () => {
    expect(rows([file("packages/core/src/c.ts", [`@specCites x, ${RFC}`])])).toEqual([]);
  });
});

describe("renderDoc", () => {
  const page = () =>
    renderDoc(
      collectBoundaries([
        file("packages/formats/src/misc.ts", [
          `@specCites RFC 9562 section 4, ${RFC}`,
          "@specBoundary under-asserts",
          "A UUID carrying an undefined version passes, see {@link validateUuid}.",
        ]),
      ]),
    ) as string;

  it("identifies the intended contract without promising complete conformance", () => {
    expect(page()).toContain("A citation identifies the\nintended specification contract");
    expect(page()).toContain(
      "absence of a recorded boundary does not\nestablish complete conformance",
    );
  });

  it("explains the limits of entry counts", () => {
    expect(page()).toContain("they do not measure defect\nseverity or conformance");
  });

  it("carries a count per kind and a total", () => {
    const out = page();
    expect(out).toContain("| `under-asserts` | accepts what the cited spec forbids | 1 |");
    expect(out).toContain("1 documented entries across 1 files.");
  });

  it("omits a kind with no entries rather than printing an empty section", () => {
    const out = page();
    expect(out).toContain("\n### under-asserts\n");
    expect(out).not.toContain("\n### transforms\n");
  });

  it("groups entries by implementation area, then kind and package, keeping every entry once", () => {
    const fixtures = [
      ["check", "under-asserts"],
      ["stream-validator", "narrows"],
      ["stream-validator", "under-asserts"],
      ["validator", "under-asserts"],
      ["formats", "narrows"],
      ["formats", "under-asserts"],
      ["oav-express4", "under-asserts"],
    ];
    const out = renderDoc(
      collectBoundaries(
        fixtures.map(([pkg, kind]) =>
          file(`packages/${pkg}/src/example.ts`, [
            `@specCites x, ${RFC}`,
            `@specBoundary ${kind}`,
            `Boundary for ${pkg}: ${kind}.`,
          ]),
        ),
      ),
    ) as string;
    expect(out.match(/^#{2,4} .+$/gm)).toEqual([
      "## Schema and HTTP validation",
      "### under-asserts",
      "#### packages/formats",
      "#### packages/oav-express4",
      "#### packages/validator",
      "### narrows",
      "#### packages/formats",
      "## Streaming-specific behavior",
      "### under-asserts",
      "#### packages/stream-validator",
      "### narrows",
      "#### packages/stream-validator",
      "## Document loading and tooling",
      "### under-asserts",
      "#### packages/check",
      "## Regenerating",
    ]);
    for (const [pkg, kind] of fixtures) {
      expect(out.split(`Boundary for ${pkg}: ${kind}.`)).toHaveLength(2);
    }
    expect(out).toContain("[Streaming-specific behavior](#streaming-specific-behavior)");
    expect(out).toContain("[Document loading and tooling](#document-loading-and-tooling)");
    expect(out).toContain("Buffered\nsubtrees use the in-memory schema compiler");
    expect(out).toContain("[schema and format boundaries](#schema-and-http-validation)");
  });

  it("omits empty implementation areas from headings and navigation", () => {
    expect(page()).toContain("[Schema and HTTP validation](#schema-and-http-validation)");
    expect(page()).not.toContain("Streaming-specific behavior");
    expect(page()).not.toContain("Document loading and tooling");
  });

  it("refuses to silently omit a package with no section mapping", () => {
    expect(() =>
      renderDoc(
        collectBoundaries([
          file("packages/new-package/src/example.ts", [
            `@specCites x, ${RFC}`,
            "@specBoundary narrows",
            "A boundary awaiting a section.",
          ]),
        ]),
      ),
    ).toThrow("packages/new-package has no section in SECTIONS");
  });

  it("links the declaration and resolves inline links in the body", () => {
    const out = page();
    expect(out).toContain("(../packages/formats/src/misc.ts#L1)");
    expect(out).toContain("`validateUuid`");
    expect(out).not.toContain("{@link");
  });

  it("tells a reader not to edit it by hand", () => {
    expect(page()).toContain("Do not edit this file by hand");
  });
});

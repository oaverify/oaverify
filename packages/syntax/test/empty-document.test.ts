import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createYamlFileReader, loadSpecSync, parseYamlString } from "../src/index.js";

/**
 * A YAML file that is empty, whitespace, or comments only parses to
 * `null`. Returning that handed the caller a document-shaped hole, and
 * `loadSpecSync` answered `{ document: null }` without throwing (#850).
 *
 * The JSON sibling throws `Unexpected end of JSON input` for the same
 * input, so the two readers disagreed about whether a file contained
 * anything. They agree now.
 */
const dir = mkdtempSync(join(tmpdir(), "oav-850-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
};

describe("a YAML source carrying no document (#850)", () => {
  describe.each([
    ["empty", ""],
    ["whitespace only", "   \n\n  \n"],
    ["comments only", "# just a comment\n# and another\n"],
  ])("%s", (label, body) => {
    it("is refused by the file reader, naming the file", async () => {
      const path = write(`${label.replace(/\s+/g, "-")}.yaml`, body);
      const reader = createYamlFileReader(dir);

      await expect(reader.read(path)).rejects.toThrow(/contains no document/);
      await expect(reader.read(path)).rejects.toThrow(/\.yaml/);
    });

    it("is refused by loadSpecSync rather than loading as null", () => {
      const path = write(`sync-${label.replace(/\s+/g, "-")}.yaml`, body);
      expect(() => loadSpecSync({ entry: path })).toThrow(/contains no document/);
    });
  });

  it("still loads a real document", () => {
    const path = write(
      "real.yaml",
      "openapi: 3.1.0\ninfo:\n  title: t\n  version: '1'\npaths: {}\n",
    );
    expect(loadSpecSync({ entry: path }).document.openapi).toBe("3.1.0");
  });

  it("accepts a scalar, which is a document even though it is not a spec", async () => {
    // The reader answers "did this file contain a document", not "is
    // this a spec". A `$ref` target is not always an object, and JSON
    // accepts `42` and `true` too.
    const path = write("scalar.yaml", "true\n");
    await expect(createYamlFileReader(dir).read(path)).resolves.toBe(true);
  });

  it.each([
    ["an explicit null", "null\n"],
    ["a tilde", "~\n"],
    ["a bare document marker", "---\n"],
  ])("treats %s as a document whose value is null, matching JSON", async (_l, body) => {
    // The guard is about a source with no content node, not about a
    // null value. `JSON.parse("null")` returns null too, and these
    // readers must not disagree with their JSON siblings on the same
    // content.
    const path = write(`nullish-${body.trim().replace(/[^a-z]/gi, "x")}.yaml`, body);
    await expect(createYamlFileReader(dir).read(path)).resolves.toBeNull();
  });

  it("leaves parseYamlString with raw parse semantics", () => {
    // The primitive is for callers who want the parser rather than a
    // spec loader, so it keeps returning null. Stated here so the
    // difference from the readers is deliberate rather than an
    // oversight.
    expect(parseYamlString("# nothing here\n")).toBeNull();
  });
});

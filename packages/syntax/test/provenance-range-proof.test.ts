import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LineCounter, parseDocument } from "yaml";
import { composeReaders, createFileReader, loadSpec, sourceOf } from "@oaverify/internal-spec";
import { createYamlFileReader } from "../src/index.js";

/**
 * Proof for BRIEF 3c: a line/column range can be added to a finding's
 * source address later without changing what `uri`, `pointer` or `via`
 * mean.
 *
 * The argument is that `(uri, pointer)` is a *complete* address into a
 * source file, so a range is a pure function of that address and a
 * position-retaining parse of that one document. Nothing here touches
 * the resolver, the reader contract, or any side channel: the range is
 * computed after `loadSpec` has finished, from the address it already
 * returned.
 *
 * **What this does not prove**, stated here so the file is not read as
 * a reader design (#596 still has to make that call):
 *
 * - It is not efficient. Re-parsing a document per finding is O(findings
 *   x file size). A production path needs a cache or a reader capability
 *   that retains ranges during the load.
 * - It is YAML only. JSON goes through `JSON.parse`, which discards
 *   positions irrecoverably, and a position-preserving JSON parser is a
 *   new dependency that `@oaverify/core` does not take.
 * - Nothing in this spike ships `region` in `check` output.
 */

const ENTRY = `openapi: 3.1.0
info: { title: X, version: "1" }
paths:
  /orders:
    post:
      responses: { "200": { description: ok } }
      requestBody:
        content:
          application/json:
            schema:
              $ref: "./order.yaml#/components/schemas/Order"
`;

// Line 1 is `components:`, so `required:` is on line 5 (1-based) and
// the defect `nope` is the second entry of that sequence.
const ORDER = `components:
  schemas:
    Order:
      type: object
      required: [id, nope]
      properties:
        id: { type: string }
`;

/**
 * Line and column of the node a source address names, by re-parsing
 * that one document. The whole point is that this needs nothing but the
 * address.
 */
function rangeAt(uri: string, pointer: string): { line: number; column: number; text: string } {
  const text = readFileSync(uri, "utf8");
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  const path = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
  if (node?.range === undefined) throw new Error(`no node at ${pointer} in ${uri}`);
  const [start, end] = node.range;
  const pos = lineCounter.linePos(start);
  return { line: pos.line, column: pos.col, text: text.slice(start, end) };
}

describe("a YAML range populates from a source address, without changing it", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oav-range-"));
    writeFileSync(join(dir, "entry.yaml"), ENTRY);
    writeFileSync(join(dir, "order.yaml"), ORDER);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const address = async () => {
    const reader = composeReaders([createYamlFileReader(dir), createFileReader(dir)]);
    const { regions } = await loadSpec({ reader, entry: "entry.yaml", provenance: true });
    const source = sourceOf(regions ?? [], "/components/schemas/Order/required");
    expect(source).toBeDefined();
    return source;
  };

  it("lands on the line the author wrote, in the file the author wrote it in", async () => {
    const source = await address();
    expect(source?.uri).toBe("order.yaml");

    const range = rangeAt(join(dir, source?.uri ?? ""), source?.pointer ?? "");
    expect(range.line).toBe(5);
    expect(range.text).toBe("[id, nope]");
  });

  it("follows a hop back to the reference that pulled the file in", async () => {
    const source = await address();
    const hop = source?.via[0];
    expect(hop?.uri).toBe("entry.yaml");

    // The same function, applied to a hop rather than to the address:
    // hops are addresses of the same shape, so they resolve the same way.
    const range = rangeAt(join(dir, hop?.uri ?? ""), hop?.pointer ?? "");
    expect(range.line).toBe(11);
    expect(range.text.trim()).toBe('$ref: "./order.yaml#/components/schemas/Order"');
  });

  it("leaves uri, pointer and via identical whether or not a range is computed", async () => {
    // The load is the same load. Computing a range is downstream of it
    // and cannot feed back into it, which is the whole claim: `region`
    // lands as an additional field on an address that is already fixed,
    // rather than as a change to what any existing field means.
    const before = await address();
    rangeAt(join(dir, before?.uri ?? ""), before?.pointer ?? "");
    const after = await address();
    expect(after).toEqual(before);
  });
});

import { expect, it } from "vitest";
import { createMemoryReader, loadSpec } from "@oaverify/internal-spec";
import { checkSpec } from "../src/check.js";

it.each([7, null, {}, "tag"])(
  "grades malformed operation tags as conformance findings: %j",
  async (tags) => {
    const document = {
      openapi: "3.1.0",
      info: { title: "T", version: "1" },
      tags: [{ name: "tag" }],
      paths: { "/a": { get: { tags, responses: { "200": { description: "ok" } } } } },
    };
    const resolved = await loadSpec({
      entry: "entry.json",
      reader: createMemoryReader(new Map([["entry.json", document]])),
    });
    const findings = checkSpec(resolved);
    expect(findings).toContainEqual(
      expect.objectContaining({
        class: "conformance",
        target: expect.objectContaining({ pointer: "/paths/~1a/get/tags" }),
      }),
    );
    expect(findings).toContainEqual(expect.objectContaining({ code: "unused-tag" }));
  },
);

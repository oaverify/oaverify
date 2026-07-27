import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createValidator } from "@oav/validator";
import { loadSpecSync } from "../src/index.js";

// The batteries-included loadSpecSync: YAML entry + cross-file $ref on
// disk, resolved synchronously and handed to createValidator. This is
// the load-once-at-boot path the feature exists for.

describe("oav loadSpecSync (YAML + JSON on disk)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oav-batteries-loadsync-"));
    mkdirSync(join(dir, "schemas"));
    // Entry is YAML; the referenced schema is JSON. The default reader
    // composes the YAML reader ahead of the JSON one, so both resolve.
    writeFileSync(
      join(dir, "openapi.yaml"),
      [
        "openapi: 3.1.0",
        "info:",
        "  title: Batteries",
        "  version: '1'",
        "paths:",
        "  /pets:",
        "    post:",
        "      requestBody:",
        "        content:",
        "          application/json:",
        "            schema:",
        "              $ref: schemas/pet.json",
        "      responses:",
        "        '201':",
        "          description: created",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "schemas", "pet.json"),
      JSON.stringify({
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads a YAML spec with a cross-file $ref and builds a working validator", () => {
    const { document } = loadSpecSync({ entry: join(dir, "openapi.yaml") });
    expect(document.info.title).toBe("Batteries");

    const validator = createValidator(document);
    const ok = validator.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      body: { name: "Rex" },
    });
    expect(ok.valid).toBe(true);

    const bad = validator.validateRequest({
      method: "POST",
      path: "/pets",
      contentType: "application/json",
      body: {},
    });
    expect(bad.valid).toBe(false);
  });

  it("applies overlays through the batteries loader", () => {
    const { document } = loadSpecSync({
      entry: join(dir, "openapi.yaml"),
      overlays: [{ info: { title: "Renamed" } }],
    });
    expect(document.info.title).toBe("Renamed");
  });

  it("throws on a missing entry (caller owns the disable-on-failure policy)", () => {
    expect(() => loadSpecSync({ entry: join(dir, "absent.yaml") })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { compile } from "./helpers.js";
import type { SchemaOrBoolean } from "@oaverify/internal-core";

/**
 * The compiler short-circuits its evaluated-keys-tracking machinery
 * when no schema in the compile unit uses `unevaluatedProperties` /
 * `unevaluatedItems`. Observable via
 * `stats.unevaluatedTrackingEmitted`:
 * - When tracking is off, no `evalProps` / `evalItems` Sets are
 *   allocated and no merge loop runs at function exit.
 * - When tracking is on, both appear and the stat flips to `true`.
 * The flag is compile-unit-wide: if *any* reachable schema triggers
 * it, tracking stays on everywhere so `unevaluated*` observes all
 * evaluated keys from sibling applicators and $ref targets.
 */
describe("unevaluated-tracking compile-time gating", () => {
  it("omits evaluated-keys Sets when no schema uses unevaluated*", () => {
    const v = compile({
      type: "object",
      properties: {
        inner: {
          allOf: [{ properties: { x: { type: "string" } } }, { required: ["x"] }],
        },
      },
    });
    expect(v.stats.unevaluatedTrackingEmitted).toBe(false);
    // Sanity-check that the compiled validator still works.
    expect(v.validate({ inner: { x: "a" } }).valid).toBe(true);
    expect(v.validate({ inner: { x: 1 } }).valid).toBe(false);
  });

  it("keeps evaluated-keys Sets when a schema uses unevaluatedProperties", () => {
    const v = compile({
      type: "object",
      properties: { a: { type: "string" } },
      unevaluatedProperties: false,
    });
    expect(v.stats.unevaluatedTrackingEmitted).toBe(true);
    expect(v.validate({ a: "x" }).valid).toBe(true);
    expect(v.validate({ a: "x", extra: 1 }).valid).toBe(false);
  });

  it("keeps evaluated-keys Sets when the trigger is deep inside $defs", () => {
    // A schema that doesn't mention unevaluated* at its root, but
    // does through a $def reachable via $ref. The walker descends the
    // full tree so tracking stays on.
    const v = compile({
      $defs: {
        Strict: {
          type: "object",
          properties: { a: { type: "string" } },
          unevaluatedProperties: false,
        },
      },
      $ref: "#/$defs/Strict",
    });
    expect(v.stats.unevaluatedTrackingEmitted).toBe(true);
    expect(v.validate({ a: "x", extra: 1 }).valid).toBe(false);
  });

  it("turns tracking on when an external schema uses unevaluated*", () => {
    // The root itself doesn't mention unevaluated*, but it $refs an
    // external schema that does. The walker must pick that up from
    // `options.external` so the external's compiled function emits
    // the tracking machinery when it's reached through the ref.
    const external = new Map<string, SchemaOrBoolean>([
      [
        "ext://strict",
        {
          $id: "ext://strict",
          type: "object",
          properties: { a: { type: "string" } },
          unevaluatedProperties: false,
        },
      ],
    ]);
    const v = compile({ $ref: "ext://strict" }, { external });
    expect(v.stats.unevaluatedTrackingEmitted).toBe(true);
    expect(v.validate({ a: "x" }).valid).toBe(true);
    expect(v.validate({ a: "x", extra: 1 }).valid).toBe(false);
  });

  it("does not confuse user data (enum / default / examples) with schema positions", () => {
    // `default` / `enum` can contain arbitrary JSON, including the
    // literal string "unevaluatedProperties" as a key. The walker must
    // only descend into schema-valued positions, not arbitrary data.
    const v = compile({
      type: "object",
      properties: { a: { type: "string" } },
      default: { unevaluatedProperties: false },
      enum: [{ unevaluatedProperties: "literal" }],
    });
    expect(v.stats.unevaluatedTrackingEmitted).toBe(false);
  });
});

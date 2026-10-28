import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { loadSpec, loadSpecSync } from "../src/load.js";
import { createMemoryReader, type SyncDocumentReader } from "../src/reader.js";
import { resolveSpec } from "../src/resolver.js";
import { resolveSpecSync } from "../src/resolver-sync.js";

const document = { openapi: "3.1.0", info: { title: "Sync", version: "1" }, paths: {} };

function readerValueWithThen(value: object, then: unknown): object {
  Reflect.set(value, "then", then);
  return value;
}

describe.each([
  ["resolveSpecSync", resolveSpecSync],
  ["loadSpecSync", loadSpecSync],
] as const)("%s reader contract", (_name, load) => {
  it("rejects the asynchronous memory reader at the entry", () => {
    const reader = createMemoryReader(new Map([["main.json", document]]));
    expect(() => load({ entry: "main.json", reader })).toThrow(
      /main\.json.*thenable.*resolveSpec.*synchronous reader/,
    );
  });

  it.each([
    ["Promise", () => Promise.resolve(document)],
    [
      "object thenable",
      () => readerValueWithThen({}, (resolve: (value: unknown) => void) => resolve(document)),
    ],
    [
      "callable thenable",
      () =>
        readerValueWithThen(
          () => {},
          (resolve: (value: unknown) => void) => resolve(document),
        ),
    ],
  ] as const)("rejects a %s returned for an external document", (_kind, value) => {
    const entry = {
      ...document,
      paths: {
        "/a": {
          get: {
            responses: {
              "200": { $ref: "responses.json#/Ok" },
            },
          },
        },
      },
    };
    const reader: SyncDocumentReader = {
      canRead: () => true,
      read: (uri) => (uri === "main.json" ? entry : value()),
    };
    expect(() => load({ entry: "main.json", reader })).toThrow(
      /responses\.json.*main\.json.*thenable.*resolveSpec.*synchronous reader/,
    );
  });

  it("checks a deeper read even when earlier documents are synchronous", () => {
    const entry = { ...document, components: { schemas: { Entry: { $ref: "one.json" } } } };
    const reader: SyncDocumentReader = {
      canRead: () => true,
      read: (uri) =>
        uri === "main.json"
          ? entry
          : uri === "one.json"
            ? { type: "object", properties: { value: { $ref: "two.json" } } }
            : Promise.resolve({ type: "string" }),
    };
    expect(() => load({ entry: "main.json", reader })).toThrow(/two\.json.*thenable/);
  });

  it("keeps record mode's external read failures as holes", () => {
    const entry = { ...document, components: { schemas: { Entry: { $ref: "schema.json" } } } };
    const reader: SyncDocumentReader = {
      canRead: () => true,
      read: (uri) => (uri === "main.json" ? entry : Promise.resolve({ type: "string" })),
    };
    const resolved = load({ entry: "main.json", reader, onUnresolved: "record" });
    expect(resolved.unresolved).toHaveLength(1);
    expect(resolved.unresolved?.[0]?.message).toMatch(/schema\.json.*thenable/);
    expect(() => load({ entry: "schema.json", reader, onUnresolved: "record" })).toThrow(
      /thenable/,
    );
  });

  it("accepts ordinary document data with a non-callable then property", () => {
    const entry = readerValueWithThen({ ...document }, "a document field");
    const reader: SyncDocumentReader = { canRead: () => true, read: () => entry };
    expect(load({ entry: "main.json", reader }).document).toEqual(entry);
  });

  it("observes an async reader rejection after reporting the contract failure", async () => {
    const reader = {
      canRead: () => true,
      read: async () => {
        throw new Error("read failed");
      },
    };
    expect(() => load({ entry: "main.json", reader })).toThrow(/thenable/);
    // Vitest reports unhandled rejections after the synchronous throw.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("does not start a lazy thenable or read then twice", async () => {
    let calls = 0;
    let reads = 0;
    const value = new Proxy(
      {},
      {
        get(_target, key) {
          if (key !== "then") return undefined;
          reads++;
          return () => {
            calls++;
          };
        },
      },
    );
    expect(() =>
      load({ entry: "main.json", reader: { canRead: () => true, read: () => value } }),
    ).toThrow(/thenable/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(0);
    expect(reads).toBe(1);
  });

  it("observes rejected native promises from another realm", async () => {
    const reader = {
      canRead: () => true,
      read: () => runInNewContext('Promise.reject(new Error("read failed"))') as unknown,
    };
    expect(() => load({ entry: "main.json", reader })).toThrow(/thenable/);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});

it.each([resolveSpec, loadSpec])(
  "async loading still accepts the asynchronous reader",
  async (load) => {
    const reader = createMemoryReader(new Map([["main.json", document]]));
    expect((await load({ entry: "main.json", reader })).document).toEqual(document);
  },
);

import type { SchemaOrBoolean } from "@oaverify/internal-core";

/**
 * A URI-keyed registry of schemas. A single `Map` provides `add` / `get` /
 * `remove`; there is deliberately no separate `schemas` vs `refs` vs `cache`
 * distinction because that distinction always leaks.
 *
 * @public
 */
export class SchemaRegistry {
  private readonly map = new Map<string, SchemaOrBoolean>();

  /**
   * Register a schema under the given URI.
   *
   * @param uri - Absolute or scheme-less URI to key the schema by.
   * @param schema - The schema (object or boolean) to store.
   * @throws Error if the URI is already registered.
   *
   * @example
   * ```ts
   * reg.add("https://example.com/Pet", { type: "object" });
   * ```
   */
  add(uri: string, schema: SchemaOrBoolean): void {
    if (this.map.has(uri)) {
      throw new Error(`schema already registered: ${uri}`);
    }
    this.map.set(uri, schema);
  }

  /**
   * Look up a registered schema.
   *
   * @param uri - Registered URI.
   * @returns The schema, or `undefined` if the URI is unknown.
   *
   * @example
   * ```ts
   * const pet = reg.get("https://example.com/Pet");
   * ```
   */
  get(uri: string): SchemaOrBoolean | undefined {
    return this.map.get(uri);
  }

  /**
   * Test whether a URI is registered.
   *
   * @param uri - URI to probe.
   * @returns `true` when a schema is registered under `uri`.
   */
  has(uri: string): boolean {
    return this.map.has(uri);
  }

  /**
   * Remove a registered schema.
   *
   * @param uri - Registered URI to remove.
   * @returns `true` if a schema was removed, `false` if the URI was absent.
   */
  remove(uri: string): boolean {
    return this.map.delete(uri);
  }

  /**
   * The number of schemas currently registered.
   */
  get size(): number {
    return this.map.size;
  }

  /**
   * Remove all schemas.
   */
  clear(): void {
    this.map.clear();
  }

  /**
   * Iterate over `[uri, schema]` pairs currently in the registry.
   */
  entries(): IterableIterator<[string, SchemaOrBoolean]> {
    return this.map.entries();
  }
}

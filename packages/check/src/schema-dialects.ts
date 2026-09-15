import { detectOpenAPIVersion, type OpenAPIDocument } from "@oaverify/internal-core";
import {
  jsonSchemaDialect,
  oas30Dialect,
  openapi31Dialect,
  type Dialect,
} from "@oaverify/internal-schema";
import { refSiblingIsDiscarded, subschemaEntries } from "@oaverify/internal-schema/internals";
import { escapePointer, walkDocumentSchemas } from "@oaverify/internal-validator/internals";
import type { CheckFinding } from "./finding.js";

export interface EffectiveDialect {
  uri: string;
  dialect: Dialect | undefined;
  pointer: string;
}

/** An authored OpenAPI schema slot or an embedded schema resource. */
export interface SchemaRoot {
  schema: unknown;
  pointer: string;
}

function dialectAt(uri: string, pointer: string): EffectiveDialect {
  const normalized = uri.endsWith("#") ? uri.slice(0, -1) : uri;
  let dialect: Dialect | undefined;
  switch (normalized) {
    case "https://json-schema.org/draft/2020-12/schema":
      dialect = jsonSchemaDialect;
      break;
    case "https://spec.openapis.org/oas/3.1/dialect/base":
    case "https://spec.openapis.org/oas/3.2/dialect/base":
      dialect = openapi31Dialect;
      break;
  }
  return { uri, dialect, pointer };
}

/** Discover resource dialects without resolving references or compiling schemas. */
export function schemaDialects(document: OpenAPIDocument) {
  const dialect = detectOpenAPIVersion(document) === "3.0" ? oas30Dialect : openapi31Dialect;
  const fallback: EffectiveDialect = { uri: dialect.id, dialect, pointer: "" };
  const defaultDialect =
    dialect !== oas30Dialect && typeof document.jsonSchemaDialect === "string"
      ? dialectAt(document.jsonSchemaDialect, "/jsonSchemaDialect")
      : fallback;
  const roots: SchemaRoot[] = [];
  walkDocumentSchemas(document, {
    onSchemaRoot: (schema, pointer) => {
      roots.push({ schema, pointer });
    },
    onSchemaNode: () => false,
  });
  const resources: SchemaRoot[] = [];
  const nodes = new Map<object, { pointer: string; path: string; effective: EffectiveDialect }>();
  const positions = new Map<string, EffectiveDialect>();
  const schemasAt = new Map<string, unknown>();
  const unsupported = new Map<string, CheckFinding>();
  const supported = new Set<Dialect>();
  const entries: {
    schema: Record<string, unknown>;
    pointer: string;
    dialect: Dialect | undefined;
  }[] = [];
  const discover = (
    additional: readonly SchemaRoot[],
    inherited = defaultDialect,
    isRoot = true,
  ): void => {
    const pending = additional
      .map((root) => ({ ...root, path: "", effective: inherited, root: isRoot }))
      .reverse();
    while (pending.length > 0) {
      const { schema, pointer, path, effective: inherited, root } = pending.pop()!;
      const object =
        typeof schema === "object" && schema !== null && !Array.isArray(schema)
          ? (schema as Record<string, unknown>)
          : undefined;
      if (object !== undefined && nodes.has(object)) continue;
      const resource = root || (object !== undefined && typeof object.$id === "string");
      const effective =
        dialect !== oas30Dialect && resource && typeof object?.$schema === "string"
          ? dialectAt(object.$schema, `${pointer}/$schema`)
          : inherited;
      positions.set(pointer, effective);
      schemasAt.set(pointer, schema);
      if (effective.dialect === undefined) {
        unsupported.set(
          effective.pointer,
          dialectFinding(
            effective.pointer,
            `Schema dialect "${effective.uri}" is unsupported; dependent schema and example checks are withheld.`,
          ),
        );
      } else {
        supported.add(effective.dialect);
      }
      if (object === undefined) continue;
      nodes.set(object, { pointer, path, effective });
      entries.push({ schema: object, pointer, dialect: effective.dialect });
      if (resource && !root) resources.push({ schema, pointer });
      const children = [];
      for (const { key, value, at } of subschemaEntries(object)) {
        if (refSiblingIsDiscarded(object, key, dialect.rules.refSuppressesSiblings)) continue;
        const step =
          at === undefined ? key : typeof at === "number" ? `${key}[${at}]` : `${key}.${at}`;
        children.push({
          schema: value,
          pointer: `${pointer}/${key}${at === undefined ? "" : `/${escapePointer(String(at))}`}`,
          path: path === "" ? step : `${path}.${step}`,
          effective,
          root: false,
        });
      }
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
    }
  };
  discover(roots);
  const enclosing = (pointer: string) => {
    let parent = pointer;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      const effective = positions.get(parent);
      if (effective !== undefined) return { schema: schemasAt.get(parent), effective };
    }
    return undefined;
  };
  const rebuild = (original: readonly SchemaRoot[], additional: readonly SchemaRoot[]): void => {
    resources.length = 0;
    entries.length = 0;
    nodes.clear();
    positions.clear();
    schemasAt.clear();
    unsupported.clear();
    supported.clear();
    discover(original);
    // An ancestor discovered later still owns its descendants' resource scope.
    for (const root of [...additional].sort((a, b) => a.pointer.length - b.pointer.length)) {
      const parent = enclosing(root.pointer);
      discover([root], parent?.effective, parent === undefined);
    }
  };
  const effectiveFor = (schema: unknown, pointer?: string): EffectiveDialect =>
    (typeof schema === "object" && schema !== null ? nodes.get(schema)?.effective : undefined) ??
    (pointer === undefined ? undefined : positions.get(pointer)) ??
    defaultDialect;
  return {
    roots,
    resources,
    nodes,
    positions,
    entries,
    discover,
    enclosing,
    rebuild,
    dialect,
    defaultDialect,
    effectiveFor,
    unsupported,
    supported,
  };
}

export type SchemaDialects = ReturnType<typeof schemaDialects>;

export function dialectFinding(pointer: string, message: string): CheckFinding {
  return {
    class: "schema",
    code: "unsupported-schema-dialect",
    severity: "warning",
    location: pointer,
    message,
    target: { pointer, anchor: "node" },
  };
}

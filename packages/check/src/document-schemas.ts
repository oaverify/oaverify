import {
  detectOpenAPIVersion,
  pointerFromFragment,
  type OpenAPIDocument,
  type SchemaOrBoolean,
} from "@oaverify/internal-core";
import { builtInFormats } from "@oaverify/internal-formats";
import {
  createRefResolver,
  oas30Dialect,
  openapi31Dialect,
  resolve,
} from "@oaverify/internal-schema";
import {
  compileSchemaInContext,
  refSiblingIsDiscarded,
  schemaErrorPointer,
  subschemaEntries,
  type SchemaCompileContext,
} from "@oaverify/internal-schema/internals";
import { escapePointer, walkDocumentSchemas } from "@oaverify/internal-validator/internals";
import { schemaLabeler } from "./schema-label.js";
import type { CheckFinding } from "./finding.js";
import { defaultSeverityFor } from "./severity.js";

/** An OpenAPI schema slot is one compile entry; subschemas retain their composition context. */
interface SchemaRoot {
  schema: unknown;
  pointer: string;
}

/** Document positions and resource scope, shared by the checker's compile units. */
export function documentSchemas(document: OpenAPIDocument) {
  const roots: SchemaRoot[] = [];
  walkDocumentSchemas(document, {
    onSchemaRoot(schema, pointer) {
      roots.push({ schema, pointer });
    },
    onSchemaNode() {
      return false;
    },
  });
  const dialect = detectOpenAPIVersion(document) === "3.0" ? oas30Dialect : openapi31Dialect;
  const envelope = (entries: SchemaRoot[]) =>
    ({
      $defs: Object.fromEntries(entries.map((root, i) => [String(i), root.schema])),
    }) as SchemaOrBoolean;
  const resolveOptions = { refSuppressesSiblings: dialect.rules.refSuppressesSiblings };
  const rootErrors = new Map<SchemaRoot, unknown>();
  let graph;
  try {
    graph = resolve(envelope(roots), resolveOptions);
  } catch {
    // Programmatic inputs can contain cycles. Isolate a graph-building failure
    // before retrying the shared inventory, so unrelated entries still report.
    const safeRoots = roots.filter((root) => {
      try {
        resolve(envelope([root]), resolveOptions);
        return true;
      } catch (error) {
        rootErrors.set(root, error);
        return false;
      }
    });
    graph = resolve(envelope(safeRoots), resolveOptions);
  }
  graph.root = document as unknown as SchemaOrBoolean;
  const refs = createRefResolver(graph);
  const pointers = new WeakMap<object, string>();
  const paths = new WeakMap<object, string>();
  const pending = roots
    .filter((root) => !rootErrors.has(root))
    .map((root) => ({
      node: root.schema,
      pointer: root.pointer,
      path: "",
    }))
    .reverse();
  while (pending.length > 0) {
    const { node, pointer, path } = pending.pop()!;
    if (typeof node !== "object" || node === null || Array.isArray(node) || pointers.has(node))
      continue;
    pointers.set(node, pointer);
    paths.set(node, path);
    const children = [];
    for (const { key, value, at } of subschemaEntries(node as Record<string, unknown>)) {
      if (
        refSiblingIsDiscarded(
          node as Record<string, unknown>,
          key,
          dialect.rules.refSuppressesSiblings,
        )
      )
        continue;
      const step =
        at === undefined ? key : typeof at === "number" ? `${key}[${at}]` : `${key}.${at}`;
      children.push({
        node: value,
        pointer: `${pointer}/${key}${at === undefined ? "" : `/${escapePointer(String(at))}`}`,
        path: path === "" ? step : `${path}.${step}`,
      });
    }
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
  }
  const pointerOf = (schema: object): string | undefined => pointers.get(schema);
  const refPointer = (ref: string, from: object): string | undefined => {
    const base = graph.schemaBaseUri.get(from) ?? "";
    const target = refs.resolve(ref, base);
    if (typeof target === "object" && target !== null && pointers.has(target))
      return pointers.get(target);
    let absolute = ref;
    if (base !== "") {
      try {
        absolute = new URL(ref, base).href;
      } catch {
        /* Relative registry keys keep their spelling. */
      }
    }
    const hash = absolute.indexOf("#");
    const uri = hash === -1 ? absolute : absolute.slice(0, hash);
    const fragment = hash === -1 ? "" : absolute.slice(hash + 1);
    if (fragment !== "" && !fragment.startsWith("/")) return undefined;
    const root = uri === "" ? graph.root : graph.byId.get(uri);
    const prefix =
      root === graph.root
        ? ""
        : typeof root === "object" && root !== null
          ? pointers.get(root)
          : undefined;
    return prefix === undefined ? undefined : `${prefix}${pointerFromFragment(fragment)}`;
  };
  const contextFor = (schema: unknown): SchemaCompileContext => {
    const nodes: SchemaOrBoolean[] = [];
    const seen = new Set<unknown>();
    const bases = new Set<string>();
    const dynamicNames = new Set<string>();
    const visit = (node: unknown): void => {
      if (seen.has(node)) return;
      seen.add(node);
      nodes.push(node as SchemaOrBoolean);
      if (typeof node !== "object" || node === null || Array.isArray(node)) return;
      const obj = node as Record<string, unknown>;
      bases.add(graph.schemaBaseUri.get(obj) ?? graph.baseUri);
      for (const key of ["$ref", "$dynamicRef"]) {
        if (refSiblingIsDiscarded(obj, key, dialect.rules.refSuppressesSiblings)) continue;
        const ref = obj[key];
        if (typeof ref !== "string") continue;
        try {
          const target = refs.resolve(ref, graph.schemaBaseUri.get(obj));
          visit(target);
          const name = ref.includes("#") ? ref.slice(ref.indexOf("#") + 1) : "";
          if (
            key === "$dynamicRef" &&
            name !== "" &&
            !name.startsWith("/") &&
            typeof target === "object" &&
            target !== null &&
            target.$dynamicAnchor === name
          ) {
            dynamicNames.add(name);
          }
        } catch {
          /* Code generation reports an unresolved reference. */
        }
      }
      for (const { key, value } of subschemaEntries(obj)) {
        if (!refSiblingIsDiscarded(obj, key, dialect.rules.refSuppressesSiblings)) visit(value);
      }
    };
    visit(schema);
    let previous = -1;
    while (previous !== nodes.length) {
      previous = nodes.length;
      for (const base of bases) {
        for (const name of dynamicNames) {
          const candidate = graph.dynamicAnchorScopes.get(base)?.get(name);
          if (candidate !== undefined) visit(candidate);
        }
      }
    }
    const dynamicTargets = (ref: string, from: object): readonly SchemaOrBoolean[] => {
      const target = refs.resolve(ref, graph.schemaBaseUri.get(from));
      const targets = new Set<SchemaOrBoolean>([target]);
      const name = ref.includes("#") ? ref.slice(ref.indexOf("#") + 1) : "";
      if (
        name !== "" &&
        !name.startsWith("/") &&
        typeof target === "object" &&
        target !== null &&
        target.$dynamicAnchor === name
      ) {
        for (const base of bases) {
          const candidate = graph.dynamicAnchorScopes.get(base)?.get(name);
          if (candidate !== undefined) targets.add(candidate);
        }
      }
      return [...targets];
    };
    return {
      graph,
      nodes,
      pointerOf,
      refPointer,
      dynamicTargets,
      pathOf: (node) => paths.get(node),
    };
  };
  return { roots, dialect, refs, contextFor, graph, refPointer, rootErrors };
}

/** Compile authored schema roots; release each validator after collecting its diagnostics. */
export function* checkDocumentSchemas(document: OpenAPIDocument): Generator<CheckFinding> {
  const inventory = documentSchemas(document);
  const labelOf = schemaLabeler(document);
  const cache = new Map<unknown, CheckFinding[]>();
  for (const root of inventory.roots) {
    let { schema } = root;
    const { pointer } = root;
    const label = labelOf(pointer);
    // Cached messages and paths are entry-independent; attach context only on emission.
    const atEntry = (finding: CheckFinding): CheckFinding => ({
      ...finding,
      location: finding.class === "malformed" ? label : `${label} -> ${finding.location}`,
      message:
        finding.class === "malformed" && label !== pointer
          ? `${label}: ${finding.message}`
          : finding.message,
      target:
        finding.target === undefined
          ? undefined
          : {
              ...finding.target,
              anchor:
                finding.class === "malformed"
                  ? finding.target.pointer === pointer ||
                    finding.target.pointer.startsWith(`${pointer}/`)
                    ? "node"
                    : "definition"
                  : finding.target.anchor,
            },
    });
    if (inventory.rootErrors.has(root)) {
      const error = inventory.rootErrors.get(root);
      yield atEntry({
        class: "malformed",
        severity: "fatal",
        code: "malformed-schema",
        location: pointer,
        message: error instanceof Error ? error.message : String(error),
        target: { pointer, anchor: "node" },
      });
      continue;
    }
    let canonicalPointer = pointer;
    // A pure static ref has the target's assertions. Dynamic scopes retain
    // their original entry because entering a resource can change a binding.
    if (inventory.graph.dynamicAnchorScopes.size === 0) {
      const seen = new Set<unknown>();
      while (
        typeof schema === "object" &&
        schema !== null &&
        !Array.isArray(schema) &&
        Object.keys(schema).length === 1 &&
        "$ref" in schema &&
        typeof schema.$ref === "string" &&
        !seen.has(schema)
      ) {
        seen.add(schema);
        try {
          const targetPointer = inventory.refPointer(schema.$ref, schema);
          const target = inventory.refs.resolve(
            schema.$ref,
            inventory.graph.schemaBaseUri.get(schema),
          );
          if (targetPointer !== undefined) canonicalPointer = targetPointer;
          schema = target;
        } catch {
          break;
        }
      }
    }
    const key = typeof schema === "object" && schema !== null ? schema : canonicalPointer;
    const cached = cache.get(key);
    if (cached !== undefined) {
      for (const finding of cached) yield atEntry(finding);
      continue;
    }
    const entryFindings: CheckFinding[] = [];
    const entryKeys = new Set<string>();
    try {
      const context = inventory.contextFor(schema);
      const compiled = compileSchemaInContext(
        schema as SchemaOrBoolean,
        {
          dialect: inventory.dialect,
          formats: builtInFormats,
          schemaLint: "strict",
          pointer: canonicalPointer,
          anchor: canonicalPointer === pointer ? "node" : "definition",
          output: "predicate",
        },
        context,
      );
      for (const issue of compiled.stats.schemaLintIssues) {
        const findingKey = `${issue.code}\u0000${issue.message}\u0000${issue.pointer ?? ""}`;
        if (entryKeys.has(findingKey)) continue;
        entryKeys.add(findingKey);
        entryFindings.push({
          class: "schema",
          severity: defaultSeverityFor("schema", issue.code),
          code: issue.code,
          message: issue.message,
          location: issue.path === "" ? "<root>" : issue.path,
          target:
            issue.pointer === undefined
              ? undefined
              : { pointer: issue.pointer, anchor: issue.anchor ?? "node" },
        });
      }
    } catch (err) {
      const failurePointer = schemaErrorPointer(err) ?? canonicalPointer;
      entryFindings.push({
        class: "malformed",
        severity: "fatal",
        code: "malformed-schema",
        location: pointer,
        message: err instanceof Error ? err.message : String(err),
        target: {
          pointer: failurePointer,
          anchor:
            failurePointer === pointer || failurePointer.startsWith(`${pointer}/`)
              ? "node"
              : "definition",
        },
      });
    }

    cache.set(key, entryFindings);
    for (const finding of entryFindings) yield atEntry(finding);
  }
}

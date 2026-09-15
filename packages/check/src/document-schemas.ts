import {
  pointerFromFragment,
  type OpenAPIDocument,
  type SchemaOrBoolean,
} from "@oaverify/internal-core";
import { builtInFormats } from "@oaverify/internal-formats";
import { createRefResolver, resolve } from "@oaverify/internal-schema";
import { escapePointer } from "@oaverify/internal-validator/internals";
import {
  compileSchemaInContext,
  refSiblingIsDiscarded,
  schemaErrorPointer,
  subschemaEntries,
  type SchemaCompileContext,
} from "@oaverify/internal-schema/internals";
import {
  dialectFinding,
  schemaDialects,
  type SchemaDialects,
  type SchemaRoot,
  type EffectiveDialect,
} from "./schema-dialects.js";
import { schemaLabeler } from "./schema-label.js";
import type { CheckFinding } from "./finding.js";
import { defaultSeverityFor } from "./severity.js";

/** Document positions and resource scope, shared by the checker's compile units. */
export function documentSchemas(
  document: OpenAPIDocument,
  dialects: SchemaDialects = schemaDialects(document),
) {
  const { roots, dialect } = dialects;
  const envelope = (entries: SchemaRoot[]) =>
    ({
      $defs: Object.fromEntries(entries.map((root, i) => [String(i), root.schema])),
    }) as SchemaOrBoolean;
  const resolveOptions = { refSuppressesSiblings: dialect.rules.refSuppressesSiblings };
  const rootErrors = new Map<SchemaRoot, unknown>();
  const additionalRoots = new Set<SchemaRoot>();
  const buildGraph = () => {
    const originalRoots = roots.filter((root) => !additionalRoots.has(root));
    let graph;
    try {
      graph = resolve(envelope(originalRoots), resolveOptions);
    } catch {
      // Programmatic inputs can contain cycles. Isolate a graph-building failure
      // before retrying the shared inventory, so unrelated entries still report.
      const safeRoots = originalRoots.filter((root) => {
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
    for (const root of [...additionalRoots].sort((a, b) => a.pointer.length - b.pointer.length)) {
      try {
        const parent = dialects.enclosing(root.pointer);
        const baseUri =
          typeof parent?.schema === "object" && parent.schema !== null
            ? (graph.schemaBaseUri.get(parent.schema) ?? "")
            : "";
        const extra = resolve(root.schema as SchemaOrBoolean, { ...resolveOptions, baseUri });
        for (const key of ["byId", "byAnchor", "byDynamicAnchor"] as const) {
          for (const [name, node] of extra[key]) graph[key].set(name, node);
        }
        for (const key of ["anchorScopes", "dynamicAnchorScopes"] as const) {
          for (const [base, scope] of extra[key]) {
            let into = graph[key].get(base);
            if (into === undefined) graph[key].set(base, (into = new Map()));
            for (const [name, node] of scope) into.set(name, node);
          }
        }
        for (const { schema } of dialects.entries) {
          const base = extra.schemaBaseUri.get(schema);
          if (base !== undefined) graph.schemaBaseUri.set(schema, base);
          const ignored = extra.ignoredRefSiblingKeys?.get(schema);
          if (ignored !== undefined) graph.ignoredRefSiblingKeys?.set(schema, ignored);
        }
      } catch (error) {
        rootErrors.set(root, error);
      }
    }
    graph.root = document as unknown as SchemaOrBoolean;
    return graph;
  };
  let graph = buildGraph();
  let refs = createRefResolver(graph);
  const pointerOf = (schema: object): string | undefined => dialects.nodes.get(schema)?.pointer;
  const refPointer = (ref: string, from: object): string | undefined => {
    const base = graph.schemaBaseUri.get(from) ?? "";
    const target = refs.resolve(ref, base);
    if (typeof target === "object" && target !== null && pointerOf(target) !== undefined)
      return pointerOf(target);
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
          ? pointerOf(root)
          : undefined;
    return prefix === undefined ? undefined : `${prefix}${pointerFromFragment(fragment)}`;
  };
  // A reference can establish a schema outside OpenAPI's structural slots.
  // Register that root before reading its own resource-relative references.
  let discovered = -1;
  while (discovered !== roots.length) {
    discovered = roots.length;
    // Rebuild can replace entries under this index. Adding a root forces
    // another full pass, which visits anything the current pass skipped.
    for (let i = 0; i < dialects.entries.length; i++) {
      const { schema } = dialects.entries[i]!;
      for (const key of ["$ref", "$dynamicRef"]) {
        if (refSiblingIsDiscarded(schema, key, dialect.rules.refSuppressesSiblings)) continue;
        const ref = schema[key];
        if (typeof ref !== "string") continue;
        try {
          const target = refs.resolve(ref, graph.schemaBaseUri.get(schema));
          const pointer = refPointer(ref, schema);
          if (pointer === undefined || pointer === "" || dialects.positions.has(pointer)) continue;
          const root = { schema: target, pointer };
          additionalRoots.add(root);
          roots.push(root);
          dialects.rebuild(
            roots.filter((entry) => !additionalRoots.has(entry)),
            [...additionalRoots],
          );
          graph = buildGraph();
          refs = createRefResolver(graph);
        } catch {
          // The compiler reports unresolved references in selected compile units.
        }
      }
    }
  }
  // A newly discovered enclosing resource can change earlier ref targets.
  // Keep only roots reached under the settled scope before emitting findings.
  let pruned = true;
  while (pruned && additionalRoots.size > 0) {
    const referenced = new Set<string>();
    const seen = new Set<unknown>();
    const pending = roots.filter((root) => !additionalRoots.has(root)).map((root) => root.schema);
    while (pending.length > 0) {
      const node = pending.pop();
      if (typeof node !== "object" || node === null || Array.isArray(node) || seen.has(node))
        continue;
      seen.add(node);
      const schema = node as Record<string, unknown>;
      for (const key of ["$ref", "$dynamicRef"]) {
        if (refSiblingIsDiscarded(schema, key, dialect.rules.refSuppressesSiblings)) continue;
        const ref = schema[key];
        if (typeof ref !== "string") continue;
        try {
          const pointer = refPointer(ref, schema);
          if (pointer !== undefined) referenced.add(pointer);
          pending.push(refs.resolve(ref, graph.schemaBaseUri.get(schema)));
        } catch {
          // Unresolved references do not establish another schema root.
        }
      }
      for (const { key, value } of subschemaEntries(schema)) {
        if (!refSiblingIsDiscarded(schema, key, dialect.rules.refSuppressesSiblings))
          pending.push(value);
      }
    }
    pruned = false;
    for (const root of additionalRoots) {
      if (referenced.has(root.pointer)) continue;
      additionalRoots.delete(root);
      roots.splice(roots.indexOf(root), 1);
      rootErrors.delete(root);
      pruned = true;
    }
    if (pruned) {
      dialects.rebuild(
        roots.filter((root) => !additionalRoots.has(root)),
        [...additionalRoots],
      );
      graph = buildGraph();
      refs = createRefResolver(graph);
    }
  }
  const contextFor = (
    schema: unknown,
    pointer?: string,
  ): SchemaCompileContext & { dialects: ReadonlySet<EffectiveDialect> } => {
    const nodes: SchemaOrBoolean[] = [];
    const seen = new Set<unknown>();
    const bases = new Set<string>();
    const dynamicNames = new Set<string>();
    const effectiveDialects = new Set<EffectiveDialect>();
    const visit = (node: unknown, at?: string): void => {
      effectiveDialects.add(dialects.effectiveFor(node, at));
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
          visit(target, refPointer(ref, obj));
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
      for (const { key, value, at: index } of subschemaEntries(obj)) {
        if (refSiblingIsDiscarded(obj, key, dialect.rules.refSuppressesSiblings)) continue;
        const parent = pointerOf(obj);
        visit(
          value,
          parent === undefined
            ? undefined
            : `${parent}/${key}${index === undefined ? "" : `/${escapePointer(String(index))}`}`,
        );
      }
    };
    visit(schema, pointer);
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
      pathOf: (node) => dialects.nodes.get(node)?.path,
      dialects: effectiveDialects,
    };
  };
  const mixed = new Map<string, CheckFinding>();
  const prepare = (schema: unknown, pointer?: string) => {
    const effective = dialects.effectiveFor(schema, pointer);
    if (effective.dialect === undefined) return undefined;
    const context = contextFor(schema, pointer);
    let mixedDialect = false;
    for (const dependency of context.dialects) {
      if (dependency.dialect === undefined) return undefined;
      mixedDialect ||= dependency.dialect !== effective.dialect;
    }
    if (mixedDialect) {
      const at =
        pointer ??
        (typeof schema === "object" && schema !== null ? pointerOf(schema) : undefined) ??
        "";
      mixed.set(
        at,
        dialectFinding(
          at,
          "This schema reaches dialects with different semantics; dependent schema and example checks are withheld.",
        ),
      );
      return undefined;
    }
    return { dialect: effective.dialect, context };
  };
  return {
    roots,
    dialect,
    refs,
    contextFor,
    graph,
    refPointer,
    rootErrors,
    dialects,
    prepare,
    mixed,
  };
}

export type DocumentSchemas = ReturnType<typeof documentSchemas>;

/** Mixed supported closures require reference resolution, but never compilation. */
export function checkMixedDialects(inventory: DocumentSchemas): CheckFinding[] {
  if (inventory.dialects.supported.size < 2) return [];
  for (const root of [...inventory.roots, ...inventory.dialects.resources]) {
    if (inventory.rootErrors.has(root)) continue;
    try {
      inventory.prepare(root.schema, root.pointer);
    } catch {
      // Graph and compile failures belong to the schema compilation pass.
    }
  }
  return [...inventory.mixed.values()];
}

/** Compile authored schema roots; release each validator after collecting its diagnostics. */
export function* checkDocumentSchemas(
  document: OpenAPIDocument,
  inventory: DocumentSchemas = documentSchemas(document),
): Generator<CheckFinding> {
  const labelOf = schemaLabeler(document);
  const cache = new Map<unknown, CheckFinding[]>();
  const covered = new Set<unknown>();
  const authored = new Set(inventory.roots);
  for (const root of [...inventory.roots, ...inventory.dialects.resources]) {
    if (!authored.has(root) && covered.has(root.schema)) continue;
    if (inventory.dialects.effectiveFor(root.schema, root.pointer).dialect === undefined) continue;
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
    let prepared: ReturnType<DocumentSchemas["prepare"]>;
    let prepareError: unknown;
    if (inventory.dialects.unsupported.size > 0 || inventory.dialects.supported.size > 1) {
      try {
        prepared = inventory.prepare(schema, pointer);
        if (prepared === undefined) continue;
      } catch (error) {
        prepareError = error;
      }
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
      if (prepareError !== undefined) throw prepareError;
      const eligible = prepared ?? inventory.prepare(schema, canonicalPointer);
      if (eligible === undefined) continue;
      const { context, dialect } = eligible;
      if (inventory.dialects.resources.length > 0) {
        for (const node of context.nodes) covered.add(node);
      }
      const compiled = compileSchemaInContext(
        schema as SchemaOrBoolean,
        {
          dialect,
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
          ...(issue.contributors !== undefined &&
          issue.contributors.every((c) => c.pointer !== undefined)
            ? {
                contributors: issue.contributors.map((c) => ({
                  pointer: c.pointer!,
                  anchor: c.anchor ?? "node",
                })),
              }
            : {}),
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

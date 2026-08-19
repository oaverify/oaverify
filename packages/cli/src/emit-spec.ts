/**
 * Emit a standalone, AOT-compiled HTTP validator from an OpenAPI
 * document. The output is an ES module exporting the same surface as
 * `createValidator(document)`: `validateRequest`, `validateResponse`,
 * `validateFetchRequest`, `validateFetchResponse`, `getOperation`,
 * `detectedVersion`, `warnings`, but with every operation's schemas
 * already compiled into the module. After bundling through esbuild the
 * module has zero imports. The emitted `validate*` return the same
 * result shapes as `createValidator` (`{ valid, errors?/error?,
 * truncated }` or a predicate boolean), tuned by `outputMode` /
 * `maxErrors`; each builds the nested tree internally and reshapes at
 * the boundary via the shared `reshapeResult` / `toFetchResult`.
 *
 * Consumers who were doing `createValidator(await loadSpec(...))` at
 * runtime get the same behavior with no YAML parse, no `$ref`
 * resolution, no schema compilation at load. Target use cases:
 * Cloudflare Workers, Vercel Edge, Lambda@Edge, Lambda cold-start
 * latency, deno compile, single-file bundles: anywhere runtime
 * compilation is either disallowed or too expensive.
 *
 * @packageDocumentation
 */

import { builtInFormats } from "@oaverify/internal-formats";
import {
  coercionView,
  compileMediaTypePatterns,
  isServedParameterLocation,
  isValidMaxTotalBytes,
  maxTotalBytesErrorMessage,
  schemaRefResolverFor,
  unservedParameterLocationMessage,
  walkDocumentSchemas,
  type SchemaRefResolver,
} from "@oaverify/internal-validator/internals";
import { isUnknownFormat } from "./emit-standalone.js";
import {
  compileSchema,
  createRefResolver,
  jsonSchemaDialect,
  oas30Dialect,
  openapi31Dialect,
  resolve,
  type Dialect,
  type RefResolver,
} from "@oaverify/internal-schema";
import { classifyUnknownVersion, setSpecKey } from "@oaverify/internal-core";
import {
  isHeaderObjectPrototypePropertyName,
  isObjectPrototypePropertyName,
} from "@oaverify/internal-core/prototype-properties";
import type {
  HeaderObject,
  OpenAPIDocument,
  OperationObject,
  ParameterObject,
  PathItem,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SchemaOrBoolean,
  SecuritySchemeObject,
} from "@oaverify/internal-core";
import type { StandaloneDialect } from "./emit-standalone.js";

/**
 * Options for {@link emitSpec}.
 *
 * @internal
 */
export interface EmitSpecOptions {
  /** Schema dialect; auto-detected from `document.openapi` if unset. */
  dialect?: StandaloneDialect;
  /** Skip response-validator emit. Default false (responses emitted). */
  requestsOnly?: boolean;
  /**
   * Whitelist of `(method, path)` pairs to emit. Empty / undefined
   * means "emit every operation." Ops not matching any include are
   * dropped from the router entirely; requests to them come back as
   * `code: "route"` (404).
   */
  only?: Array<{ method: string; path: string }>;
  /**
   * Import-path prefix for runtime deps. Defaults to
   * `"@oaverify/core"`. Tests may override it so the output
   * resolves against the workspace aliases.
   */
  importPrefix?: string;
  /**
   * Result shape of the emitted `validate*` exports, matching
   * `createValidator`'s `output` option. Default `"flat"`.
   */
  outputMode?: "flat" | "tree" | "predicate";
  /**
   * Per-call leaf-error cap baked into the emitted validators, matching
   * `createValidator`'s `maxErrors`. Default `1` (fast-fail);
   * `Number.POSITIVE_INFINITY` collects every error.
   */
  maxErrors?: number;
  /**
   * When `true`, the emitted `validateRequest` (and the request-side
   * Fetch wrapper) additionally return the deserialized parameter
   * values under a `value` field, matching
   * `ValidatorOptions.returnValues`. Default `false`.
   *
   * The presence rule is the runtime's, mirrored site for site: a
   * parameter appears when this call reached it, deserialized it, and
   * its schema accepted the result. See `RequestValues` for the
   * contract and `validate-step.ts` for the sites.
   *
   * Emission is byte-identical to the option being absent when this is
   * `false`, the way `maxDepth` and `$dynamicRef` are on the compiler
   * side.
   *
   * Incompatible with `outputMode: "predicate"`, which returns a bare
   * boolean and has nowhere to carry a value. {@link emitSpec} throws
   * when both are set, matching what `createValidator` does at
   * construction.
   */
  returnValues?: boolean;
  /**
   * Byte cap on the emitted `validateFetch*` helpers' body read,
   * matching `createValidator`'s `maxTotalBytes`. Default 1 MiB;
   * `Number.POSITIVE_INFINITY` reads unbounded.
   */
  maxTotalBytes?: number;
  /**
   * Policy for `format` names outside the built-in set, over the
   * document's schema positions (the walk is document-level, so an
   * operation dropped by `only` still counts; conservative on
   * purpose). `"error"` (the default) throws, naming the formats;
   * `"ignore"` emits guards that never fire, matching the runtime, and
   * records each name in the module's `warnings` export. Mirrors
   * `CompileOptions.unknownFormats`; see `emitStandalone` for the
   * policy-vs-capability distinction (#660).
   */
  unknownFormats?: "ignore" | "error";
  /**
   * Called once with the sorted unknown-format names when
   * `unknownFormats: "ignore"` found any. The CLI prints them to
   * stderr; the module's `warnings` export carries them regardless.
   */
  onUnknownFormats?: (names: readonly string[]) => void;
}

const DIALECT_MAP: Record<StandaloneDialect, Dialect> = {
  "2020-12": jsonSchemaDialect,
  "openapi-3.1": openapi31Dialect,
  "openapi-3.0": oas30Dialect,
};

/**
 * Compile every operation's schemas and emit the orchestrated HTTP
 * validator as ESM source.
 *
 * @internal
 */
export function emitSpec(document: OpenAPIDocument, options: EmitSpecOptions = {}): string {
  const importPrefix = options.importPrefix ?? "@oaverify/core";
  const outputMode = options.outputMode ?? "flat";
  const returnValues = options.returnValues === true;
  if (returnValues && outputMode === "predicate") {
    // The emitter is the only moment this can be caught: the emitted
    // module has no construction step for `createValidator`'s throw to
    // live in. Same wording, so a user who hits it from either side
    // reads the same sentence.
    throw new Error(
      'emitSpec: `returnValues` cannot be combined with `outputMode: "predicate"`, ' +
        'which returns a bare boolean. Use `outputMode: "flat"` (the default) or `"tree"`.',
    );
  }
  const maxErrors = options.maxErrors ?? 1;
  // Bake the cap as a JS literal; Infinity has no JSON form.
  const maxErrorsLiteral = Number.isFinite(maxErrors)
    ? String(maxErrors)
    : "Number.POSITIVE_INFINITY";
  // Validated at emit time, on the same allow-list the runtime uses.
  // Baking an unchecked value would either fail open (an `isFinite`
  // test reads `NaN` as uncapped) or defer a `0` to a TypeError thrown
  // from the reader on every request the emitted module ever serves.
  if (options.maxTotalBytes !== undefined && !isValidMaxTotalBytes(options.maxTotalBytes)) {
    throw new Error(`emitSpec: ${maxTotalBytesErrorMessage(options.maxTotalBytes)}`);
  }
  // Left to the reader's own default when unset, so the 1 MiB constant
  // has one home rather than being restated in emitted source.
  const maxTotalBytesLiteral =
    options.maxTotalBytes === undefined
      ? "undefined"
      : options.maxTotalBytes === Number.POSITIVE_INFINITY
        ? "Number.POSITIVE_INFINITY"
        : String(options.maxTotalBytes);
  const warnings: string[] = [];
  const dialect = resolveDialect(document, options.dialect, warnings);

  // Formats outside the built-in set, before any compile work so the
  // error mode fails fast. The walk is document-level rather than
  // per-compiled-schema, because compilation follows $refs into
  // component schemas where a plain subschema walk does not; the cost
  // is that an operation dropped by `only` still counts, which errs in
  // the conservative direction (#660).
  const unknownNames = collectDocumentUnknownFormats(document);
  if (unknownNames.length > 0) {
    const list = unknownNames.map((f) => `"${f}"`).join(", ");
    if ((options.unknownFormats ?? "error") === "error") {
      throw new Error(
        `Spec references format${unknownNames.length > 1 ? "s" : ""} not in the built-in set: ${list}. ` +
          `Standalone compilation asserts only the built-in formats from @oaverify/core/formats; ` +
          `pass --unknown-formats ignore to emit without asserting them.`,
      );
    }
    for (const name of unknownNames) {
      warnings.push(`format "${name}" is not in the built-in set and is not asserted`);
    }
    options.onUnknownFormats?.(unknownNames);
  }

  const graph = resolve(document as unknown as SchemaOrBoolean);
  const refResolver: RefResolver = createRefResolver(graph);

  // One `$ref` hop for the coercion views, bound the way createValidator
  // binds it. `resolveRef` below reaches the same resolver, so the
  // difference here is not the resolver but the base URI and the chain:
  // that one resolves a single hop, so the emitted module stopped
  // following a ref chain that the runtime followed.
  const resolveSchemaRef = schemaRefResolverFor(refResolver, graph);

  // Anything passed through resolveRef comes back with `{ $ref }`
  // followed; the schema registry handles internal refs transparently.
  const resolveRef = <T>(v: T | ReferenceObject | undefined): T | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "object" || v === null) return v as T;
    const ref = (v as { $ref?: unknown }).$ref;
    if (typeof ref !== "string") return v as T;
    return refResolver.resolve(ref) as T | undefined;
  };

  // Collect every compiled schema, de-duplicated by identity. Each
  // unique source schema gets one emitted IIFE; positions reference
  // it by generated name. The dedup key is the source `SchemaOrBoolean`
  // object: `compileSchema` returns a fresh `CompiledSchema` per call,
  // so keying on its result would never hit and would recompile +
  // re-emit the same schema once per reference.
  const compiled: Array<{ name: string; source: string }> = [];
  const schemaNames = new Map<SchemaOrBoolean, string>();
  const named = (schema: SchemaOrBoolean): string => {
    const existing = schemaNames.get(schema);
    if (existing !== undefined) return existing;
    // Mirror @oaverify/internal-validator's runtime contract: the emitted module nests
    // per-location error subtrees, so each schema compiles in tree mode
    // with uncapped errors, independent of the v3 flat/maxErrors:1 default.
    const c = compileSchema(schema, {
      dialect,
      refResolver,
      formats: builtInFormats,
      output: "tree",
      maxErrors: Number.POSITIVE_INFINITY,
      // The emitted module *is* the generated source, so this is one of
      // the two callers that needs it kept; see
      // CompileOptions.retainSource.
      retainSource: true,
    });
    const name = `S${compiled.length}`;
    compiled.push({ name, source: c.source });
    schemaNames.set(schema, name);
    return name;
  };

  // Operations to emit, honoring `only`. Two parallel structures:
  //
  // - `pathMethods`: for each path that has ≥ 1 included op, the FULL
  //   set of spec-declared methods. Drives the router's paths table.
  //   A method declared in the spec but dropped by `--only` stays in
  //   here; the router still sees it and reports method-not-allowed
  //   only for methods the spec truly doesn't have. That preserves
  //   405 semantics for unfiltered deployments.
  // - `opsEmitted`: the FILTERED subset. Drives the ops table.
  //
  // At validate time: router.match → if method-not-allowed, 405
  // (same as unfiltered). If router matches but ops lookup misses,
  // it's a filtered-out method → 404. Effect: a microservice emit
  // reports 404 for operations it doesn't serve, including those
  // that were in the upstream spec but are outside this deployment's
  // surface.
  const includeFilter = options.only;
  const opsEmitted: EmittedOp[] = [];
  const pathMethods = new Map<string, Set<string>>();
  const includedPaths = new Set<string>();

  // First pass: identify which paths have ≥ 1 included op.
  for (const [pathPattern, pathItemRaw] of Object.entries(document.paths ?? {})) {
    const pathItem = resolveRef<PathItem>(pathItemRaw as PathItem | ReferenceObject);
    if (pathItem == null) continue;
    for (const method of HTTP_METHODS) {
      const opRaw = (pathItem as Record<string, unknown>)[method];
      if (opRaw === undefined) continue;
      const upperMethod = method.toUpperCase();
      if (matchesFilter(includeFilter, upperMethod, pathPattern)) {
        includedPaths.add(pathPattern);
        break;
      }
    }
  }

  // Second pass: for each included path, record all declared methods
  // (for the router) and the filtered subset (for the ops table).
  for (const [pathPattern, pathItemRaw] of Object.entries(document.paths ?? {})) {
    if (!includedPaths.has(pathPattern)) continue;
    const pathItem = resolveRef<PathItem>(pathItemRaw as PathItem | ReferenceObject);
    if (pathItem == null) continue;

    const allDeclared = new Set<string>();
    for (const method of HTTP_METHODS) {
      const opRaw = (pathItem as Record<string, unknown>)[method];
      if (opRaw === undefined) continue;
      const op = resolveRef<OperationObject>(opRaw as OperationObject | ReferenceObject);
      if (op == null) continue;
      const upperMethod = method.toUpperCase();
      allDeclared.add(upperMethod);

      if (!matchesFilter(includeFilter, upperMethod, pathPattern)) continue;
      opsEmitted.push(
        buildEmittedOp({
          pathPattern,
          method: upperMethod,
          operation: op,
          pathItem,
          document,
          resolveRef,
          resolveSchemaRef,
          refSuppressesSiblings: dialect.rules.refSuppressesSiblings,
          named,
          requestsOnly: options.requestsOnly === true,
        }),
      );
    }
    pathMethods.set(pathPattern, allDeclared);
  }

  // Assemble the module.
  const opsTableEntries = opsEmitted.map(
    (o) => `  ${JSON.stringify(`${o.pathPattern}::${o.method}`)}: ${o.stateLiteral},`,
  );

  const metaTableEntries = opsEmitted.map(
    (o) => `  ${JSON.stringify(`${o.pathPattern}::${o.method}`)}: ${o.introspectionLiteral},`,
  );

  const pathsTableEntries = [...pathMethods.entries()].map(
    ([pattern, methods]) =>
      `  ${JSON.stringify(pattern)}: { ${[...methods].map((m) => `${m.toLowerCase()}: {}`).join(", ")} },`,
  );
  const usesOwnHelper = opsEmitted.some((op) => op.usesOwnHelper);
  const usesHeaderHelper = opsEmitted.some((op) => op.usesHeaderHelper);
  const usesHeaderFastHelper = opsEmitted.some((op) => op.usesHeaderFastHelper);

  return [
    "// Generated by `oaverify compile-spec`. Do not edit by hand.",
    "// Regenerate by running `oaverify compile-spec <openapi.yaml>` against the source.",
    "",
    `import { createLeafError, createBranchError, createError, normalizeFormat } from "${importPrefix}/core";`,
    `import { createDeps, deepEqual, typeOf, wrapErrors } from "${importPrefix}/schema/internals";`,
    `import { builtInFormats } from "${importPrefix}/formats";`,
    // Everything on this line is the semver-covered emit-side runtime;
    // membership in `@oaverify/core/codegen-runtime` follows this import
    // (see that module's header). Do not point it at a subpath that
    // promises less.
    `import { deserialize, matchParsedMediaType, matchResponseKey, normalizeRequestQuery, assembleObjectQueryParam, assembleObjectCookieParam, FetchBodyParseError, FetchBodyTooLargeError, httpRequestFromFetch, httpResponseFromFetch, checkSecurity, compileOperationSecurity, resolveOperationRef, createRouter, reshapeResult, toFetchResult, contentTypeErrorMessage${returnValues ? ", emptyRequestValues" : ""} } from "${importPrefix}/codegen-runtime";`,
    "",
    "void createBranchError; void createError; void deepEqual; void typeOf; void wrapErrors;",
    "void resolveOperationRef;",
    "",
    "const deps = createDeps();",
    // Normalized on the way in, because generated code reaches
    // `.validate` on the entry. A raw registry value is a bare function
    // for every string format, so skipping this leaves every string
    // format silently unasserted in the emitted module.
    "for (const [name, def] of Object.entries(builtInFormats)) deps.formats.set(name, normalizeFormat(def));",
    "",
    "// ---- compiled per-operation schemas ----",
    ...compiled.map((c) => `const ${c.name} = (function (deps) {\n${c.source}\n})(deps);`),
    "",
    "// ---- security schemes (for per-op security compile at module load) ----",
    `const __securitySchemes = ${stringifySecuritySchemes(document, resolveRef)};`,
    `const __documentSecurity = ${JSON.stringify(document.security ?? [])};`,
    "const __identityResolver = (v) => v;",
    "",
    "// ---- per-operation state ----",
    "const ops = {",
    ...opsTableEntries,
    "};",
    "",
    "// Fold security compile across all ops at load time, using the",
    "// emitted schemes table as resolution context. Cheap; eliminates",
    "// per-request compile cost.",
    "for (const [key, op] of Object.entries(ops)) {",
    "  if (op.__security !== null) {",
    "    op.compiledSecurity = compileOperationSecurity(",
    "      { security: op.__security },",
    "      { components: { securitySchemes: __securitySchemes }, security: __documentSecurity },",
    "      __identityResolver,",
    "    );",
    "  }",
    "}",
    "",
    "// ---- router ----",
    "const router = createRouter({",
    ...pathsTableEntries,
    "});",
    "",
    "// ---- introspection (getOperation) ----",
    "// Resolved OpenAPI objects for each emitted operation, mirroring the",
    "// runtime's match.pathItem / match.operation references. Kept out of",
    "// the `ops` table so the __REF:Sn__ placeholder rewrite never touches",
    "// raw spec content.",
    "const __meta = {",
    ...metaTableEntries,
    "};",
    "",
    "// ---- detected version + warnings ----",
    `export const detectedVersion = ${JSON.stringify(detectVersionBucket(document))};`,
    `export const warnings = Object.freeze(${JSON.stringify(warnings)});`,
    "",
    "// ---- output shape (from --output-mode / --max-errors) ----",
    "// Each validate* builds the nested error tree internally, then",
    "// reshapeResult / toFetchResult shape it to match createValidator.",
    `const __outputMode = ${JSON.stringify(outputMode)};`,
    `const __maxErrors = ${maxErrorsLiteral};`,
    "// Byte cap on the Fetch helpers' body read (from --max-total-bytes).",
    `const __maxTotalBytes = ${maxTotalBytesLiteral};`,
    "",
    ...(usesOwnHelper ? [renderOwnHelper(), ""] : []),
    ...(usesHeaderHelper ? [renderHeaderHelper(), ""] : []),
    ...(usesHeaderFastHelper ? [renderHeaderFastHelper(), ""] : []),
    renderValidateRequestTree(returnValues),
    "",
    options.requestsOnly === true ? renderValidateResponseTreeNoop() : renderValidateResponseTree(),
    "",
    renderPublicValidators(returnValues),
    "",
    renderGetOperation(),
    "",
  ].join("\n");
}

// ----- building per-op state -----

interface EmittedOp {
  pathPattern: string;
  method: string;
  usesOwnHelper: boolean;
  usesHeaderHelper: boolean;
  usesHeaderFastHelper: boolean;
  /** The JSON-stringified state object for `ops[key]`. */
  stateLiteral: string;
  /**
   * JSON blob of `{ pathItem, operation }` for the module's `__meta`
   * table. Kept separate from `stateLiteral` so the raw OpenAPI objects
   * never pass through the `__REF:Sn__` placeholder rewrite.
   */
  introspectionLiteral: string;
}

interface BuildEmittedOpArgs {
  pathPattern: string;
  method: string;
  operation: OperationObject;
  pathItem: PathItem;
  document: OpenAPIDocument;
  resolveRef: <T>(v: T | ReferenceObject | undefined) => T | undefined;
  resolveSchemaRef: SchemaRefResolver;
  /**
   * The compiling dialect's `rules.refSuppressesSiblings`, so the
   * emitted coercion views drop `$ref` siblings exactly when the
   * compiled schemas do (OAS 3.0).
   */
  refSuppressesSiblings: boolean;
  named: (schema: SchemaOrBoolean) => string;
  requestsOnly: boolean;
}

function buildEmittedOp(args: BuildEmittedOpArgs): EmittedOp {
  const {
    pathPattern,
    method,
    operation,
    pathItem,
    document,
    resolveRef,
    resolveSchemaRef,
    refSuppressesSiblings,
    named,
    requestsOnly,
  } = args;

  /**
   * A `parameters` value as the list it is supposed to be, or empty.
   *
   * Anything else is a defect the conformance pass owns, and reading it here
   * produced an error naming no path, method or parameter.
   *
   * @internal
   */
  function asParameterList(value: unknown): Array<ParameterObject | ReferenceObject> {
    return Array.isArray(value) ? (value as Array<ParameterObject | ReferenceObject>) : [];
  }

  // Parameters: union of path-item-level + operation-level. Operation
  // wins on `(name, in)` collision.
  const combined = new Map<string, ParameterObject>();
  // `!= null` rather than `!== undefined`: a `- ` list entry with
  // nothing under it resolves to `null`, and reading `.name` off it
  // threw a `TypeError` out of `emitSpec` where `createValidator` skips
  // the entry and lets the conformance pass locate it. Same skip, same
  // reason, three lines from the gate this file just gained.
  // `Array.isArray`, not `?? []`: `parameters:` written as a mapping is
  // not iterable, and iterating it threw `object is not iterable`. The
  // validator, the hygiene lint and the overlay reader all read the
  // same shape as no parameters now, so the conformance pass is what
  // names it (#837).
  for (const p of asParameterList(pathItem.parameters)) {
    const resolved = resolveRef<ParameterObject>(p);
    if (resolved != null) combined.set(`${resolved.name}::${resolved.in}`, resolved);
  }
  for (const p of asParameterList(operation.parameters)) {
    const resolved = resolveRef<ParameterObject>(p);
    if (resolved != null) combined.set(`${resolved.name}::${resolved.in}`, resolved);
  }
  const parameters = [...combined.values()];

  // Refuse before this operation's schemas compile, for a parameter
  // location the emitted validator cannot read a value for. Same policy
  // and same words as `createValidator` (#836); the rule and the
  // message come from `@oaverify/core/validator/internals` rather than
  // a second copy of the list.
  //
  // Emit time is the emitter's construction, and refusing here is the
  // whole of it: no load-time guard is emitted into the module. A
  // module that throws on import moves the failure from a build step
  // holding the document and the CLI to a production boot holding
  // neither.
  //
  // Scoped to the operations actually emitted, where `createValidator`
  // refuses document-wide. `--only` drops operations from the emitted
  // router and the emitted module answers 404 for them, so a dropped
  // operation's parameters can never reach a verdict. The line is the
  // false "valid", not the unimplemented feature, so an operation that
  // claims nothing is left alone. A Path Item parameter is checked here
  // rather than at the path, which is what makes it inherit that rule:
  // it refuses once some emitted operation inherits it.
  //
  // No `emitSpec:` prefix, unlike the option errors above. The CLI
  // prefixes what it prints with `compile-spec:`, and the subject here
  // is the caller's document rather than the call, so naming the
  // function again reads as `compile-spec: emitSpec: GET /t declares
  // ...` for the only audience that sees it.
  for (const p of parameters) {
    // A non-object entry is not a parameter to judge. `createValidator`
    // skips it and the conformance pass names the line; refusing here
    // reported it as a parameter with no `in`, which points at the
    // wrong defect and breaks the parity this gate exists to keep.
    if (p === null || typeof p !== "object") continue;
    if (isServedParameterLocation(p.in)) continue;
    throw new Error(unservedParameterLocationMessage(`${method} ${pathPattern}`, p.name, p.in));
  }

  const hasOwnReadParameters = parameters.some(
    (p) => p.in !== "header" && isObjectPrototypePropertyName(p.name),
  );
  const hasGuardedHeaderParameters = parameters.some(
    (p) => p.in === "header" && isHeaderObjectPrototypePropertyName(p.name),
  );
  const hasFastHeaderParameters = parameters.some(
    (p) => p.in === "header" && !isHeaderObjectPrototypePropertyName(p.name),
  );

  // requestBody: per-media-type compiled body validators + required flag.
  const requestBody = resolveRef<RequestBodyObject>(
    operation.requestBody as RequestBodyObject | ReferenceObject,
  );
  const bodyValidators: Record<string, string> = {};
  // Negotiation reads what the document declares, not what compiled: a
  // Media Type Object with no `schema` is legal and means "anything
  // goes". Keeping this list in step with the runtime validator's
  // `declaredBodyMediaTypes` is what stops the emitted module answering
  // 415 where `createValidator` answers 200 (#849).
  const declaredBodyMediaTypes: string[] = [];
  let requestBodyRequired = false;
  if (requestBody !== undefined) {
    requestBodyRequired = requestBody.required === true;
    for (const [mediaType, media] of Object.entries(requestBody.content ?? {})) {
      declaredBodyMediaTypes.push(mediaType);
      if (media.schema !== undefined) {
        setSpecKey(bodyValidators, mediaType, named(media.schema));
      }
    }
  }

  // Responses: per-status, per-media-type body + header schemas.
  const responses: Record<
    string,
    {
      bodyValidators: Record<string, string>;
      declaredMediaTypes: string[];
      headers: Record<
        string,
        { readOwn: boolean; required: boolean; schema: unknown; validator: string | null }
      >;
    }
  > = {};
  if (!requestsOnly) {
    for (const [statusKey, respRaw] of Object.entries(operation.responses ?? {})) {
      const resp = resolveRef<ResponseObject>(respRaw as ResponseObject | ReferenceObject);
      if (resp === undefined) continue;
      const bodyVs: Record<string, string> = {};
      const declaredMediaTypes: string[] = [];
      for (const [mediaType, media] of Object.entries(resp.content ?? {})) {
        declaredMediaTypes.push(mediaType);
        if (media.schema !== undefined) {
          setSpecKey(bodyVs, mediaType, named(media.schema));
        }
      }
      const headers: Record<
        string,
        { readOwn: boolean; required: boolean; schema: unknown; validator: string | null }
      > = {};
      for (const [headerName, hdrRaw] of Object.entries(resp.headers ?? {})) {
        const hdr = resolveRef<HeaderObject>(hdrRaw as HeaderObject | ReferenceObject);
        if (hdr === undefined) continue;
        const schema = (hdr.schema ?? firstContentSchema(hdr)) as SchemaOrBoolean | undefined;
        setSpecKey(headers, headerName, {
          readOwn: isHeaderObjectPrototypePropertyName(headerName),
          required: hdr.required === true,
          schema: coercionView(
            { name: headerName, in: "header", schema: hdr.schema },
            resolveSchemaRef,
            { refSuppressesSiblings },
          ).schema,
          validator: schema !== undefined ? named(schema) : null,
        });
      }
      setSpecKey(responses, statusKey, {
        bodyValidators: bodyVs,
        declaredMediaTypes,
        headers,
      });
    }
  }
  const hasGuardedResponseHeaders = Object.values(responses).some((response) =>
    Object.values(response.headers).some((header) => header.readOwn),
  );
  const hasFastResponseHeaders = Object.values(responses).some((response) =>
    Object.values(response.headers).some((header) => !header.readOwn),
  );

  const security = operation.security ?? null;

  // Hand-serialise because we need to splice in unquoted references to
  // the compiled validator names (S0, S1, …). JSON.stringify then
  // string-replace the sentinel placeholders.
  const stateLiteral = hydrateValidatorRefs(
    JSON.stringify(
      {
        pathPattern,
        method,
        // The emitted module carries the schema it will coerce against,
        // so it carries the resolved view. Without this a compiled
        // validator keeps #714 while createValidator no longer has it.
        parameters: parameters
          .map((raw) => coercionView(raw, resolveSchemaRef, { refSuppressesSiblings }))
          .map((p) => ({
            name: p.name,
            in: p.in,
            __readOwn:
              p.in === "header"
                ? isHeaderObjectPrototypePropertyName(p.name)
                : isObjectPrototypePropertyName(p.name),
            required: p.required === true,
            style: p.style,
            explode: p.explode,
            schema: p.schema ?? undefined,
            __validator: paramValidatorName(combined, p, named),
          })),
        requestBodyRequired,
        hasRequestBody: requestBody !== undefined,
        bodyValidators: toPlaceholderMap(bodyValidators),
        bodyMediaTypes: compileMediaTypePatterns(declaredBodyMediaTypes),
        responses: mapResponsesToPlaceholders(responses),
        __security: security,
      },
      null,
      2,
    ),
  );

  // Introspection payload for `getOperation`. Matches the runtime's
  // `match.pathItem` / `match.operation` references: the resolved
  // top-level objects from the document. Nested `$ref`s (e.g. inside a
  // `requestBody` or `responses[status]`) are left intact, same as
  // runtime.
  const introspectionLiteral = JSON.stringify({ pathItem, operation }, null, 2);

  void document; // reserved for overlay resolution
  return {
    pathPattern,
    method,
    usesOwnHelper: hasOwnReadParameters,
    usesHeaderHelper: hasGuardedHeaderParameters || hasGuardedResponseHeaders,
    usesHeaderFastHelper: hasFastHeaderParameters || hasFastResponseHeaders,
    stateLiteral,
    introspectionLiteral,
  };
}

function paramValidatorName(
  _combined: Map<string, ParameterObject>,
  p: ParameterObject,
  named: (schema: SchemaOrBoolean) => string,
): string {
  const schema = (p.schema ?? firstContentSchema(p)) as SchemaOrBoolean | undefined;
  if (schema === undefined) return "__NULL__";
  return `__REF:${named(schema)}__`;
}

function firstContentSchema(p: ParameterObject | HeaderObject): SchemaOrBoolean | undefined {
  const content = (p as ParameterObject).content;
  if (content === undefined) return undefined;
  for (const media of Object.values(content)) {
    if (media.schema !== undefined) return media.schema;
  }
  return undefined;
}

function toPlaceholderMap(m: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) setSpecKey(out, k, `__REF:${v}__`);
  return out;
}

function mapResponsesToPlaceholders(
  responses: Record<
    string,
    {
      bodyValidators: Record<string, string>;
      declaredMediaTypes: string[];
      headers: Record<
        string,
        { readOwn: boolean; required: boolean; schema: unknown; validator: string | null }
      >;
    }
  >,
): unknown {
  const out: Record<string, unknown> = {};
  for (const [status, r] of Object.entries(responses)) {
    const headerOut: Record<
      string,
      { __readOwn: boolean; required: boolean; schema: unknown; __validator: string }
    > = {};
    for (const [name, h] of Object.entries(r.headers)) {
      setSpecKey(headerOut, name, {
        __readOwn: h.readOwn,
        required: h.required,
        schema: h.schema,
        __validator: h.validator === null ? "__NULL__" : `__REF:${h.validator}__`,
      });
    }
    setSpecKey(out, status, {
      bodyValidators: toPlaceholderMap(r.bodyValidators),
      bodyMediaTypes: compileMediaTypePatterns(r.declaredMediaTypes),
      headers: headerOut,
    });
  }
  return out;
}

function hydrateValidatorRefs(json: string): string {
  // Replace "__REF:S0__" → S0 and "__NULL__" → null. Both appear as
  // strings in the JSON; strip the wrapping quotes when rewriting.
  return json.replace(/"__REF:(S\d+)__"/g, "$1").replace(/"__NULL__"/g, "null");
}

// ----- security schemes -----

function stringifySecuritySchemes(
  document: OpenAPIDocument,
  resolveRef: <T>(v: T | ReferenceObject | undefined) => T | undefined,
): string {
  const raw = document.components?.securitySchemes ?? {};
  const resolved: Record<string, SecuritySchemeObject> = {};
  for (const [name, r] of Object.entries(raw)) {
    const s = resolveRef<SecuritySchemeObject>(r as SecuritySchemeObject | ReferenceObject);
    if (s !== undefined) setSpecKey(resolved, name, s);
  }
  return JSON.stringify(resolved, null, 2);
}

// ----- filter -----

function matchesFilter(
  only: Array<{ method: string; path: string }> | undefined,
  method: string,
  pathPattern: string,
): boolean {
  if (only === undefined || only.length === 0) return true;
  return only.some((inc) => inc.method.toUpperCase() === method && inc.path === pathPattern);
}

// ----- version detection -----

function detectVersionBucket(document: OpenAPIDocument): "3.0" | "3.1" | "3.2" | undefined {
  const v = (document as { openapi?: string }).openapi;
  if (typeof v !== "string") return undefined;
  if (v.startsWith("3.0")) return "3.0";
  if (v.startsWith("3.1")) return "3.1";
  if (v.startsWith("3.2")) return "3.2";
  return undefined;
}

function resolveDialect(
  document: OpenAPIDocument,
  override: StandaloneDialect | undefined,
  warnings: string[],
): Dialect {
  const bucket = detectVersionBucket(document);

  // Explicit override short-circuits detection. Mirror the runtime's
  // behavior of surfacing a warning when the override is hiding a
  // category error.
  if (override !== undefined) {
    if (bucket === undefined) {
      const rawOpenapi = (document as { openapi?: unknown }).openapi;
      const reason = classifyUnknownVersion(rawOpenapi);
      if (reason.kind !== "ok-unknown-minor") {
        warnings.push(
          `compile-spec: ${reason.message}; compiling anyway because \`dialect\` was set`,
        );
      }
    }
    return DIALECT_MAP[override];
  }

  if (bucket === "3.0") return oas30Dialect;
  if (bucket === "3.1" || bucket === "3.2") return openapi31Dialect;

  // bucket === undefined: classify and warn. We still fall back to the
  // 3.1 dialect rather than throwing; AOT is a build-time pipeline and
  // the consumer's `warnings` export is the appropriate signal.
  const rawOpenapi = (document as { openapi?: unknown }).openapi;
  const reason = classifyUnknownVersion(rawOpenapi);
  if (reason.kind === "ok-unknown-minor") {
    warnings.push(
      `compile-spec: openapi: "${reason.raw}" is an unknown 3.x minor version; falling back to the 3.1 dialect`,
    );
  } else {
    warnings.push(
      `compile-spec: ${reason.message}; falling back to the 3.1 dialect (pass \`dialect\` to override)`,
    );
  }
  return openapi31Dialect;
}

// ----- orchestration templates -----

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"];

function renderOwnHelper(): string {
  return `function __own(bag, name) {
  if (bag === undefined) return undefined;
  return Object.hasOwn(bag, name) ? bag[name] : undefined;
}
`;
}

function renderHeaderHelper(): string {
  return `function __readHeader(headers, name) {
  if (headers === undefined) return undefined;
  const lowered = name.toLowerCase();
  if (Object.hasOwn(headers, lowered)) {
    const direct = headers[lowered];
    if (direct !== undefined) return direct;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}
`;
}

function renderHeaderFastHelper(): string {
  return `function __readHeaderFast(headers, name) {
  if (headers === undefined) return undefined;
  const lowered = name.toLowerCase();
  const direct = headers[lowered];
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}
`;
}

function renderValidateRequestTree(returnValues: boolean): string {
  // Mirrors validator.ts's validateRequestTree closely. Differences:
  //   - state comes from the `ops` table, keyed on
  //     `${pathPattern}::${method}`, rather than cacheFor+WeakMap
  //   - security is pre-compiled at module load (op.compiledSecurity)
  //   - no strict-query-parameter option surfaced yet
  // Returns the nested error tree (or null when valid); the exported
  // validateRequest wrapper reshapes it to the configured output.
  //
  // `returnValues` threads a `sink` argument through this function and
  // __validateParameter, and splits the two schema-accept sites so a
  // value can be recorded between the accept and the return. Every
  // fragment it interpolates is the empty string when the option is
  // off, so the emitted text is byte-identical to the option's absence
  // and there is one copy of the parameter logic rather than two.
  const sinkParam = returnValues ? ", sink" : "";
  // The accept site, both spellings. Off: the combined test the
  // emitter has always written. On: the runtime's shape from
  // validate-step.ts, where the valid branch records before returning.
  const accept = (indent: string, valueExpr: string): string =>
    returnValues
      ? `if (r.valid) {\n${indent}  __recordValue(sink, p, ${valueExpr});\n${indent}  return null;\n${indent}}\n${indent}if (r.error === undefined) return null;`
      : "if (r.valid || r.error === undefined) return null;";
  return `function __validateRequestTree(rawReq${sinkParam}) {
  // A query string embedded in path folds into query, matching
  // createValidator; the explicit field wins when both are present.
  const req = normalizeRequestQuery(rawReq);
  const method = (req.method ?? "GET").toUpperCase();
  const match = router.match(method, req.path);
  if (match === undefined) {
    return createLeafError(
      "route", [],
      \`no route matches \${method} \${req.path}\`,
      { method, path: req.path },
    );
  }
  if (match.kind === "method-not-allowed") {
    return createLeafError(
      "method", [],
      \`method \${method} not allowed on \${match.pathPattern}; allowed: \${match.allowed.join(", ")}\`,
      { method, pathPattern: match.pathPattern, allowed: match.allowed },
    );
  }
  const op = ops[\`\${match.pathPattern}::\${method}\`];
  if (op === undefined) {
    // Filtered-out op: treat as route miss.
    return createLeafError("route", [], \`no route matches \${method} \${req.path}\`, { method, path: req.path });
  }

  // Security gate.
  if (op.compiledSecurity !== undefined) {
    const securityErr = checkSecurity(op.compiledSecurity, req);
    if (securityErr !== null) {
      return createBranchError(
        "request", [],
        \`\${method} \${match.pathPattern}: request validation failed\`,
        [securityErr],
        { method, pathPattern: match.pathPattern },
      );
    }
  }

  // Content-type gate (only if there's a request body). Only \`undefined\`
  // means absent; a parsed JSON \`null\` is a value and reaches the schema.
  // Mirrors validate-step.ts.
  const hasBody = req.body !== undefined;
  const bodyMediaTypes = op.bodyMediaTypes;
  let requestBodyMediaType;
  // Mirrors validate-step.ts exactly: a declared Content-Type that
  // matches nothing is the actionable signal even when no body was
  // sent. Skipping on !hasBody alone let the emitted module accept a
  // wrong Content-Type that the runtime rejects.
  if (op.hasRequestBody && (hasBody || req.contentType !== undefined) && bodyMediaTypes.length > 0) {
    requestBodyMediaType = matchParsedMediaType(req.contentType, bodyMediaTypes);
    if (requestBodyMediaType === undefined) {
      return createBranchError(
        "request", [],
        \`\${method} \${match.pathPattern}: request validation failed\`,
        [createLeafError(
          "content-type", ["body"],
          contentTypeErrorMessage("request", req.contentType, req.headers),
          { contentType: req.contentType, accepted: bodyMediaTypes.map((mt) => mt.pattern) },
        )],
        { method, pathPattern: match.pathPattern },
      );
    }
  }

  const children = [];

  // Parameter validation. Mirrors validate-step.ts:validateParameter.
  for (const p of op.parameters) {
    const err = __validateParameter(p, req, match${sinkParam});
    if (err !== null) children.push(err);
  }

  // Body validation.
  if (op.hasRequestBody) {
    if (!hasBody) {
      if (op.requestBodyRequired) {
        children.push(createLeafError("body", ["body"], "missing required request body", {}));
      }
    } else {
      const mt = requestBodyMediaType ?? matchParsedMediaType(req.contentType, bodyMediaTypes);
      if (mt !== undefined) {
        // Own-property test rather than an undefined check: the map is
        // a plain object literal, and a media type may now be declared
        // without a schema. A bare word parses as a media type, so
        // "constructor" is a matchable pattern whose inherited value is
        // not undefined and is not a validator.
        const v = Object.hasOwn(op.bodyValidators, mt) ? op.bodyValidators[mt] : undefined;
        // A declared media type with no schema negotiates but does not
        // validate; the body passes through.
        if (v !== undefined) {
          const r = v.validate(req.body, ["body"]);
          if (!r.valid && r.error !== undefined) children.push(r.error);
        }
      }
    }
  }

  if (children.length === 0) return null;
  return createBranchError(
    "request", [],
    \`\${method} \${match.pathPattern}: request validation failed\`,
    children,
    { method, pathPattern: match.pathPattern },
  );
}

function __missingParameter(p) {
  if (!p.required) return null;
  return createLeafError(
    p.in === "header" ? "header-param" : p.in === "path" ? "path-param" : p.in === "query" ? "query-param" : "cookie-param",
    [p.in, p.name],
    \`missing required \${p.in} parameter "\${p.name}"\`,
    { name: p.name, in: p.in },
  );
}

function __validateParameter(p, req, match${sinkParam}) {
  // Object assembly, ahead of the by-name read. OpenAPI spreads an
  // object-typed parameter over several wire keys for style form with
  // explode true and for style deepObject in the query, and for 3.2's
  // style cookie when exploded, so nothing is stored under the
  // parameter's own name. Mirrors validate-step.ts, which gates on the
  // same two assemblers and hands the result to validateAssembled;
  // reading the name first reported the parameter missing when it was
  // required, and skipped validating it entirely when it was not (#888).
  const assembled = p.in === "query"
    ? assembleObjectQueryParam(p, req.query)
    : p.in === "cookie"
      ? assembleObjectCookieParam(p, req.cookies)
      : undefined;
  if (assembled !== undefined) {
    if (p.__validator === null) return null;
    if (assembled.value === undefined) return __missingParameter(p);
    const r = p.__validator.validate(assembled.value, [p.in, p.name]);
    ${accept("    ", "assembled.value")}
    return r.error;
  }
  const raw = __readParamRaw(p, req, match);
  if (raw === undefined) return __missingParameter(p);
  if (p.__validator === null) return null;
  const value = deserialize(raw, p);
  // Mirrors validateParameter in validate-step.ts: a present token can
  // still supply no value, which \`deserialize\` reports as undefined.
  // Gated on the style there and here, because an object-typed
  // parameter handed an empty array reads undefined too and that is not
  // absence. See #758 and #789.
  if (value === undefined && (p.style === "matrix" || p.style === "label")) return __missingParameter(p);
  const r = p.__validator.validate(value, [p.in, p.name]);
  ${accept("  ", "value")}
  return r.error;
}

function __readParamRaw(p, req, match) {
  if (p.in === "path") return p.__readOwn ? __own(match.pathParams, p.name) : match.pathParams[p.name];
  if (p.in === "query") return p.__readOwn ? __own(req.query, p.name) : req.query?.[p.name];
  if (p.in === "header") {
    return p.__readOwn ? __readHeader(req.headers, p.name) : __readHeaderFast(req.headers, p.name);
  }
  if (p.in === "cookie") return p.__readOwn ? __own(req.cookies, p.name) : req.cookies?.[p.name];
  return undefined;
}
${returnValues ? RECORD_VALUE_HELPER : ""}`;
}

/**
 * The emitted twin of `recordValue` in validate-step.ts, appended to
 * the request-tree block when `returnValues` is on.
 *
 * The accumulator's field names differ from `p.in` for two of the four
 * locations, so the mapping is explicit here for the same reason it is
 * explicit there.
 *
 * Four arms and no `default`, matching the runtime rather than reading
 * the last location as an else. A location this switch has never heard
 * of records nothing, which is what the runtime does; recording it
 * under whichever arm happened to be last would put a value in the
 * channel under a name no reader could predict.
 */
const RECORD_VALUE_HELPER = `
function __recordValue(sink, p, value) {
  switch (p.in) {
    case "path": sink.path[p.name] = value; return;
    case "query": sink.query[p.name] = value; return;
    case "header": sink.headers[p.name] = value; return;
    case "cookie": sink.cookies[p.name] = value; return;
  }
}
`;

function renderValidateResponseTreeNoop(): string {
  return `function __validateResponseTree(_req, _res) {
  // compile-spec was run with --requests-only; responses are a pass-through.
  return null;
}
`;
}

function renderValidateResponseTree(): string {
  return `function __validateResponseTree(req, res) {
  const method = (req.method ?? "GET").toUpperCase();
  const match = router.match(method, req.path);
  if (match === undefined) {
    return createLeafError(
      "route", [],
      \`no route matches \${method} \${req.path}\`,
      { method, path: req.path },
    );
  }
  if (match.kind === "method-not-allowed") {
    return createLeafError(
      "method", [],
      \`method \${method} not allowed on \${match.pathPattern}; allowed: \${match.allowed.join(", ")}\`,
      { method, pathPattern: match.pathPattern, allowed: match.allowed },
    );
  }
  const op = ops[\`\${match.pathPattern}::\${method}\`];
  if (op === undefined) {
    return createLeafError("route", [], \`no route matches \${method} \${req.path}\`, { method, path: req.path });
  }
  const children = [];
  const statusKey = matchResponseKey(res.status, op.responses);
  if (statusKey === undefined) {
    children.push(createLeafError("status", [], \`no response defined for status \${res.status}\`, { status: res.status }));
  } else {
    const resp = op.responses[statusKey];
    if (resp !== undefined) {
      // Header validation.
      if (res.headers !== undefined) {
        for (const [name, hdr] of Object.entries(resp.headers)) {
          const raw = hdr.__readOwn ? __readHeader(res.headers, name) : __readHeaderFast(res.headers, name);
          if (hdr.required && (raw === undefined || raw === "")) {
            children.push(createLeafError("header-param", ["header", name], \`missing required header "\${name}"\`, { name, in: "header" }));
            continue;
          }
          if (raw === undefined) continue;
          if (hdr.__validator === null) continue;
          const value = deserialize(raw, { name, in: "header", schema: hdr.schema, style: undefined, explode: undefined });
          const r = hdr.__validator.validate(value, ["header", name]);
          if (!r.valid && r.error !== undefined) children.push(r.error);
        }
      }
      // Body validation.
      const bodyMediaTypes = resp.bodyMediaTypes;
      if (bodyMediaTypes.length > 0 && res.body !== undefined) {
        const mt = matchParsedMediaType(res.contentType, bodyMediaTypes);
        if (mt === undefined) {
          children.push(createLeafError("content-type", ["body"], contentTypeErrorMessage("response", res.contentType, res.headers, statusKey), { contentType: res.contentType, declared: bodyMediaTypes.map((m) => m.pattern) }));
        } else {
          const v = Object.hasOwn(resp.bodyValidators, mt) ? resp.bodyValidators[mt] : undefined;
          if (v !== undefined) {
            const r = v.validate(res.body, ["body"]);
            if (!r.valid && r.error !== undefined) children.push(r.error);
          }
        }
      }
    }
  }
  if (children.length === 0) return null;
  return createBranchError(
    "response", [],
    \`\${method} \${match.pathPattern}: response validation failed\`,
    children,
    { method, pathPattern: match.pathPattern, status: res.status },
  );
}
`;
}

/**
 * The exported validate* surface. Each builds the nested tree via the
 * internal __validate*Tree helper, then reshapes to the configured
 * output (`__outputMode` / `__maxErrors`) exactly as validator.ts does
 * at its public boundary, so the AOT output matches `createValidator`.
 */
function renderPublicValidators(returnValues: boolean): string {
  // With `returnValues` on, validateRequest allocates the accumulator,
  // hands it to the walk, and attaches it to the object reshapeResult
  // just returned. Mirrors validator.ts's public entry point, including
  // attaching after the reshape rather than inside it.
  const validateRequestBody = returnValues
    ? `  const sink = emptyRequestValues();
  const result = reshapeResult(__validateRequestTree(req, sink), __outputMode, __maxErrors);
  result.value = sink;
  return result;`
    : "  return reshapeResult(__validateRequestTree(req), __outputMode, __maxErrors);";
  // A body the reader rejects fails before any request validation, so
  // no parameter was reached and the request side answers with an empty
  // channel rather than an absent one. The response side carries none:
  // `returnValues` is a request-side option.
  const bodyFailureTail = returnValues
    ? `  const reshaped = reshapeResult(wrapped, __outputMode, __maxErrors);
  if (direction.kind === "request") reshaped.value = emptyRequestValues();
  return toFetchResult(reshaped, undefined);`
    : "  return toFetchResult(reshapeResult(wrapped, __outputMode, __maxErrors), undefined);";
  return `export function validateRequest(req) {
${validateRequestBody}
}

export function validateResponse(req, res) {
  return reshapeResult(__validateResponseTree(req, res), __outputMode, __maxErrors);
}

function __bodyFailure(err, direction) {
  // Mirrors createValidator: a body the reader rejects is a validation
  // verdict, so the two body errors convert to a result; IO and
  // user-callback failures propagate unchanged.
  let leaf;
  if (err instanceof FetchBodyParseError) {
    leaf = {
      code: "body",
      path: ["body"],
      message: err.message,
      params: { mediaType: err.mediaType },
      children: [],
    };
  } else if (err instanceof FetchBodyTooLargeError) {
    leaf = {
      code: "body-too-large",
      path: ["body"],
      message: err.message,
      params: { limit: err.limit, reason: err.reason, bytes: err.bytes },
      children: [],
    };
  } else {
    return undefined;
  }
  // Wrapped in the same request/response branch every other error here
  // carries, so a consumer can tell a client's bad upload from an
  // upstream's bad reply. The request branch has no pathPattern: the
  // body is read before routing.
  const wrapped =
    direction.kind === "request"
      ? {
          code: "request",
          path: [],
          message: \`\${direction.method}: request validation failed\`,
          params: { method: direction.method },
          children: [leaf],
        }
      : {
          code: "response",
          path: [],
          message: "response validation failed",
          params: { status: direction.status },
          children: [leaf],
        };
${bodyFailureTail}
}

export async function validateFetchRequest(request, options) {
  let extracted;
  try {
    // A per-call maxTotalBytes wins over the baked-in one, when the
    // caller supplied one; an explicit undefined keeps the baked cap.
    extracted = await httpRequestFromFetch(request, {
      ...options,
      maxTotalBytes: options?.maxTotalBytes ?? __maxTotalBytes,
    });
  } catch (err) {
    const verdict = __bodyFailure(err, { kind: "request", method: request.method.toUpperCase() });
    if (verdict !== undefined) return verdict;
    throw err;
  }
  return toFetchResult(validateRequest(extracted.httpRequest), extracted.body);
}

export async function validateFetchResponse(request, response) {
  // Method and path are all response matching needs; building the
  // request through the extractor would consume the caller's request
  // body stream, which the interpreted validator leaves unread.
  const url = new URL(request.url);
  const httpRequest = { method: request.method.toUpperCase(), path: url.pathname };
  let extracted;
  try {
    extracted = await httpResponseFromFetch(response, { maxTotalBytes: __maxTotalBytes });
  } catch (err) {
    const verdict = __bodyFailure(err, { kind: "response", status: response.status });
    if (verdict !== undefined) return verdict;
    throw err;
  }
  return toFetchResult(validateResponse(httpRequest, extracted.httpResponse), extracted.body);
}
`;
}

function renderGetOperation(): string {
  return `export function getOperation({ method, path }) {
  const m = (method ?? "GET").toUpperCase();
  const match = router.match(m, path);
  if (match === undefined || match.kind === "method-not-allowed") return null;
  const key = \`\${match.pathPattern}::\${m}\`;
  const op = ops[key];
  if (op === undefined) return null;
  const meta = __meta[key];
  return {
    pathPattern: match.pathPattern,
    pathItem: meta?.pathItem ?? {},
    operation: meta?.operation ?? {},
  };
}
`;
}

/**
 * Every `format` name in the document's schema positions with no
 * validator behind it, sorted. Shares the walk `check`'s
 * format-not-validated pass uses, so the two commands and the finding
 * see the same positions.
 */
function collectDocumentUnknownFormats(document: OpenAPIDocument): string[] {
  const found = new Set<string>();
  walkDocumentSchemas(document, {
    onSchemaNode: (schema) => {
      const format = schema["format"];
      if (typeof format === "string" && isUnknownFormat(format)) found.add(format);
    },
  });
  return [...found].sort();
}

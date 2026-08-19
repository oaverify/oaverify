/**
 * The runner: drive one declaration through both implementations and
 * record what each did, then classify the differences.
 *
 * The record shape follows `scripts/grid/dump.mjs` so the two
 * instruments can be read side by side, with one change: leaves are
 * recorded as `(code, path)` tuples rather than as separate code and
 * path lists. Comparing the two lists independently calls a request
 * with two leaves and their codes swapped identical, which is the shape
 * a misattributed parameter error takes.
 *
 * There is no oracle here. `createValidator` is the reference side
 * because it is the interpreted implementation the emitted one is meant
 * to match, not because it is known correct. See this directory's
 * README.
 */

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenAPIDocument, ValidationError } from "@oaverify/internal-core";
import { createValidator } from "@oaverify/internal-validator";
import { compileSpecCommand } from "../../src/commands.js";
import { memoryIo } from "../fixtures.js";
import { workspaceAliases } from "../../../../workspace-aliases.js";
import {
  optionCacheKey,
  type CaseAxes,
  type Declaration,
  type RuntimeOptions,
  type WireRequest,
} from "./cases.js";

const CORE_ALIASES = Object.fromEntries(
  Object.entries(
    workspaceAliases(resolvePath(fileURLToPath(new URL("../../../..", import.meta.url)))),
  ).filter(([k]) => k.startsWith("@oaverify/core")),
);
const RESOLVE_DIR = resolvePath(fileURLToPath(new URL("../../../oav", import.meta.url)));

/**
 * One leaf error, reduced to what two implementations can be compared
 * on.
 *
 * `path` stays the array the validator produced. Joining it on `.`
 * would make `["query", "a.b"]` and `["query", "a", "b"]` compare
 * equal, and a parameter or property name containing a dot is legal, so
 * the flattened form can call an attribution mistake identical. The
 * whole reason leaves are compared as tuples is to catch attribution
 * mistakes.
 */
export interface Leaf {
  code: string;
  path: (string | number)[];
}

/** What one side did with one request. */
export interface Observation {
  verdict: "valid" | "invalid" | "throw" | "build-error";
  leaves?: Leaf[];
  value?: unknown;
  /** `getOperation`: the matched pathPattern, or null. */
  operation?: string | null;
  error?: string;
}

export interface CaseResult {
  id: string;
  axes: CaseAxes;
  wireId: string;
  runtime: Observation;
  aot: Observation;
}

interface AotModule {
  validateRequest: (req: unknown) => unknown;
  getOperation: (req: { method: string; path: string }) => { pathPattern: string } | null;
}

/** Compile a document through the real CLI path and load the module. */
async function buildAot(document: OpenAPIDocument): Promise<AotModule> {
  const mem = memoryIo([["spec.json", document]]);
  const res = await compileSpecCommand(
    {
      spec: "spec.json",
      overlays: [],
      output: "out.mjs",
      resolveDir: RESOLVE_DIR,
      bundleAlias: CORE_ALIASES,
      returnValues: true,
    },
    mem.io,
  );
  if (res.exitCode !== 0) throw new Error(`compile-spec exit ${res.exitCode}: ${mem.stderr.value}`);
  const bundled = mem.writes[0]?.[1];
  if (bundled === undefined) throw new Error("compile-spec wrote nothing");
  return (await import(
    `data:text/javascript;base64,${Buffer.from(bundled).toString("base64")}`
  )) as AotModule;
}

/** Leaves of a flat result, sorted by (path, code) so order cannot differ. */
function leavesOf(errors: ValidationError[] | undefined): Leaf[] {
  return (errors ?? [])
    .map((e) => ({ code: e.code, path: [...(e.path ?? [])] }))
    .sort((a, b) => {
      // Sorted on the serialized array rather than a joined string, for
      // the reason on `Leaf.path`.
      const pa = JSON.stringify(a.path);
      const pb = JSON.stringify(b.path);
      return pa === pb ? a.code.localeCompare(b.code) : pa.localeCompare(pb);
    });
}

type FlatResult = {
  valid: boolean;
  errors?: ValidationError[];
  value?: unknown;
};

function observe(
  validate: (req: unknown) => unknown,
  getOperation: (req: { method: string; path: string }) => { pathPattern: string } | null,
  request: WireRequest,
): Observation {
  let operation: string | null | undefined;
  try {
    const op = getOperation({ method: request.method, path: request.path });
    operation = op === null ? null : op.pathPattern;
  } catch (err) {
    return { verdict: "throw", error: describe(err) };
  }
  let result: FlatResult;
  try {
    result = validate(request) as FlatResult;
  } catch (err) {
    return { verdict: "throw", error: describe(err), operation };
  }
  return {
    verdict: result.valid ? "valid" : "invalid",
    leaves: result.valid ? [] : leavesOf(result.errors),
    value: result.value,
    operation,
  };
}

const describe = (err: unknown): string =>
  `${(err as Error)?.name ?? "Error"}: ${(err as Error)?.message ?? String(err)}`;

/**
 * Both sides of one document, built once.
 *
 * Product A folds every declaration for a location into one document
 * and hands the same object to hundreds of declarations, so the cache
 * is keyed on document identity: without it the grid recompiles a
 * 1,000-path module once per path, which is the difference between a
 * gate people run and one they skip. The runtime side is keyed on the
 * option delta as well, since that is an axis; see `keyFor`.
 *
 * A document either side refuses is itself a datum: a side that starts
 * or stops refusing one has changed. The fold trades granularity for
 * speed here, and a refusal takes its whole location with it rather
 * than marking one cell, which the report shows as a `build-error`
 * verdict across every case of that document.
 */
interface Built {
  aot?: AotModule;
  aotError?: string;
  runtime?: ReturnType<typeof createValidator>;
  runtimeError?: string;
}

const builtCache = new Map<string, Built>();
const docKeys = new WeakMap<object, number>();
let nextDocKey = 0;

// Keyed on the option delta as well as the document. The emitted module
// is the same whatever the delta says, and the runtime validator is not,
// so keying on the document alone would hand one delta's validator to a
// case built for another. `optionCacheKey` rather than `renderOptions`:
// a key has to tell two `ignorePaths` predicates apart, and an id does
// not.
function keyFor(doc: object, options: RuntimeOptions): string {
  let id = docKeys.get(doc);
  if (id === undefined) {
    id = nextDocKey;
    nextDocKey += 1;
    docKeys.set(doc, id);
  }
  return `${id}::${optionCacheKey(options)}`;
}

async function build(decl: Declaration): Promise<Built> {
  const key = keyFor(decl.doc, decl.axes.runtimeOptions);
  const hit = builtCache.get(key);
  if (hit !== undefined) return hit;
  const out: Built = {};
  try {
    out.aot = await buildAot(decl.doc);
  } catch (err) {
    out.aotError = describe(err);
  }
  try {
    // The case's own delta, over `returnValues`. A delta cannot switch
    // the value channel off: `RuntimeOptions` omits `returnValues`, so
    // a case setting it does not compile. The spread order is not what
    // protects it, and a later key here would win.
    out.runtime = createValidator(decl.doc, {
      returnValues: true,
      ...decl.axes.runtimeOptions,
    });
  } catch (err) {
    out.runtimeError = describe(err);
  }
  builtCache.set(key, out);
  return out;
}

/** Run every request of one declaration through both sides. */
export async function runDeclaration(decl: Declaration): Promise<CaseResult[]> {
  const { aot, aotError, runtime, runtimeError } = await build(decl);

  return decl.requests.map(({ wireId, request }) => ({
    id: decl.id,
    axes: decl.axes,
    wireId,
    runtime:
      runtime === undefined
        ? { verdict: "build-error", error: runtimeError }
        : observe(
            (r) => runtime.validateRequest(r as never),
            (r) => runtime.getOperation(r) as { pathPattern: string } | null,
            request,
          ),
    aot:
      aot === undefined
        ? { verdict: "build-error", error: aotError }
        : observe(aot.validateRequest, aot.getOperation, request),
  }));
}

/** Which channels differ for one case. Empty means the two agree. */
export type Channel = "verdict" | "leaves" | "value" | "operation" | "error";

const json = (v: unknown) => JSON.stringify(v ?? null);

/**
 * `error` carries the message of a `throw` or a `build-error`, and it
 * is compared: two sides refusing the same document for unrelated
 * reasons agree on the verdict and are not the same event. The wording
 * comes from two independently written implementations, so a difference
 * here is expected to need a registry entry rather than to be a defect
 * on its own; the entry is where a human says which it is. No case
 * reaches it today.
 */
export function differences(c: CaseResult): Channel[] {
  const out: Channel[] = [];
  if (c.runtime.verdict !== c.aot.verdict) out.push("verdict");
  if (json(c.runtime.leaves) !== json(c.aot.leaves)) out.push("leaves");
  if (json(c.runtime.value) !== json(c.aot.value)) out.push("value");
  if (json(c.runtime.operation) !== json(c.aot.operation)) out.push("operation");
  if (json(c.runtime.error) !== json(c.aot.error)) out.push("error");
  return out;
}

/**
 * A difference, reduced to the signature a registry entry has to state.
 * Two cases with the same signature are the same divergence seen twice.
 */
export function signatureOf(c: CaseResult): string {
  const channels = differences(c);
  const parts = channels.map((ch) => {
    if (ch === "verdict") return `verdict:${c.runtime.verdict}->${c.aot.verdict}`;
    if (ch === "leaves") {
      return `leaves:${json(c.runtime.leaves)}->${json(c.aot.leaves)}`;
    }
    if (ch === "value") return `value:${json(c.runtime.value)}->${json(c.aot.value)}`;
    if (ch === "error") return `error:${json(c.runtime.error)}->${json(c.aot.error)}`;
    return `operation:${json(c.runtime.operation)}->${json(c.aot.operation)}`;
  });
  return parts.join(" | ");
}

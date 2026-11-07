/**
 * Divergence report: the operation model beside the document walkers.
 *
 * Builds the operation model for every document in a corpus and runs
 * walkers that decide for themselves which operations a document has
 * beside it: the runtime router (`createValidator` + `getOperation`),
 * the emitter (`emitSpec`'s ops table) and the stream analyzer
 * (`analyzeSpec`). Every place a walker and the model disagree is
 * counted and listed. A walker
 * that reads the model agrees with it by construction; its comparison
 * stays as the check that the port changed nothing else.
 *
 * Opt in with OPMODEL_DIVERGENCE=1; the real-world corpus needs
 * `detection/real-world/download.sh` to have run. OPMODEL_LIMIT caps the
 * real-world documents; OPMODEL_REPORT names the markdown output.
 *
 * Lives beside the CLI tests because this is the one package whose
 * declared dependencies reach every walker. `@oaverify/syntax` is pulled
 * in for its YAML reader only.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTP_METHODS, type OpenAPIDocument } from "@oaverify/internal-core";
import { loadSpecSync } from "@oaverify/syntax";
import {
  buildOperationModel,
  followReference,
  type ModelOperation,
  type OperationModel,
} from "@oaverify/internal-core/internals";
import { createValidator } from "@oaverify/internal-validator";
import { analyzeSpec } from "@oaverify/stream";
import { emitSpec } from "../src/emit-spec.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const ok = { "200": { description: "ok" } };

interface Corpus {
  readonly name: string;
  readonly documents: ReadonlyArray<{
    readonly label: string;
    readonly document: () => OpenAPIDocument;
  }>;
}

interface DocReport {
  label: string;
  operations: number;
  byContainer: Record<string, number>;
  additional: number;
  chained: number;
  diagnostics: Record<string, number>;
  behindRef: number;
  notes: string[];
  loadError?: string;
}

interface Divergence {
  readonly walker: "router" | "emitter" | "stream-analyzer";
  readonly label: string;
  readonly detail: string;
}

/** Small documents built to make walkers disagree. */
const synthetic: Corpus = {
  name: "synthetic",
  documents: [
    {
      label: "path-item-chain",
      document: () =>
        doc("3.1.0", {
          paths: { "/p": { $ref: "#/x-items/Mid", get: { responses: ok, tags: ["entry"] } } },
          "x-items": {
            Mid: {
              $ref: "#/x-items/Final",
              post: { responses: ok, tags: ["mid"], requestBody: body() },
            },
            Final: { put: { responses: ok, tags: ["final"], requestBody: body() } },
          },
          tags: [{ name: "entry" }, { name: "mid" }, { name: "final" }],
        }),
    },
    {
      label: "path-item-chain-cycle",
      document: () =>
        doc("3.1.0", {
          paths: {
            "/ok": { get: { responses: ok } },
            "/p": { $ref: "#/x-items/A", get: { responses: ok } },
          },
          "x-items": { A: { $ref: "#/x-items/B" }, B: { $ref: "#/x-items/A" } },
        }),
    },
    {
      label: "path-item-chain-null-target",
      document: () =>
        doc("3.1.0", {
          paths: { "/p": { $ref: "#/x-null", get: { responses: ok } } },
          "x-null": null,
        }),
    },
    // The longest chain the engines follow, and one reference longer.
    ...[31, 32].map((edges) => ({
      label: `path-item-chain-${edges}-references`,
      document: () => {
        const items: Record<string, unknown> = {};
        for (let i = 0; i < edges - 1; i++) items[`I${i}`] = { $ref: `#/x-items/I${i + 1}` };
        items[`I${edges - 1}`] = { get: { responses: ok } };
        return doc("3.1.0", { paths: { "/p": { $ref: "#/x-items/I0" } }, "x-items": items });
      },
    })),
    {
      label: "percent-encoded-leading-slash",
      document: () =>
        doc("3.1.0", {
          paths: { "/p": { $ref: "#%2Fx-items%2FG" } },
          "x-items": { G: { get: { responses: ok, requestBody: body() } } },
        }),
    },
    {
      label: "callback-reference-dag",
      document: () => {
        const callbacks: Record<string, unknown> = {};
        for (let i = 0; i < 12; i++) {
          const next = { $ref: `#/components/callbacks/C${i + 1}` };
          callbacks[`C${i}`] = {
            "{$url}": { post: { responses: ok, callbacks: i < 11 ? { a: next, b: next } : {} } },
          };
        }
        return doc("3.1.0", {
          paths: {
            "/p": {
              post: { responses: ok, callbacks: { c: { $ref: "#/components/callbacks/C0" } } },
            },
          },
          components: { callbacks },
        });
      },
    },
    {
      label: "version-undefined-positions",
      document: () =>
        doc("3.0.3", {
          paths: {
            "/p": {
              query: { responses: ok, requestBody: body() },
              additionalOperations: { PURGE: { responses: ok, requestBody: body() } },
            },
          },
          webhooks: { w: { post: { responses: ok, requestBody: body() } } },
        }),
    },
    {
      label: "additional-operations-32",
      document: () =>
        doc("3.2.0", {
          paths: {
            "/p": {
              query: { responses: ok, requestBody: body(), tags: ["q"] },
              additionalOperations: {
                PURGE: { responses: ok, requestBody: body(), tags: ["purge"] },
              },
            },
          },
          tags: [{ name: "q" }, { name: "purge" }],
        }),
    },
    {
      label: "webhook-via-ref",
      document: () =>
        doc("3.1.0", {
          paths: {},
          webhooks: { w: { $ref: "#/components/pathItems/W" } },
          components: {
            pathItems: { W: { post: { responses: ok, requestBody: body(), tags: ["hook"] } } },
          },
          tags: [{ name: "hook" }],
        }),
    },
    {
      label: "callback-tags",
      document: () =>
        doc("3.1.0", {
          paths: {
            "/p": {
              post: {
                responses: ok,
                callbacks: {
                  done: {
                    "{$request.body#/url}": {
                      post: { responses: ok, requestBody: body(), tags: ["cb"] },
                    },
                  },
                },
              },
            },
          },
          tags: [{ name: "cb" }],
        }),
    },
    {
      label: "percent-encoded-ref",
      document: () =>
        doc("3.1.0", {
          paths: { "/p": { $ref: "#/x-items/My%20Item" } },
          "x-items": { "My Item": { get: { responses: ok, tags: ["enc"] } } },
          tags: [{ name: "enc" }],
        }),
    },
    {
      label: "extension-key-under-paths",
      document: () =>
        doc("3.1.0", {
          paths: {
            "/p": { get: { responses: ok } },
            "x-vendor": { get: { responses: ok, tags: ["x"] } },
          },
          tags: [{ name: "x" }],
        }),
    },
    {
      label: "component-path-item-unreferenced",
      document: () =>
        doc("3.1.0", {
          paths: { "/p": { get: { responses: ok } } },
          components: {
            pathItems: {
              Loose: { delete: { responses: ok, requestBody: body(), tags: ["loose"] } },
            },
          },
          tags: [{ name: "loose" }],
        }),
    },
    {
      label: "head-implied-and-ref",
      document: () =>
        doc("3.1.0", {
          paths: { "/raw": { get: { responses: ok } }, "/ref": { $ref: "#/x-items/G" } },
          "x-items": { G: { get: { responses: ok } } },
        }),
    },
  ],
};

function doc(version: string, extra: Record<string, unknown>): OpenAPIDocument {
  return { openapi: version, info: { title: "t", version: "1" }, ...extra } as OpenAPIDocument;
}
function body(): Record<string, unknown> {
  return { content: { "application/json": { schema: { type: "object" } } } };
}

function fileCorpus(
  name: string,
  dir: string,
  limit = Infinity,
  accept = /\.(ya?ml|json)$/,
): Corpus {
  if (!existsSync(dir)) return { name, documents: [] };
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (accept.test(entry.name)) files.push(full);
    }
  };
  walk(dir);
  files.sort();
  return {
    name,
    documents: files.slice(0, limit).map((file) => ({
      label: relative(root, file),
      document: () => loadSpecSync({ entry: file }).document,
    })),
  };
}

const upper = (m: string): string => m.toUpperCase();
const concretize = (template: string): string => template.replace(/\{[^}]*\}/g, "1");
const errorText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 160);

function reportOne(label: string, document: OpenAPIDocument, divergences: Divergence[]): DocReport {
  if (process.env["OPMODEL_PROGRESS"]) process.stderr.write(`[opmodel] ${label}\n`);
  const model = buildOperationModel(document);
  // The emitter compiles every schema into one module and the analyzer
  // classifies every body schema; on the largest published documents
  // either is more heap than a test worker has.
  const bytes = JSON.stringify(document).length;
  const heavyCap = Number(process.env["OPMODEL_HEAVY_MAX_BYTES"] ?? 4_000_000);
  const heavy = bytes > heavyCap ? `document is ${bytes} bytes, cap ${heavyCap}` : undefined;
  const report: DocReport = {
    label,
    operations: model.operations.length,
    byContainer: {},
    additional: 0,
    chained: 0,
    diagnostics: {},
    behindRef: 0,
    notes: [],
  };
  for (const item of model.pathItems) {
    report.byContainer[item.container] = (report.byContainer[item.container] ?? 0) + 1;
    if (item.chain.hops.length > 1) report.chained++;
  }
  for (const op of model.operations) {
    if (op.methodKind === "additional") report.additional++;
    if (!op.servedBy.runtime.served && op.servedBy.runtime.reason === "behind-path-item-ref")
      report.behindRef++;
  }
  for (const d of model.diagnostics)
    report.diagnostics[d.status] = (report.diagnostics[d.status] ?? 0) + 1;

  compareRouter(label, model, divergences, report);
  if (heavy === undefined) compareEmitter(label, model, divergences, report);
  else report.notes.push(`emitSpec skipped: ${heavy}`);
  if (heavy === undefined) compareStreamAnalyzer(label, model, divergences, report);
  else report.notes.push(`analyzeSpec skipped: ${heavy}`);
  return report;
}

/** The router serves exactly the operations the model says it does. */
function compareRouter(
  label: string,
  model: OperationModel,
  out: Divergence[],
  report: DocReport,
): void {
  let validator: ReturnType<typeof createValidator>;
  try {
    validator = createValidator(model.document, { onUnknownVersion: "fallback31" });
  } catch (e) {
    report.notes.push(`createValidator threw: ${errorText(e)}`);
    return;
  }
  for (const op of model.operations) {
    if (op.pathItem.container !== "paths" || op.methodKind !== "fixed") continue;
    // A template holding `#` or `?` (AWS writes `/#X-Amz-Target=...`) is
    // never reached by a request path, so the probe cannot speak to it.
    if (/[#?]/.test(op.pathItem.key)) continue;
    let found: ReturnType<typeof validator.getOperation>;
    try {
      found = validator.getOperation({
        method: upper(op.method),
        path: concretize(op.pathItem.key),
      });
    } catch (e) {
      out.push({
        walker: "router",
        label,
        detail: `${op.pointer}: getOperation threw ${errorText(e)}`,
      });
      continue;
    }
    const served = found !== null && found.operation === op.node;
    const collided = found !== null && found.operation !== op.node;
    if (served === op.servedBy.runtime.served) continue;
    if (collided) continue; // another template matched the concretized path; inconclusive
    out.push({
      walker: "router",
      label,
      detail: `${op.pointer}: model says runtime ${op.servedBy.runtime.served ? "served" : `not served (${op.servedBy.runtime.reason})`}, router ${served ? "serves it" : "does not"}`,
    });
  }
  // The reverse direction: everything the router serves under a `paths`
  // key is an operation the model calls runtime-served, or its implied
  // HEAD. This is the half that sees an operation the model left out,
  // and an `x-` key (an extension, not a template) served as a route.
  const servedKeys = new Set<string>();
  for (const op of model.operations) {
    if (op.servedBy.runtime.served) servedKeys.add(`${op.pathItem.key}\0${op.method}`);
  }
  for (const item of model.pathItems) {
    if (item.impliedHead.runtime) servedKeys.add(`${item.key}\0head`);
  }
  const paths = (model.document as { paths?: Record<string, unknown> }).paths ?? {};
  for (const key of Object.keys(paths)) {
    if (/[#?]/.test(key)) continue;
    for (const method of HTTP_METHODS) {
      if (servedKeys.has(`${key}\0${method}`)) continue;
      let found: ReturnType<typeof validator.getOperation> = null;
      try {
        found = validator.getOperation({ method: upper(method), path: concretize(key) });
      } catch {
        // a key that is not a parseable template cannot be probed
      }
      if (found !== null && found.pathPattern === key)
        out.push({
          walker: "router",
          label,
          detail: `router serves ${upper(method)} ${key}, model lists no runtime-served operation there`,
        });
    }
  }
}

/** The emitter's ops table matches the model's `servedBy.emitted`. */
function compareEmitter(
  label: string,
  model: OperationModel,
  out: Divergence[],
  report: DocReport,
): void {
  const emitFails =
    model.operations.some(
      (op) => !op.servedBy.emitted.served && op.servedBy.emitted.reason === "emit-fails",
    ) ||
    model.pathItems.some((item) => item.container === "paths" && item.chain.status !== "complete");
  let source: string;
  try {
    source = emitSpec(model.document, { unknownFormats: "ignore" });
  } catch (e) {
    report.notes.push(
      emitFails
        ? `emitSpec threw, as the model expects: ${errorText(e)}`
        : `emitSpec threw: ${errorText(e)}`,
    );
    return;
  }
  if (emitFails)
    out.push({
      walker: "emitter",
      label,
      detail: `model says emitSpec fails on a reference chain under paths, emitSpec built`,
    });
  const emitted = new Set<string>();
  for (const m of source.matchAll(/^ {2}"((?:[^"\\]|\\.)*)": /gm)) {
    const key = JSON.parse(`"${m[1]}"`) as string;
    if (/::[A-Z]+$/.test(key)) emitted.add(key);
  }
  const expected = new Map<string, ModelOperation>();
  for (const op of model.operations) {
    if (op.servedBy.emitted.served) expected.set(`${op.pathItem.key}::${upper(op.method)}`, op);
  }
  for (const [key, op] of expected) {
    if (!emitted.has(key))
      out.push({
        walker: "emitter",
        label,
        detail: `${op.pointer}: model says emitted, ops table lacks ${key}`,
      });
  }
  for (const key of emitted) {
    if (!expected.has(key))
      out.push({
        walker: "emitter",
        label,
        detail: `ops table has ${key}, model says not emitted`,
      });
  }
}

/** Whether a Request Body or Response Object, reference followed, holds a schema under `content`. */
function holdsBodySchema(document: OpenAPIDocument, node: unknown, pointer: string): boolean {
  const chain = followReference(document, node, pointer);
  const target = chain.status === "complete" ? chain.target : undefined;
  if (target === null || typeof target !== "object") return false;
  const content = (target as { content?: unknown }).content;
  if (content === null || typeof content !== "object") return false;
  return Object.values(content).some(
    (mediaType) => mediaType !== null && typeof mediaType === "object" && "schema" in mediaType,
  );
}

function hasBodySchema(document: OpenAPIDocument, op: ModelOperation): boolean {
  if (holdsBodySchema(document, op.node.requestBody, `${op.pointer}/requestBody`)) return true;
  const responses: unknown = op.node.responses;
  if (responses === null || typeof responses !== "object") return false;
  return Object.entries(responses).some(
    ([status, response]) =>
      !status.startsWith("x-") &&
      holdsBodySchema(document, response, `${op.pointer}/responses/${status}`),
  );
}

/** The analyzer lists exactly the `paths` operations with a request or response body schema. */
function compareStreamAnalyzer(
  label: string,
  model: OperationModel,
  out: Divergence[],
  report: DocReport,
): void {
  let listed: Set<string>;
  try {
    listed = new Set(analyzeSpec(model.document).operations.map((o) => `${o.method} ${o.path}`));
  } catch (e) {
    report.notes.push(`analyzeSpec threw: ${errorText(e)}`);
    return;
  }
  const expected = new Map<string, ModelOperation>();
  for (const op of model.operations) {
    if (op.pathItem.container !== "paths" || op.methodKind !== "fixed") continue;
    if (hasBodySchema(model.document, op)) {
      expected.set(`${upper(op.method)} ${op.pathItem.key}`, op);
    }
  }
  for (const [key, op] of expected) {
    if (!listed.has(key))
      out.push({
        walker: "stream-analyzer",
        label,
        detail: `${op.pointer}: has a body schema, analyzer omits ${key}`,
      });
  }
  for (const key of listed) {
    if (!expected.has(key))
      out.push({
        walker: "stream-analyzer",
        label,
        detail: `analyzer lists ${key}, model has no body schema for it`,
      });
  }
}

function render(
  corpora: ReadonlyArray<{ corpus: Corpus; reports: DocReport[] }>,
  divergences: Divergence[],
): string {
  const lines: string[] = ["# Operation model divergence report", ""];
  lines.push(
    "| corpus | documents | load failures | operations | path items via chain | additionalOperations | behind a Path Item ref | chain diagnostics |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const { corpus, reports } of corpora) {
    const loaded = reports.filter((r) => r.loadError === undefined);
    const sum = (f: (r: DocReport) => number): number => loaded.reduce((n, r) => n + f(r), 0);
    lines.push(
      `| ${corpus.name} | ${reports.length} | ${reports.length - loaded.length} | ${sum((r) => r.operations)} | ${sum((r) => r.chained)} | ${sum((r) => r.additional)} | ${sum((r) => r.behindRef)} | ${sum((r) => Object.values(r.diagnostics).reduce((a, b) => a + b, 0))} |`,
    );
  }
  lines.push("", "## Divergences by walker", "");
  lines.push("| walker | count | documents |");
  lines.push("| --- | ---: | ---: |");
  const walkers = ["router", "emitter", "stream-analyzer"] as const;
  for (const w of walkers) {
    const mine = divergences.filter((d) => d.walker === w);
    lines.push(`| ${w} | ${mine.length} | ${new Set(mine.map((d) => d.label)).size} |`);
  }
  for (const w of walkers) {
    const mine = divergences.filter((d) => d.walker === w);
    if (mine.length === 0) continue;
    lines.push("", `### ${w}`, "");
    const byLabel = new Map<string, string[]>();
    for (const d of mine) byLabel.set(d.label, [...(byLabel.get(d.label) ?? []), d.detail]);
    for (const [label, details] of byLabel) {
      lines.push(`- **${label}** (${details.length})`);
      for (const detail of details.slice(0, 6)) lines.push(`  - ${detail}`);
      if (details.length > 6) lines.push(`  - ... ${details.length - 6} more`);
    }
  }
  const notes = corpora.flatMap(({ reports }) =>
    reports.flatMap((r) => [
      ...r.notes.map((n) => `${r.label}: ${n}`),
      ...(r.loadError === undefined ? [] : [`${r.label}: load failed: ${r.loadError}`]),
    ]),
  );
  if (notes.length > 0) {
    lines.push("", "## Walker failures and load errors", "");
    for (const n of notes) lines.push(`- ${n}`);
  }
  return lines.join("\n") + "\n";
}

describe.skipIf(!process.env["OPMODEL_DIVERGENCE"])("operation model divergence report", () => {
  it(
    "builds the model beside every walker and writes the report",
    { timeout: 20 * 60 * 1000 },
    () => {
      const limit = Number(process.env["OPMODEL_LIMIT"] ?? Infinity);
      const corpora: Corpus[] = [
        synthetic,
        fileCorpus("detection cases", join(root, "detection", "cases")),
        fileCorpus(
          "conformance openapi cases",
          join(root, "conformance", "openapi-cases"),
          Infinity,
          /^spec\.(ya?ml|json)$/,
        ),
        fileCorpus("real-world", join(root, "detection", "real-world", "specs"), limit),
      ];
      const divergences: Divergence[] = [];
      const results = corpora.map((corpus) => ({
        corpus,
        reports: corpus.documents.map(({ label, document }) => {
          let loaded: OpenAPIDocument;
          try {
            loaded = document();
          } catch (e) {
            return {
              label,
              operations: 0,
              byContainer: {},
              additional: 0,
              chained: 0,
              diagnostics: {},
              behindRef: 0,
              notes: [],
              loadError: errorText(e),
            } satisfies DocReport;
          }
          return reportOne(label, loaded, divergences);
        }),
      }));
      const target =
        process.env["OPMODEL_REPORT"] ?? join(tmpdir(), "operation-model-divergence.md");
      writeFileSync(target, render(results, divergences));
      process.stdout.write(`\noperation model divergence report: ${target}\n`);
      expect(results.reduce((n, r) => n + r.reports.length, 0)).toBeGreaterThan(0);
    },
  );
});

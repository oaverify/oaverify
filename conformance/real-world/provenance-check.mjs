/**
 * Smoke test for source provenance (#596) against real-world specs.
 *
 * Fixtures prove the rules the resolver was written to follow. This
 * proves the addresses it hands out are real: an address is re-read
 * from disk, its pointer walked in the document it names, and the node
 * it lands on required to exist.
 *
 * Two audits, because they answer different questions:
 *
 * - **Every node**, through `loadSpec` directly. Does not depend on the
 *   spec having defects, so a clean spec still exercises the whole
 *   pointer space. This is where subtraction arithmetic fails.
 * - **Every finding**, through the built CLI. Proves the end-to-end
 *   path a user actually runs, including the one pass in `check` that
 *   attaches a source to a target.
 *
 * Two shapes, because they exercise different halves of the resolver:
 *
 * - **Flat.** The specs as published, single file. A single-file
 *   resolution mounts one region at the root, so every source must be
 *   the entry document, `via` empty, and `source.pointer` *identical*
 *   to the resolved pointer.
 * - **Split.** Each component schema and each path item mechanically
 *   extracted into its own file, with internal references rewritten to
 *   cross files. Schemas go through hoisting, path items through
 *   inlining, and the rewrite produces recursion across documents,
 *   schemas shared by many use sites, and cycles.
 *
 * Usage (from repo root):
 *   pnpm build
 *   node conformance/real-world/provenance-check.mjs           # default set
 *   node conformance/real-world/provenance-check.mjs --all
 *   node conformance/real-world/provenance-check.mjs box.json
 *
 * Not wired into CI: the corpus is gitignored (see ./download.sh) and
 * the largest specs take minutes. Run it before shipping changes to the
 * resolver's provenance walk.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

import { composeReaders, createFileReader, loadSpec, sourceOf } from "../../dist/spec.js";
import { createYamlFileReader } from "../../packages/yaml/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SPECS = join(HERE, "specs");
const CLI = join(ROOT, "packages", "oav", "dist", "cli.js");

// The whole corpus takes a while; these three cover 3.0 and 3.1, YAML
// and JSON, a fully-inlined spec and two component-heavy ones. `--all`
// runs the rest.
const DEFAULT_SET = ["adyen-checkout.json", "digitalocean.yaml", "box.json"];

// Auditing every node against every region is O(nodes x regions).
// Beyond this product the node audit samples, and says so.
const AUDIT_BUDGET = 60_000_000;

const run = promisify(execFile);

function parseSpec(path) {
  const raw = readFileSync(path, "utf8");
  return extname(path).toLowerCase() === ".json" ? JSON.parse(raw) : parseYaml(raw);
}

function escapeSegment(segment) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapeSegment(segment) {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * A pointer segment as written in a URI fragment.
 *
 * Fragments are percent-decoded before the pointer escapes are read:
 * DigitalOcean writes `#/paths/~1v2~1account~1keys~1%7Bid%7D`, and the
 * key it names has literal braces.
 */
function fragmentSegment(segment) {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    /* not valid percent-encoding; take it literally */
  }
  return unescapeSegment(decoded);
}

/** Walk an RFC 6901 pointer, returning a sentinel when it does not resolve. */
const MISSING = Symbol("missing");
function resolvePointer(document, pointer) {
  if (pointer === "") return document;
  let node = document;
  for (const raw of pointer.split("/").slice(1)) {
    const segment = unescapeSegment(raw);
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return MISSING;
      node = node[index];
      continue;
    }
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, segment)) return MISSING;
    node = node[segment];
  }
  return node;
}

function everyPointer(node, at, out) {
  out.push(at);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) everyPointer(node[i], `${at}/${i}`, out);
    return out;
  }
  if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      everyPointer(value, `${at}/${escapeSegment(key)}`, out);
    }
  }
  return out;
}

/**
 * Re-read documents on demand, keeping what was parsed.
 *
 * `resolve` turns the URI an address carries into a path this process
 * can read: the resolver reports what it was given, which is a file URL
 * for the entry and a relative path for anything it reached from there.
 */
function pathFor(base) {
  return (uri) => {
    if (uri.startsWith("file:")) return fileURLToPath(uri);
    return isAbsolute(uri) ? uri : join(base, uri);
  };
}

function documents(resolve) {
  const cache = new Map();
  return (uri) => {
    if (!cache.has(uri)) {
      try {
        cache.set(uri, { document: parseSpec(resolve(uri)) });
      } catch (err) {
        cache.set(uri, { error: err.message });
      }
    }
    return cache.get(uri);
  };
}

/**
 * Check one address: the document it names is readable, the pointer
 * resolves in it, and every hop lands on a `$ref` node.
 */
function auditAddress(source, load, describe, problems) {
  const entry = load(source.uri);
  if (entry.error !== undefined) {
    problems.push(`${describe}: unreadable source ${source.uri}: ${entry.error}`);
    return;
  }
  if (resolvePointer(entry.document, source.pointer) === MISSING) {
    problems.push(`${describe}: ${source.uri}${source.pointer} does not resolve`);
  }
  for (const hop of source.via) {
    const held = load(hop.uri);
    if (held.error !== undefined) {
      problems.push(`${describe}: unreadable hop ${hop.uri}: ${held.error}`);
      continue;
    }
    const node = resolvePointer(held.document, hop.pointer);
    if (node === MISSING) {
      problems.push(`${describe}: hop ${hop.uri}${hop.pointer} does not resolve`);
    } else if (typeof node !== "object" || node === null || typeof node.$ref !== "string") {
      problems.push(`${describe}: hop ${hop.uri}${hop.pointer} is not a $ref node`);
    }
  }
}

async function check(entry) {
  // `check` exits non-zero whenever it finds anything, which is the
  // normal case here, so the exit code is not the signal; stdout is.
  //
  // The heap is raised because `check` on the largest specs in this
  // corpus needs more than Node's default. That is true of `main` too
  // (Stripe peaks near 10GB either way), so it is a property of the
  // corpus rather than of provenance.
  let stdout;
  try {
    ({ stdout } = await run(
      process.execPath,
      ["--max-old-space-size=12288", CLI, "check", entry, "--format", "json"],
      { maxBuffer: 512 * 1024 * 1024 },
    ));
  } catch (err) {
    if (typeof err.stdout !== "string" || err.stdout === "") throw err;
    stdout = err.stdout;
  }
  return JSON.parse(stdout).findings;
}

/**
 * Rewrite a reference written inside a node that has been moved into
 * its own file one directory below the entry.
 */
function rewriteRef(ref, files, where) {
  if (!ref.startsWith("#/")) return ref;
  const segments = ref.slice(2).split("/");
  const { prefix, entry } = where;
  if (segments.length === 3 && segments[0] === "components" && segments[1] === "schemas") {
    const file = files.schemas.get(fragmentSegment(segments[2]));
    if (file !== undefined) return `${prefix}schemas/${file}#/schema`;
  }
  // A reference into a path item has to follow it out to its own file.
  // After the split the entry holds a `$ref` at that name, so a pointer
  // through it would walk into a reference node instead of the item.
  if (segments.length >= 2 && segments[0] === "paths") {
    const file = files.paths.get(fragmentSegment(segments[1]));
    if (file !== undefined) {
      const rest = segments.slice(2);
      return `${prefix}paths/${file}#/pathItem${rest.length > 0 ? `/${rest.join("/")}` : ""}`;
    }
  }
  return `${entry}${ref.slice(1)}`;
}

function rewriteRefs(node, files, where) {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, files, where));
  if (typeof node !== "object" || node === null) return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] =
      key === "$ref" && typeof value === "string"
        ? rewriteRef(value, files, where)
        : rewriteRefs(value, files, where);
  }
  return out;
}

// Where a rewritten reference is being written: `prefix` reaches the
// split directories, `entry` reaches whatever stayed in the entry.
const FROM_SPLIT = { prefix: "../", entry: "../entry.json#" };
const FROM_ENTRY = { prefix: "./", entry: "#" };

/**
 * A file name for a component name or a path template.
 *
 * Both carry slashes, braces and dots in the wild (Box, Twilio,
 * GitHub). Percent-encoding is not enough: the resolver resolves a
 * reference as a URI, so `%2F` comes back out as a directory
 * separator. Reduce to a safe slug and disambiguate by ordinal.
 */
function fileNamer() {
  let n = 0;
  return (name) => {
    n += 1;
    const slug = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return `${n}-${slug.slice(0, 60) || "x"}.json`;
  };
}

/**
 * Write a multi-file version of `document` into `dir`: one file per
 * component schema, one per path item, the entry keeping a `$ref` at
 * each name. Returns null when there is nothing to extract.
 */
function split(document, dir) {
  const schemas = document.components?.schemas ?? {};
  const paths = document.paths ?? {};
  const hasSchemas = Object.keys(schemas).length > 0;
  if (!hasSchemas && Object.keys(paths).length === 0) return null;

  mkdirSync(join(dir, "schemas"), { recursive: true });
  mkdirSync(join(dir, "paths"), { recursive: true });

  // Every name is assigned before anything is written, since an
  // extracted node's own references can name any of the others.
  const nameFile = fileNamer();
  const files = {
    schemas: new Map(Object.keys(schemas).map((name) => [name, nameFile(name)])),
    paths: new Map(Object.keys(paths).map((template) => [template, nameFile(template)])),
  };

  const replacedSchemas = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const file = files.schemas.get(name);
    writeFileSync(
      join(dir, "schemas", file),
      JSON.stringify({ schema: rewriteRefs(schema, files, FROM_SPLIT) }),
    );
    replacedSchemas[name] = { $ref: `./schemas/${file}#/schema` };
  }
  const replacedPaths = {};
  for (const [template, item] of Object.entries(paths)) {
    const file = files.paths.get(template);
    writeFileSync(
      join(dir, "paths", file),
      JSON.stringify({ pathItem: rewriteRefs(item, files, FROM_SPLIT) }),
    );
    replacedPaths[template] = { $ref: `./paths/${file}#/pathItem` };
  }

  // Everything the entry keeps is rewritten too: a reference it holds
  // into `paths` or `components.schemas` now points at a `$ref` node.
  const kept = rewriteRefs(
    Object.fromEntries(
      Object.entries(document).filter(([key]) => key !== "paths" && key !== "components"),
    ),
    files,
    FROM_ENTRY,
  );
  const components = rewriteRefs(document.components ?? {}, files, FROM_ENTRY);
  const entry = {
    ...kept,
    paths: replacedPaths,
    ...(hasSchemas ? { components: { ...components, schemas: replacedSchemas } } : { components }),
  };
  writeFileSync(join(dir, "entry.json"), JSON.stringify(entry));
  return {
    entry: join(dir, "entry.json"),
    files: Object.keys(schemas).length + Object.keys(paths).length,
  };
}

/** Audit every node of a resolved document against its regions. */
async function auditNodes(entryPath, resolveUri, expectFlat) {
  const reader = composeReaders([createYamlFileReader(), createFileReader()]);
  const { document, regions } = await loadSpec({
    reader,
    entry: pathToFileURL(entryPath).href,
    provenance: true,
  });
  if (regions === undefined) return { problems: ["loadSpec returned no regions"], audited: 0 };

  const pointers = everyPointer(document, "", []);
  const stride = Math.max(1, Math.ceil((pointers.length * regions.length) / AUDIT_BUDGET));
  const load = documents(resolveUri);
  const problems = [];
  let audited = 0;
  let addressed = 0;
  const seen = new Set();

  for (let i = 0; i < pointers.length; i += stride) {
    const pointer = pointers[i];
    audited += 1;
    const source = sourceOf(regions, pointer);
    if (source === undefined) continue;
    addressed += 1;
    seen.add(source.uri);
    if (problems.length < 40) auditAddress(source, load, pointer, problems);
    if (expectFlat) {
      if (source.pointer !== pointer) problems.push(`${pointer} addressed as ${source.pointer}`);
      if (source.via.length !== 0) problems.push(`${pointer} has hops in a single-file spec`);
    }
  }
  return {
    problems,
    audited,
    addressed,
    documents: seen.size,
    regions: regions.length,
    total: pointers.length,
    stride,
  };
}

/** Audit every finding the CLI reports. */
async function auditFindings(entryPath, resolveUri, expectFlat) {
  const findings = await check(entryPath);
  const load = documents(resolveUri);
  const problems = [];
  let addressed = 0;
  for (const finding of findings) {
    const target = finding.target;
    if (target === undefined) continue;
    if (target.source === undefined) {
      if (expectFlat) problems.push(`${target.pointer}: no source in a single-file spec`);
      continue;
    }
    addressed += 1;
    auditAddress(target.source, load, target.pointer, problems);
    if (expectFlat && target.source.pointer !== target.pointer) {
      problems.push(`${target.pointer} addressed as ${target.source.pointer}`);
    }
  }
  return { findings, problems, addressed };
}

/** What a finding is, independent of where the resolver put it. */
function identity(finding) {
  return `${finding.class} ${finding.code} ${finding.message}`;
}

function report(label, problems) {
  for (const problem of problems.slice(0, 8)) console.log(`  FAIL ${label} ${problem}`);
  if (problems.length > 8) console.log(`  ...  ${problems.length - 8} more`);
  return problems.length;
}

const argv = process.argv.slice(2);
const available = readdirSync(SPECS)
  .filter((f) => /\.(json|ya?ml)$/i.test(f))
  .sort();
const named = argv.filter((a) => !a.startsWith("--"));
const files = argv.includes("--all")
  ? available
  : named.length > 0
    ? named
    : DEFAULT_SET.filter((f) => available.includes(f));

if (files.length === 0) {
  console.error(`no specs under ${SPECS}; run ./download.sh first`);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const specPath = join(SPECS, file);
  console.log(`\n=== ${file} ===`);

  // The node audit hands loadSpec a file URL and the finding audit
  // hands the CLI a path, so a source URI can be either; anything the
  // resolver reached from there is relative to the entry's directory.
  const flatUri = pathFor(SPECS);
  const flatNodes = await auditNodes(specPath, flatUri, true);
  console.log(
    `flat  nodes:    ${flatNodes.addressed}/${flatNodes.audited} addressed` +
      (flatNodes.stride > 1 ? ` (1 in ${flatNodes.stride} of ${flatNodes.total})` : "") +
      `, ${flatNodes.regions} regions`,
  );
  failed += report("flat", flatNodes.problems);

  const flatFindings = await auditFindings(specPath, flatUri, true);
  console.log(
    `flat  findings: ${flatFindings.addressed}/${flatFindings.findings.length} addressed`,
  );
  failed += report("flat", flatFindings.problems);

  const dir = mkdtempSync(join(tmpdir(), "oav-prov-"));
  try {
    const parts = split(parseSpec(specPath), dir);
    if (parts === null) {
      console.log("split: skipped (nothing to extract)");
      continue;
    }
    const splitUri = pathFor(dir);
    const splitNodes = await auditNodes(parts.entry, splitUri, false);
    console.log(
      `split nodes:    ${splitNodes.addressed}/${splitNodes.audited} addressed` +
        (splitNodes.stride > 1 ? ` (1 in ${splitNodes.stride} of ${splitNodes.total})` : "") +
        `, ${splitNodes.regions} regions across ${splitNodes.documents} documents ` +
        `(${parts.files} files)`,
    );
    failed += report("split", splitNodes.problems);

    const splitFindings = await auditFindings(parts.entry, splitUri, false);
    console.log(
      `split findings: ${splitFindings.addressed}/${splitFindings.findings.length} addressed`,
    );
    failed += report("split", splitFindings.problems);

    // The split spec is the same spec, so it has the same defects. The
    // pointers move (hoisting renames components); the findings do not.
    const before = new Set(flatFindings.findings.map(identity));
    const after = new Set(splitFindings.findings.map(identity));
    const only = (a, b) => [...a].filter((id) => !b.has(id));
    const gone = only(before, after);
    const gained = only(after, before);
    if (gone.length > 0 || gained.length > 0) {
      console.log(`  NOTE ${gone.length} findings only flat, ${gained.length} only split`);
      for (const id of [...gone.slice(0, 3), ...gained.slice(0, 3)]) console.log(`       ${id}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failed === 0 ? "\nall addresses resolve" : `\n${failed} unresolved addresses`);
process.exit(failed === 0 ? 0 : 1);

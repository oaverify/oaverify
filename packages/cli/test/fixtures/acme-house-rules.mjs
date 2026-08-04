// The five acceptance-case shapes from #634, as one house-rule module.
// Nothing here imports from oaverify: a rule is plain JS over the
// resolved document.
import { readFileSync } from "node:fs";

/** RFC 6901 escape, for building a pointer out of a path template. */
const esc = (s) => s.replace(/~/g, "~0").replace(/\//g, "~1");

function* operations(doc) {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (["get", "put", "post", "delete", "patch", "head", "options", "trace"].includes(method)) {
        yield { path, method, op, pointer: `/paths/${esc(path)}/${method}` };
      }
    }
  }
}

export const rules = [
  // Case 1: a set operation over the document. Every operation must
  // declare an owner.
  {
    code: "x-acme/operation-needs-owner",
    severity: "error",
    *run(ctx) {
      for (const { op, pointer } of operations(ctx.document)) {
        if (typeof op["x-owner"] !== "string") {
          yield { pointer, message: `operation ${op.operationId} declares no x-owner` };
        }
      }
    },
  },

  // Case 2: a second set operation. Every tag used by an operation must
  // be declared at the document level, and tag names are case sensitive.
  {
    code: "x-acme/tag-undeclared",
    severity: "error",
    *run(ctx) {
      const declared = new Set((ctx.document.tags ?? []).map((t) => t.name));
      for (const { op, pointer } of operations(ctx.document)) {
        for (const [i, tag] of (op.tags ?? []).entries()) {
          if (!declared.has(tag)) {
            yield { pointer: `${pointer}/tags/${i}`, message: `tag "${tag}" is not declared` };
          }
        }
      }
    },
  },

  // Case 3: a business rule reaching external data. The service
  // registry is a file on disk here; in the reporter's case it is an
  // HTTP call. Either way it is ordinary JS, which is the point.
  {
    code: "x-acme/registry-owner-unknown",
    severity: "fatal",
    run(ctx) {
      const known = new Set(
        JSON.parse(readFileSync(new URL("./acme-registry.json", import.meta.url))),
      );
      const owners = new Set(
        [...operations(ctx.document)].map(({ op }) => op["x-owner"]).filter(Boolean),
      );
      const unknown = [...owners].filter((o) => !known.has(o));
      return unknown.length === 0
        ? []
        : [{ message: `owners not in the service registry: ${unknown.join(", ")}` }];
    },
  },

  // Case 4: a regex over a field. operationId is lowerCamelCase.
  {
    code: "x-acme/operation-id-camel",
    *run(ctx) {
      for (const { op, pointer } of operations(ctx.document)) {
        if (typeof op.operationId === "string" && !/^[a-z][A-Za-z0-9]*$/.test(op.operationId)) {
          yield {
            pointer: `${pointer}/operationId`,
            message: `operationId "${op.operationId}" is not lowerCamelCase`,
          };
        }
      }
    },
  },

  // Case 5: a second regex. Paths are kebab-case between templates.
  {
    code: "x-acme/path-kebab",
    *run(ctx) {
      for (const path of Object.keys(ctx.document.paths ?? {})) {
        const bad = path
          .split("/")
          .filter((seg) => seg !== "" && !seg.startsWith("{"))
          .filter((seg) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(seg));
        if (bad.length > 0) {
          yield {
            pointer: `/paths/${esc(path)}`,
            message: `path segments are not kebab-case: ${bad.join(", ")}`,
          };
        }
      }
    },
  },

  // Case 6, the reporter's own: every `format` in the document has a
  // registered validator. This is the one that needs compiler
  // knowledge, and the one #645 has since shipped as a built-in
  // (`format-not-validated`). Kept here to show what a rule can reach.
  {
    code: "x-acme/format-must-validate",
    severity: "error",
    *run(ctx) {
      // One finding per distinct format name: the remedy is per name,
      // and forty uses of one vendor format are one problem.
      const seen = new Set();
      function* walk(node, pointer) {
        if (node === null || typeof node !== "object") return;
        const format = node.format;
        if (typeof format === "string" && !ctx.knownFormats.has(format) && !seen.has(format)) {
          seen.add(format);
          yield {
            pointer: `${pointer}/format`,
            message: `format "${format}" has no registered validator`,
          };
        }
        for (const [key, child] of Object.entries(node))
          yield* walk(child, `${pointer}/${esc(key)}`);
      }
      yield* walk(ctx.document, "");
    },
  },
];

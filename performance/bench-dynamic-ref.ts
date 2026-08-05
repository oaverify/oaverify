/**
 * What runtime dynamic-scope resolution costs when a schema uses it.
 *
 * The zero-cost-when-unused half of the question is settled by the
 * emitted source: a compile unit without both `$dynamicRef` and
 * `$dynamicAnchor` produces byte-identical output, so there is nothing
 * to time. This measures the other half, by pairing each dynamic schema
 * with a `$ref` schema that does the same validation work without a
 * dynamic scope.
 *
 *   pnpm bench:dynamic
 */
import { Bench } from "tinybench";
import { compileSchema, jsonSchemaDialect } from "../packages/schema/src/index.ts";

const compile = (schema: unknown) =>
  compileSchema(schema as never, { dialect: jsonSchemaDialect, output: "flat" });

/** Self-recursive through `$dynamicRef`, one resource. */
const DYNAMIC_SELF = {
  $id: "https://bench.test/dynamic-self",
  $dynamicAnchor: "node",
  type: "object",
  properties: {
    name: { type: "string" },
    child: { $dynamicRef: "#node" },
  },
};

/** Same shape and same work, resolved statically. */
const STATIC_SELF = {
  $id: "https://bench.test/static-self",
  type: "object",
  properties: {
    name: { type: "string" },
    child: { $ref: "#" },
  },
};

/**
 * Recursion that alternates between two resources, so every descent
 * crosses a boundary twice and pays two wrapper frames on top of the
 * lookup. The `$ref` pair crosses the same boundaries without a scope.
 */
const DYNAMIC_CROSSING = {
  $id: "https://bench.test/dyn-a",
  $dynamicAnchor: "node",
  type: "object",
  properties: {
    name: { type: "string" },
    child: { $ref: "https://bench.test/dyn-b" },
  },
  $defs: {
    b: {
      $id: "https://bench.test/dyn-b",
      type: "object",
      properties: {
        name: { type: "string" },
        child: { $dynamicRef: "#node" },
      },
    },
  },
};

const STATIC_CROSSING = {
  $id: "https://bench.test/static-a",
  type: "object",
  properties: {
    name: { type: "string" },
    child: { $ref: "https://bench.test/static-b" },
  },
  $defs: {
    b: {
      $id: "https://bench.test/static-b",
      type: "object",
      properties: {
        name: { type: "string" },
        child: { $ref: "https://bench.test/static-a" },
      },
    },
  },
};

/** A payload `depth` levels deep, so each validation makes `depth` descents. */
function nest(depth: number): unknown {
  let node: Record<string, unknown> = { name: "leaf" };
  for (let i = 0; i < depth; i += 1) node = { name: `level-${i}`, child: node };
  return node;
}

const DEPTH = Number(process.argv.find((a) => a.startsWith("--depth="))?.slice(8) ?? 16);
const data = nest(DEPTH);

const validators = {
  "self-recursive, $dynamicRef": compile(DYNAMIC_SELF),
  "self-recursive, $ref": compile(STATIC_SELF),
  "resource-crossing, $dynamicRef": compile(DYNAMIC_CROSSING),
  "resource-crossing, $ref": compile(STATIC_CROSSING),
};

for (const [label, v] of Object.entries(validators)) {
  const result = v.validate(data);
  if (!result.valid)
    throw new Error(`${label} rejected the payload; the pairing is not equal work`);
}

const bench = new Bench({ time: 2000, warmupTime: 500 });
for (const [label, v] of Object.entries(validators)) {
  bench.add(label, () => {
    v.validate(data);
  });
}

await bench.run();

// tinybench v6's Task.result is a union covering errored / aborted /
// not-started states with no statistics, so probe rather than index
// (the same shape run.ts uses).
function taskStats(t: { name: string; result?: unknown }): { hz: number; ns: number; rme: number } {
  const r = t.result as
    | { throughput?: { mean?: number }; latency?: { mean?: number; rme?: number } }
    | undefined;
  const hz = r?.throughput?.mean;
  const latency = r?.latency?.mean;
  if (typeof hz !== "number" || typeof latency !== "number") {
    throw new TypeError(`no statistics for ${t.name}`);
  }
  return { hz, ns: latency * 1e6, rme: r?.latency?.rme ?? 0 };
}

console.log(`payload depth ${DEPTH}, ${DEPTH} descents per validation\n`);
console.table(
  bench.tasks.map((t) => {
    const s = taskStats(t);
    return {
      case: t.name,
      "ops/sec": Math.round(s.hz).toLocaleString(),
      "ns/op": Math.round(s.ns),
      rme: `${s.rme.toFixed(1)}%`,
    };
  }),
);

const ratio = (dynamic: string, staticRef: string) => {
  const d = taskStats(bench.tasks.find((t) => t.name === dynamic) as never).ns;
  const s = taskStats(bench.tasks.find((t) => t.name === staticRef) as never).ns;
  return `${(d / s).toFixed(3)}x  (${((d - s) / DEPTH).toFixed(1)} ns per descent)`;
};
console.log(
  `self-recursive     dynamic / static: ${ratio("self-recursive, $dynamicRef", "self-recursive, $ref")}`,
);
console.log(
  `resource-crossing  dynamic / static: ${ratio("resource-crossing, $dynamicRef", "resource-crossing, $ref")}`,
);

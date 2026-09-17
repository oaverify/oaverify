import { describe, expect, it } from "vitest";
import type { ParameterObject, ReferenceObject } from "@oaverify/internal-core";
import { createValidator } from "../src/index.js";
import {
  pathEncodingCases,
  pathEncodingDocument,
  strings,
} from "../../../test/fixtures/path-encoding.js";
import { createRouter } from "@oaverify/internal-router";
import { compileSchema, openapi31Dialect } from "@oaverify/internal-schema";
import { buildOperationCache } from "../src/operation-cache.js";
import { emptyRequestValues } from "../src/request-values.js";
import { validateParameter } from "../src/validate-step.js";
import { deserialize } from "../src/deserialize.js";

describe.each(["3.0.4", "3.1.0", "3.2.0"])("path wire encoding (%s)", (openapi) => {
  it.each(pathEncodingCases)("%s", (name, parameter, wire, expected) => {
    const compound = name === "compound capture";
    const validator = createValidator(pathEncodingDocument(parameter, openapi, compound), {
      returnValues: true,
    });
    const result = validator.validateRequest({
      method: "get",
      path: `/t/${compound ? `pre-${wire}.json` : wire}`,
    });
    expect(result.valid).toBe(true);
    expect(result.value.path.p).toEqual(expected);
  });

  it.each(["label", "matrix"] as const)("requires literal %s framing", (style) => {
    const validator = createValidator(
      pathEncodingDocument({ style, schema: { type: "string" } }, openapi),
    );
    expect(
      validator.validateRequest({
        method: "get",
        path: `/t/${style === "label" ? "%2Ea" : "%3Bp=a"}`,
      }).valid,
    ).toBe(false);
  });

  it("keeps content parameters decoded before JSON parsing", () => {
    const validator = createValidator(
      pathEncodingDocument({ content: { "application/json": { schema: strings } } }, openapi),
      { returnValues: true },
    );
    const result = validator.validateRequest({ method: "get", path: "/t/%5B%22a%2Cb%22%5D" });
    expect(result.valid).toBe(true);
    expect(result.value.path.p).toEqual(["a,b"]);
  });
});

it("preserves deserialize's decoded-input contract", () => {
  const p: ParameterObject = { name: "p", in: "path", schema: strings };
  expect(deserialize("a,b", p)).toEqual(["a", "b"]);
  expect(deserialize("a%2Cb", p)).toEqual(["a%2Cb"]);
});

it.each(["__proto__", "constructor"])("reads raw captures for parameter %s", (name) => {
  const document = pathEncodingDocument({ name, schema: strings }, "3.1.0");
  document.paths = { [`/t/{${name}}`]: document.paths!["/t/{p}"]! };
  const result = createValidator(document, { returnValues: true }).validateRequest({
    method: "GET",
    path: "/t/a%2Cb",
  });
  expect(result.valid).toBe(true);
  expect(result.value.path[name]).toEqual(["a,b"]);
});

it("falls back to decoded captures when a compound boundary bisects escaped UTF-8", () => {
  const document = pathEncodingDocument({ name: "a", schema: { type: "string" } }, "3.1.0");
  document.paths = { "/t/{a}{b}": document.paths!["/t/{p}"]! };
  const result = createValidator(document, { returnValues: true }).validateRequest({
    method: "GET",
    path: "/t/%F0%9F%98%80",
  });
  expect(result.valid).toBe(true);
  expect(result.value.path.a).toBe("\ud83d");
});

it("accepts legacy RouteMatch objects without raw captures", () => {
  const parameter: ParameterObject = { name: "p", in: "path", required: true, schema: strings };
  const doc = pathEncodingDocument(parameter, "3.1.0");
  const match = createRouter(doc.paths!).match("GET", "/t/a%2Cb");
  if (match?.kind !== "match") throw new Error("expected route match");
  delete match.rawPathParams;
  const compile = (schema: Parameters<typeof compileSchema>[0]) =>
    compileSchema(schema, { output: "tree", dialect: openapi31Dialect });
  const cache = buildOperationCache(match, {
    resolveRef: <T>(value: T | ReferenceObject | undefined) => value as T | undefined,
    resolveSchemaRef: () => undefined,
    compile,
    compileForDirection: compile,
  });
  const values = emptyRequestValues();
  expect(
    validateParameter(parameter, { method: "GET", path: "/t/a%2Cb" }, match, cache, values),
  ).toBeNull();
  expect(values.path.p).toEqual(["a", "b"]);
});

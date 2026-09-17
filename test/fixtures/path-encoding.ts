import type { OpenAPIDocument, ParameterObject, SchemaObject } from "@oaverify/internal-core";

export const strings: SchemaObject = { type: "array", items: { type: "string" } };
const object: SchemaObject = {
  type: "object",
  properties: { "a,b": { type: "integer" }, "a=b": { type: "boolean" } },
};

export const pathEncodingCases: [string, Partial<ParameterObject>, string, unknown][] = [
  ["simple list data", { schema: strings }, "blue%2Cblack", ["blue,black"]],
  ["simple list separator", { schema: strings }, "blue,black", ["blue", "black"]],
  ["simple object", { schema: object }, "a%2Cb,%31", { "a,b": 1 }],
  ["exploded simple object", { schema: object, explode: true }, "a%3Db=%74rue", { "a=b": true }],
  ["label list", { style: "label", schema: strings }, ".a%2Cb,c", ["a,b", "c"]],
  [
    "exploded label list",
    { style: "label", explode: true, schema: strings },
    ".a%2Eb.c",
    ["a.b", "c"],
  ],
  ["label object", { style: "label", schema: object }, ".a%2Cb,%31", { "a,b": 1 }],
  [
    "exploded label object",
    { style: "label", explode: true, schema: object },
    ".a%3Db=%74rue",
    { "a=b": true },
  ],
  ["matrix scalar", { style: "matrix", schema: { type: "string" } }, ";p=a%3Bb", "a;b"],
  ["matrix list", { style: "matrix", schema: strings }, ";p=a%2Cb,c%3Bd", ["a,b", "c;d"]],
  [
    "exploded matrix list",
    { style: "matrix", explode: true, schema: strings },
    ";p=a%3Bb;p=c%2Cd",
    ["a;b", "c,d"],
  ],
  ["matrix object", { style: "matrix", schema: object }, ";p=a%2Cb,%31", { "a,b": 1 }],
  [
    "exploded matrix object",
    { style: "matrix", explode: true, schema: object },
    ";a%3Db=%74rue",
    { "a=b": true },
  ],
  ["encoded matrix name", { style: "matrix", schema: strings }, ";%70=a%2Cb", ["a,b"]],
  [
    "decode once",
    { schema: strings },
    "%252C,%25,+,%C3%A9,%F0%9F%98%80",
    ["%2C", "%", "+", "é", "😀"],
  ],
  ["malformed item", { schema: strings }, "%ZZ,%61,%C3", ["%ZZ", "a", "%C3"]],
  ["decoded property coercion", { schema: object, explode: true }, "a%2Cb=%31", { "a,b": 1 }],
  [
    "encoded property name",
    { schema: { type: "object" }, explode: true },
    "%5F%5Fproto%5F%5F=a%2Cb,constructor=c%2Cd",
    { ["__proto__"]: "a,b", constructor: "c,d" },
  ],
  [
    "referenced items",
    { schema: { type: "array", items: { $ref: "#/components/schemas/Int" } } },
    "%31,%32",
    [1, 2],
  ],
  [
    "JSON content",
    { content: { "application/json": { schema: strings } } },
    "%5B%22a%2Cb%22%5D",
    ["a,b"],
  ],
  [
    "text content",
    { content: { "text/plain": { schema: { type: "string" } } } },
    "a%2Cb%252C",
    "a,b%2C",
  ],
  ["compound capture", { schema: strings }, "blue%2Cblack", ["blue,black"]],
];

export function pathEncodingDocument(
  parameter: Partial<ParameterObject>,
  openapi: string,
  compound = false,
): OpenAPIDocument {
  return {
    openapi,
    info: { title: "path encoding", version: "1" },
    components: { schemas: { Int: { type: "integer" } } },
    paths: {
      [compound ? "/t/pre-{p}.json" : "/t/{p}"]: {
        get: {
          parameters: [{ name: "p", in: "path", required: true, ...parameter }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

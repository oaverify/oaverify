import { expect, expectTypeOf, it } from "vitest";
import type {
  OpenAPIDocument,
  PathItem,
  ServerObject,
  ServerVariableObject,
} from "../src/index.js";

it("types Server Object variables and the 3.2 name (#1244)", () => {
  const document = {
    openapi: "3.2.0",
    info: { title: "t", version: "1" },
    paths: {},
    servers: [
      {
        url: "https://{region}.example.com",
        name: "regional",
        variables: { region: { default: "eu", enum: ["eu", "us"], description: "Region" } },
      },
    ],
  } satisfies OpenAPIDocument;
  expect(document.servers[0]?.variables.region.default).toBe("eu");
  expectTypeOf<ServerObject["variables"]>().toEqualTypeOf<
    Record<string, ServerVariableObject> | undefined
  >();
  expectTypeOf<ServerObject["name"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<ServerVariableObject["default"]>().toEqualTypeOf<string>();

  // @ts-expect-error A Server Variable Object requires a default.
  const noDefault: ServerVariableObject = { enum: ["eu"] };
  expect(noDefault.enum).toEqual(["eu"]);
});

it("types Path Item servers (#1321)", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: { "/a": { servers: [{ url: "https://example.com" }] } },
  } satisfies OpenAPIDocument;
  expect(document.paths["/a"].servers[0]?.url).toBe("https://example.com");
  expectTypeOf<PathItem["servers"]>().toEqualTypeOf<ServerObject[] | undefined>();
});

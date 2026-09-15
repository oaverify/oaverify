import { expect, expectTypeOf, it } from "vitest";
import type { ComponentsObject, OperationObject, PathItem, ReferenceObject } from "../src/types.js";

it("types reusable Path Items and references", () => {
  const components = {
    pathItems: {
      Inline: { get: { responses: { "200": { description: "ok" } } } },
      Ref: { $ref: "#/components/pathItems/Inline" },
    },
  } satisfies ComponentsObject;
  expect(components.pathItems.Inline.get.responses["200"].description).toBe("ok");
  expectTypeOf<ComponentsObject["pathItems"]>().toEqualTypeOf<
    Record<string, PathItem | ReferenceObject> | undefined
  >();
  expectTypeOf<"pathItems">().not.toExtend<keyof OperationObject>();
  const empty: ComponentsObject = {};
  expect(empty.pathItems).toBeUndefined();
  const invalid: ComponentsObject = {
    // @ts-expect-error A component entry must be a Path Item or reference.
    pathItems: { Invalid: 42 },
  };
  expect(invalid.pathItems).toBeDefined();
});

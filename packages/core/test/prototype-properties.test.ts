import { describe, expect, it } from "vitest";
import {
  isHeaderObjectPrototypePropertyName,
  isObjectPrototypePropertyName,
  OBJECT_PROTOTYPE_PROPERTY_NAMES,
} from "../src/prototype-properties.js";

describe("object prototype property classification", () => {
  it("covers every own property on Object.prototype", () => {
    for (const name of Object.getOwnPropertyNames(Object.prototype)) {
      expect(isObjectPrototypePropertyName(name), name).toBe(true);
      expect(OBJECT_PROTOTYPE_PROPERTY_NAMES).toContain(name);
    }
  });

  it("also treats __proto__ as hazardous", () => {
    expect(isObjectPrototypePropertyName("__proto__")).toBe(true);
  });

  it("classifies header names after lowercasing", () => {
    expect(isHeaderObjectPrototypePropertyName("Constructor")).toBe(true);
    expect(isHeaderObjectPrototypePropertyName("toString")).toBe(false);
  });
});

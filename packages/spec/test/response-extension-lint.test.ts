import { expect, it } from "vitest";
import type { OpenAPIDocument } from "@oaverify/internal-core";
import { lintResolvedSpec } from "../src/lint.js";

it.each(["3.0.3", "3.1.0", "3.2.0"])(
  "%s: server checks skip response extensions but keep x-prefixed map entries (#1291)",
  (openapi) => {
    const response = {
      description: "ok",
      links: {
        "x-link": {
          operationId: "getItem",
          server: {
            url: "https://{host}",
            variables: { version: { default: "b", enum: ["a"] } },
          },
        },
      },
    };
    const document: OpenAPIDocument = {
      openapi,
      info: { title: "extensions", version: "1" },
      paths: {
        "/p": {
          get: {
            operationId: "getItem",
            responses: {
              "200": { $ref: "#/components/responses/x-response" },
              "x-sample": response,
              "x-ref": { $ref: "#/components/responses/x-response" },
            },
          },
        },
      },
      components: { responses: { "x-response": response } },
    };
    // JSON input has separate objects even when their values are identical.
    const issues = lintResolvedSpec(JSON.parse(JSON.stringify(document)) as OpenAPIDocument).filter(
      (issue) => issue.code.startsWith("server-variable"),
    );
    expect(issues.map((issue) => [issue.code, issue.pointer])).toEqual([
      ["server-variable-undeclared", "/components/responses/x-response/links/x-link/server/url"],
      [
        openapi.startsWith("3.0")
          ? "server-variable-default-not-in-enum-oas30"
          : "server-variable-default-not-in-enum",
        "/components/responses/x-response/links/x-link/server/variables/version/default",
      ],
    ]);
  },
);

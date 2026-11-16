import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { METASCHEMA_REVISIONS } from "../src/index.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "oav-drift-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Stands in for spec.openapis.org: serves each pinned URL from the
// package copy the script is running in, and prints the URL so a test
// can tell whether anything was requested.
const FETCH_STUB = `
import { readFileSync } from "node:fs";
globalThis.fetch = async (url) => {
  console.log("fetch " + url);
  const version = /\\/oas\\/([^/]+)\\/schema\\//.exec(url)[1];
  const file =
    version === "3.0" ? "scripts/oas-3.0-upstream.json" : "src/vendor/oas-" + version + ".json";
  return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file, "utf8")) };
};
`;

/**
 * Run check-drift in a copy of the package with the network stubbed.
 * `edit` alters the copy first.
 */
function checkDrift(edit: (root: string) => void = () => {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const root = mkdtempSync(join(scratch, "pkg-"));
  for (const path of ["scripts", "src/index.ts", "src/vendor"]) {
    cpSync(join(PACKAGE, path), join(root, path), { recursive: true });
  }
  writeFileSync(join(root, "fetch-stub.mjs"), FETCH_STUB);
  edit(root);
  const run = spawnSync(
    process.execPath,
    ["--import", "./fetch-stub.mjs", "scripts/check-drift.mjs"],
    { cwd: root, encoding: "utf8" },
  );
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

function editIndex(root: string, from: string, to: string): void {
  const path = join(root, "src/index.ts");
  const source = readFileSync(path, "utf8");
  expect(source).toContain(from);
  writeFileSync(path, source.replace(from, to));
}

describe("check-drift: which versions get checked", () => {
  it("checks exactly the pins the package exports", () => {
    // The script reads src/index.ts as text. Comparing what it checked
    // with the exported value is what ties that reading to the real pins:
    // a declaration it misreads fails here, in the change that wrote it.
    const run = checkDrift();
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const checked = [...run.stdout.matchAll(/^ok {4}(\S+) @ (\S+)$/gm)].map(
      ([, version, revision]) => [version, revision],
    );
    expect(Object.fromEntries(checked)).toEqual({ ...METASCHEMA_REVISIONS });
    expect(checked).toHaveLength(Object.keys(METASCHEMA_REVISIONS).length);
    for (const [version, revision] of checked) {
      expect(run.stdout).toContain(
        `fetch https://spec.openapis.org/oas/${version}/schema/${revision}`,
      );
    }
    expect(run.stdout).toContain("all pins match");
  });

  it("fails without fetching when one pin is not a dated revision", () => {
    const run = checkDrift((root) => editIndex(root, '"3.1": "2025-11-23"', '"3.1": "latest"'));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('3.1 is pinned to "latest", not a YYYY-MM-DD revision');
    expect(run.stdout).not.toContain("fetch ");
    expect(run.stdout).not.toContain("all pins match");
  });

  it("fails without fetching when a pinned version has no vendored document", () => {
    const run = checkDrift((root) => rmSync(join(root, "src/vendor/oas-3.2.json")));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("3.2 is pinned but not vendored");
    expect(run.stdout).not.toContain("fetch ");
  });

  it("does not take a dated entry outside METASCHEMA_REVISIONS for the pin", () => {
    // The same text in a comment further down the file. Read as a pin,
    // it would stand in for the entry that cannot be parsed.
    const run = checkDrift((root) => {
      editIndex(root, '"3.1": "2025-11-23"', '"3.1": "latest"');
      editIndex(
        root,
        "export function metaschemaUrl",
        '// e.g. { "3.1": "2025-11-23" }\nexport function metaschemaUrl',
      );
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('3.1 is pinned to "latest", not a YYYY-MM-DD revision');
    expect(run.stdout).not.toContain("fetch ");
  });

  it("checks the revision in METASCHEMA_REVISIONS when another appears later", () => {
    const run = checkDrift((root) =>
      editIndex(
        root,
        "export function metaschemaUrl",
        '// e.g. { "3.1": "2020-01-01" }\nexport function metaschemaUrl',
      ),
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("ok    3.1 @ 2025-11-23");
  });

  it("fails when a version is pinned twice", () => {
    const run = checkDrift((root) =>
      editIndex(root, '"3.2": "2025-11-23",', '"3.2": "2025-11-23",\n  "3.1": "2020-01-01",'),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("3.1 is pinned more than once");
    expect(run.stdout).not.toContain("fetch ");
  });

  it("fails without fetching when a vendored version has no pin", () => {
    const run = checkDrift((root) => editIndex(root, '  "3.1": "2025-11-23",\n', ""));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("3.1 is vendored but not pinned");
    expect(run.stdout).not.toContain("fetch ");
    expect(run.stdout).not.toContain("all pins match");
  });

  it("fails when a second copy of the declaration sits in a comment", () => {
    // The copy comes first and is well-formed, so the script could read
    // it in place of the exported declaration.
    const run = checkDrift((root) => {
      const path = join(root, "src/index.ts");
      const source = readFileSync(path, "utf8");
      const declaration = /export const METASCHEMA_REVISIONS[\s\S]*?\n\}\);/.exec(source)?.[0];
      expect(declaration).toBeDefined();
      writeFileSync(path, `/* Example pins:\n${declaration}\n*/\n${source}`);
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("found 2 METASCHEMA_REVISIONS objects in src/index.ts");
    expect(run.stdout).not.toContain("fetch ");
    expect(run.stdout).not.toContain("all pins match");
  });

  it("reads an entry that ends with a comment", () => {
    const run = checkDrift((root) =>
      editIndex(root, '"3.1": "2025-11-23",', '"3.1": "2025-11-23", // current pin'),
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("ok    3.1 @ 2025-11-23");
  });

  it("reads a source file with CRLF line endings", () => {
    const run = checkDrift((root) => {
      const path = join(root, "src/index.ts");
      writeFileSync(path, readFileSync(path, "utf8").replaceAll("\n", "\r\n"));
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    for (const version of ["3.0", "3.1", "3.2"]) {
      expect(run.stdout).toContain(`ok    ${version} @ `);
    }
  });

  it("fails when the METASCHEMA_REVISIONS object cannot be found", () => {
    const run = checkDrift((root) => editIndex(root, "Object.freeze({\n  //", "frozen({\n  //"));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("could not find the METASCHEMA_REVISIONS object");
    expect(run.stdout).not.toContain("fetch ");
  });

  it("fails as a checker error when src/vendor is missing", () => {
    const run = checkDrift((root) => rmSync(join(root, "src/vendor"), { recursive: true }));
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("could not list src/vendor: ENOENT");
  });
});

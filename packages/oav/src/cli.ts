#!/usr/bin/env node
export {};

// Type-only, so it is erased and does not defeat the lazy imports below.
import type { ReaderPolicy } from "@oaverify/internal-cli";

// `commander` is a regular dependency of `oaverify`, so a normal install
// puts it in node_modules. If it's missing, the install is corrupted;
// catch the dynamic import up front and print a clearer message than
// the default ERR_MODULE_NOT_FOUND trace. `esbuild` is an optional
// peer dependency (only `compile-schema` / `compile-spec` use it);
// its absence is reported lazily by those commands.
try {
  await import("commander");
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
    process.stderr.write(
      "error: the oaverify CLI can't resolve 'commander' (argv parsing). " +
        "It's declared as a dependency of oaverify; reinstall the package to repair the node_modules tree:\n" +
        "    npm install --force oaverify\n" +
        "    pnpm install --force\n",
    );
    process.exit(2);
  }
  throw err;
}

const { buildProgram, defaultCommandIo } = await import("@oaverify/internal-cli");
const { createCliReader } = await import("./reader.js");

// Default I/O composes the YAML readers from @oaverify/syntax in front of
// the JSON-only readers baked into @oaverify/internal-cli's
// defaultCommandIo, so `oaverify resolve spec.yaml` and
// `oaverify resolve https://host/openapi` work out of the box. The chain
// itself is in ./reader.js so it can be tested; see createCliReader.
const baseIo = defaultCommandIo();
const io = {
  ...baseIo,
  reader: (policy: ReaderPolicy) => createCliReader(baseIo.reader(policy), policy),
};
// Read from this package's own manifest rather than a constant, so the
// reported version cannot drift from the installed package and there is
// nothing to remember to bump. npm always ships package.json, and the
// bin lives at dist/cli.js, so this resolves inside the tarball as well
// as in the repo.
const { readFile } = await import("node:fs/promises");
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const program = buildProgram({ io, version });
try {
  await program.parseAsync(process.argv);
} catch (err) {
  // `buildProgram` wires `exitOverride()` so Commander throws rather
  // than calling `process.exit` directly. That includes "success"
  // exits like `--help` / `--version` (exitCode 0) and argv parse
  // errors (non-zero).
  const e = err as { code?: string; exitCode?: number; message?: string };
  if (
    typeof e.exitCode === "number" &&
    typeof e.code === "string" &&
    e.code.startsWith("commander.")
  ) {
    // Commander's success exits keep their 0. Its failures are all argv
    // problems (unknown command, unknown option, missing argument), so
    // they take 3, the documented usage code, rather than Commander's
    // own 1. Honouring its exitCode verbatim meant `oaverify
    // bogus-command` exited 1, which the exit tables promise means "a
    // domain check failed": a CI script reading that saw a spec with
    // findings where it had a typo in the command name.
    process.exit(e.exitCode === 0 ? 0 : 3);
  }
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(3);
}

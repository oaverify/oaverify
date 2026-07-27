#!/usr/bin/env node
export {};

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
const { composeReaders } = await import("@oaverify/internal-spec");
const { createSmartHttpReader, createYamlFileReader } = await import("@oaverify/yaml");

// Default I/O composes the YAML readers from @oaverify/yaml in
// front of the JSON-only readers baked into @oaverify/internal-cli's defaultCommandIo,
// so `oaverify resolve spec.yaml` and `oaverify resolve https://host/openapi`
// work out of the box. createSmartHttpReader handles both JSON and
// YAML over HTTP by inspecting Content-Type; it replaces the core
// createHttpReader in the chain for any http(s) URI.
const baseIo = defaultCommandIo();
const io = {
  ...baseIo,
  reader: composeReaders([createYamlFileReader(), createSmartHttpReader(), baseIo.reader]),
};
const program = buildProgram({ io });
try {
  await program.parseAsync(process.argv);
} catch (err) {
  // `buildProgram` wires `exitOverride()` so Commander throws rather
  // than calling `process.exit` directly. That includes "success"
  // exits like `--help` / `--version` (exitCode 0) and argv parse
  // errors (non-zero). Honor the attached exitCode when present
  // rather than surfacing these as exit 3.
  const e = err as { code?: string; exitCode?: number; message?: string };
  if (
    typeof e.exitCode === "number" &&
    typeof e.code === "string" &&
    e.code.startsWith("commander.")
  ) {
    process.exit(e.exitCode);
  }
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(3);
}

// Assert the hand-maintained release lists against release-please-config.json.
//
// The published package set lives in the config once (as the source of
// truth release-please acts on) and is re-enumerated by hand in four
// places that have already drifted twice in one week (#654 left
// @oaverify/check out of Pack and ORDER together, so the in-workflow
// coverage assertion could not fire; the dispatch validator was fixed
// separately). The three release.yml lists cannot be derived at
// runtime, because the dispatch tag validator runs before checkout, so
// this script parses the workflow text instead (#659).
//
//   1. release.yml dispatch tag validator: its regex alternation must
//      name exactly the config's components.
//   2. release.yml Pack loop: its directory list must be exactly the
//      config's package directories.
//   3. release.yml ORDER: its tarball globs must cover every package's
//      tarball prefix exactly once, and every glob must match one.
//   4. The root build script: `pnpm build` means "make the oaverify CLI
//      runnable from the repo", so its --filter set must equal the
//      CLI's runtime dependency closure, derived from
//      packages/oav/package.json. The three adapters are deliberately
//      absent: nothing in-repo consumes their dist, and each one's
//      prepack builds it at publish (see AGENTS.md).
//
// Exit 0 clean; exit 1 with every mismatch listed.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const config = JSON.parse(read("release-please-config.json"));
const configDirs = Object.keys(config.packages).sort();
const components = configDirs.map((dir) => config.packages[dir].component).sort();

/** npm name of the package at `dir`, per its manifest. */
const nameOf = (dir) => JSON.parse(read(join(dir, "package.json"))).name;
/** Tarball prefix pnpm pack uses: scope flattened into the name. */
const tarballPrefix = (name) => name.replace(/^@/, "").replace("/", "-");

const releaseYml = read(".github/workflows/release.yml");
const failures = [];

// 1. Dispatch tag validator: ^(a|b|c)-v...
{
  const m = releaseYml.match(/\^\(([a-z0-9|]+)\)-v/);
  if (m === null) {
    failures.push("release.yml: could not find the dispatch tag validator regex");
  } else {
    const listed = m[1].split("|").sort();
    if (listed.join(",") !== components.join(",")) {
      failures.push(
        `release.yml tag validator lists [${listed.join(", ")}], config components are [${components.join(", ")}]`,
      );
    }
  }
}

// 2. Pack loop: `for pkg in . packages/a packages/b ...; do`
{
  const m = releaseYml.match(/for pkg in ([^;]+); do/);
  if (m === null) {
    failures.push("release.yml: could not find the Pack loop's directory list");
  } else {
    const listed = m[1].trim().split(/\s+/).sort();
    if (listed.join(",") !== configDirs.join(",")) {
      failures.push(
        `release.yml Pack loop lists [${listed.join(", ")}], config directories are [${configDirs.join(", ")}]`,
      );
    }
  }
}

// 3. ORDER: tarball globs, each covering exactly one package.
{
  const m = releaseYml.match(/ORDER=\(([^)]+)\)/);
  if (m === null) {
    failures.push("release.yml: could not find the ORDER array");
  } else {
    const patterns = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    const globToRegex = (glob) =>
      new RegExp(
        `^${glob.replaceAll(".", "\\.").replaceAll("*", ".*").replaceAll("[0-9]", "\\d")}$`,
      );
    const sampleFor = (dir) => `${tarballPrefix(nameOf(dir))}-1.0.0.tgz`;
    for (const dir of configDirs) {
      const sample = sampleFor(dir);
      const hits = patterns.filter((p) => globToRegex(p).test(sample));
      if (hits.length !== 1) {
        failures.push(
          `release.yml ORDER matches ${nameOf(dir)} (${sample}) ${hits.length} times [${hits.join(", ")}]; expected exactly once`,
        );
      }
    }
    for (const p of patterns) {
      if (!configDirs.some((dir) => globToRegex(p).test(sampleFor(dir)))) {
        failures.push(`release.yml ORDER pattern ${p} matches no configured package`);
      }
    }
  }
}

// 4. Root build script = the oaverify CLI's runtime closure. `tsup`
// builds @oaverify/core (the root package); the --filter entries must
// be the CLI itself plus its runtime deps that are workspace packages,
// core excepted.
{
  const build = JSON.parse(read("package.json")).scripts.build;
  const filters = [...build.matchAll(/--filter (\S+)/g)].map((m) => m[1]).sort();
  const workspaceNames = new Set(configDirs.map(nameOf));
  const cliDeps = Object.keys(JSON.parse(read("packages/oav/package.json")).dependencies ?? {});
  const expected = ["oaverify", ...cliDeps.filter((d) => workspaceNames.has(d))]
    .filter((n) => n !== "@oaverify/core")
    .sort();
  if (filters.join(",") !== expected.join(",")) {
    failures.push(
      `root build script filters [${filters.join(", ")}], the CLI closure is [${expected.join(", ")}] (tsup covers @oaverify/core)`,
    );
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`check-release-lists: ${f}`);
  process.exit(1);
}
console.log(
  `check-release-lists: ${configDirs.length} packages; tag validator, Pack, ORDER and the build closure all agree with release-please-config.json`,
);

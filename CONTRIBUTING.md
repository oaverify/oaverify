# Contributing

Repo-specific conventions, architecture notes, and the checks CI gates
on live in [AGENTS.md](./AGENTS.md). `CLAUDE.md` is a symlink to it. If
your checkout has `CLAUDE.md` containing only the text `AGENTS.md`,
symlinks are disabled (`core.symlinks=false`, common on Windows without
Developer Mode); enable them or read and edit `AGENTS.md` directly.

## Branch + PR flow

- `main` is protected. No direct pushes.
- Branch from `main` for every change (`feature/…`, `fix/…`, `docs/…` —
  naming convention not enforced, just helpful).
- Open a PR against `main`. Required status checks must pass before it
  can merge.
- Merging is **squash-only**, so one PR = one commit on `main`. The
  PR title becomes the commit subject, which is why the title is
  linted (see below).

## Commit / PR title format

PR titles follow [Conventional
Commits](https://www.conventionalcommits.org/):

```
<type>[optional !]: <subject>

examples:
  feat: add custom-keywords option to createValidator
  fix: resolve operation-level $ref in cacheFor
  docs: expand maxErrors example in validator README
  feat!: change ValidationError.children to always be an array
```

Allowed types: `feat`, `fix`, `perf`, `refactor`, `docs`, `build`,
`ci`, `chore`, `revert`, `style`, `test`.

Release-please uses these on merge:

- `feat:` → minor bump
- `fix:` → patch bump
- `!` or `BREAKING CHANGE:` footer → major bump
- everything else → no version bump

## Running checks locally

These four are what the PR gate runs. Run all four; a green `pnpm lint`
with a red `lint` job in CI is almost always the missing fourth one,
because `lint:type-aware` needs type information and is a separate pass
that plain `pnpm lint` does not include.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm lint:type-aware     # NOT part of `pnpm lint`; CI runs it separately
```

`pnpm build` is not part of the gate, but the CLI-driven harnesses below
need it because they execute `packages/oav/dist/cli.js`.

If `pnpm typecheck` reports errors in files you have not touched, the
incremental `tsc -b` state is stale rather than your change being wrong.
`pnpm clean && pnpm typecheck` settles it.

## The other harnesses

Each is a **separate pnpm root**: its dependencies are deliberately absent
from the main install, so each needs its own `pnpm install` once. All of
them are optional for most changes.

| Directory          | What it covers                                                                          | Bootstrap                      | In CI |
| ------------------ | --------------------------------------------------------------------------------------- | ------------------------------ | ----- |
| `conformance/`     | Upstream JSON Schema / JSON-parse / Overlay suites, plus OpenAPI request/response cases | `pnpm install && pnpm corpora` | yes   |
| `framework-tests/` | Real Express 4 / 5 and Fastify servers against the adapters                             | `pnpm install`                 | yes   |
| `performance/`     | Compile and validate benchmarks vs ajv, and memory vs express-openapi-validator         | `pnpm install`                 | no    |
| `detection/`       | Labelled corpus: which OpenAPI defects each tool catches                                | `pnpm install`                 | no    |

`pnpm corpora` is the step people miss in `conformance/`: the upstream
corpora are gitignored and pinned in `corpora.json`, and every runner that
compares against a committed baseline refuses to report numbers from a
checkout that has drifted off its pin.

For schema or validator changes that could affect HTTP behavior:

```bash
pnpm build               # the OpenAPI runner drives the built CLI
cd conformance
pnpm install             # first time only
pnpm openapi
```

The full set, once bootstrapped:

```bash
cd conformance
pnpm typecheck
pnpm openapi                    # OpenAPI request/response cases via the CLI
pnpm suite                      # JSON Schema Test Suite (required)
pnpm format-suite               # optional/format under an asserting dialect
pnpm parse                      # JSON parser corpus vs the stream tokenizer
pnpm overlay                    # OpenAPI Overlay 1.0
pnpm corpora:stale              # are the pinned corpora behind upstream?
```

Every runner above takes `--check-baseline`, which is the form CI uses: it
compares against the committed results file and fails on a regression
instead of on any single mismatch.

`pnpm corpora:stale` reports which pinned corpora are behind upstream and
exits 0 either way, because being behind is a maintenance signal rather
than a test failure and is expected much of the time. CI runs it with
`--fail-if-stale`, where the exit code is the only thing visible.

## Release process

Releases are automated. You don't bump versions or tag manually.

1. Land PRs to `main` as normal.
2. Every push to `main` triggers release-please, which maintains a
   single open "chore: release" PR that accumulates the next version's
   changelog entries and version bump.
3. When you're ready to release, merge that PR. Release-please tags
   the commit, creates a GitHub Release, and the publish workflow
   pushes the package to npm.

# Real-world OpenAPI specs

Two smoke-test harnesses over a set of public real-world OpenAPI 3.x
specs. Neither is wired into CI, because the specs are gitignored; run
them on demand before shipping changes to the resolver or validator.

The specs live under `./specs/` — fetch with `./download.sh` (or the
curl commands below).

## `check.mjs`: load, resolve, validate

Runs each spec through `@oaverify/internal-spec`'s `loadSpec` and
`@oaverify/internal-validator`'s `createValidator`, then samples a
handful of operations per spec with `validateRequest` to exercise the
lazy per-operation cache.

```bash
pnpm build                                    # dist/ must exist
node conformance/real-world/check.mjs         # or: node --max-old-space-size=8192 …
```

## `provenance-check.mjs`: the addresses are real

Checks that every source address the resolver hands out (#596) names a
node that exists: it re-reads the document the address points at, walks
the pointer, and requires it to land somewhere. Audits every node of
each resolved document as well as every finding, so a spec with no
defects still exercises the whole pointer space.

Each spec runs twice: as published, and mechanically split into one
file per component schema and per path item, which is what forces
hoisting, cross-file recursion, shared schemas and cycles.

```bash
pnpm build
node conformance/real-world/provenance-check.mjs            # default three
node conformance/real-world/provenance-check.mjs --all
node conformance/real-world/provenance-check.mjs box.json
```

The largest specs need a raised heap for the harness itself
(`--max-old-space-size=14336` covers `github.json`). `check` on
`stripe.json` and `github.json` peaks near 10GB whether or not
provenance is on, so the harness raises the heap of the CLI it spawns.

## Current spec set

| File                | Source                                 | Notes          |
| ------------------- | -------------------------------------- | -------------- |
| adyen-checkout.json | apis.guru (Adyen Checkout Service v70) | 3.1, 23 paths  |
| asana.yaml          | github.com/Asana/openapi               | 3.0, 171 paths |
| box.json            | github.com/box/box-openapi             | 3.0, 186 paths |
| digitalocean.yaml   | apis.guru (digitalocean.com v2.0)      | 3.0, 183 paths |
| github.json         | github.com/github/rest-api-description | 3.0, 744 paths |
| stripe.json         | github.com/stripe/openapi (spec3.json) | 3.0, 414 paths |
| twilio.json         | github.com/twilio/twilio-oai           | 3.0, 121 paths |

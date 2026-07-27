# Real-world OpenAPI specs

Smoke-test harness that runs a set of public real-world OpenAPI 3.x
specs through `@oaverify/internal-spec`'s `loadSpec` and `@oaverify/internal-validator`'s
`createValidator`, then samples a handful of operations per spec with
`validateRequest` to exercise the lazy per-operation cache.

The specs themselves live under `./specs/` and are gitignored — fetch
with `./download.sh` (or the curl commands below). This harness is not
wired into CI; run it on demand before shipping changes that touch the
resolver or validator.

## Run

```bash
pnpm build                                    # dist/ must exist
node conformance/real-world/check.mjs         # or: node --max-old-space-size=8192 …
```

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

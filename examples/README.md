# Examples

Self-contained TypeScript examples that exercise the most common
`oav` entry points. Each file loads a spec from [`specs/`](./specs)
and prints what it did to stdout, the same pattern a real application
uses.

## Running

From the repo root, after `pnpm install`:

```bash
pnpm dlx tsx examples/<example>.ts
```

The examples import from `packages/*/src` directly so they work without
`pnpm build`. Third-party consumers would write
`import { ... } from "@aahoughton/oav-core"` instead; the logic
translates 1:1. `resolveSpec`, `loadSpec`, and the readers live at
`@aahoughton/oav-core/spec`, and the YAML readers
(`createYamlFileReader`, `createSmartHttpReader`) come from
`@aahoughton/oav-yaml`, since `oav-core` is JSON-only.

The streaming examples import from `packages/stream-validator/src`, which
translates to `@aahoughton/oav-stream-validator`. That is a separate
package (not part of the `oav` / `oav-core` re-export), versioned
independently on its own version line:

```bash
npm install @aahoughton/oav-stream-validator
```

## What's in here

| File                           | Spec                  | Shows                                                                               |
| ------------------------------ | --------------------- | ----------------------------------------------------------------------------------- |
| `basic-validation.ts`          | `petstore.yaml`       | Load a spec → `createValidator` → request + response checks                         |
| `custom-formats.ts`            | `contacts.yaml`       | Register a user format (E.164 phone) via the `formats` option                       |
| `custom-keywords.ts`           | `widgets.yaml`        | Register a schema keyword (`activeTenant`) via the `keywords` option                |
| `cross-field-validation.ts`    | `ranges.yaml`         | Cross-field constraint (`max >= min`) via an object-level custom keyword            |
| `max-errors.ts`                | `items.yaml`          | Fast-fail and bounded error collection on a bulk-invalid payload                    |
| `versions.ts`                  | `pets-3.{0,1,2}.yaml` | 3.0, 3.1, and 3.2 side by side: `nullable`, QUERY method, etc.                      |
| `overlay.ts`                   | `petstore.yaml`       | Minimal overlay: merge a gateway header requirement into one op                     |
| `overlay-petstore-schema.ts`   | `petstore.yaml`       | Extend the `Pet` component with a deployment-required field                         |
| `overlay-petstore-endpoint.ts` | `petstore.yaml`       | Require an `X-Tenant` header on `POST /pets` via an endpoint overlay                |
| `spec-digest.ts`               | `uploads.yaml`        | Derive middleware config (multer limits, required headers) from the spec at startup |

See [`docs/overlays.md`](../docs/overlays.md) for a walk-through of the overlay
shape and when to use each section (`extendSchemas`, `replaceSchemas`,
`overrides`, `addPaths`).

### Streaming

The streaming validator (`@aahoughton/oav-stream-validator`) is a second
engine: it validates a JSON body as the bytes flow through,
echoing them out unchanged, without buffering the whole document. The
runtime examples break the load-a-spec / print-a-verdict mold: they pipe
a lazily generated body through `createStreamValidator` and read the
side channel, so each fabricates its body inline rather than loading a
fixture. `stream-budget.ts` is the design-time exception: it analyzes a
spec (`ingest.yaml`) and prints the buffer budget without streaming any
bytes at all.

| File                       | Shows                                                                             |
| -------------------------- | --------------------------------------------------------------------------------- |
| `stream-basic.ts`          | `pipeline` echo-through; the `violation` channel and `result` verdict             |
| `stream-from-spec.ts`      | Bridge a resolved spec to a body validator with `streamValidatorForOperation`     |
| `stream-limits.ts`         | Bound untrusted input: `enforceBounds`, `maxTotalBytes`, eager `maxItems`         |
| `stream-recover-fields.ts` | Recover top-level scalars with `valueEvents` while a large body streams           |
| `stream-budget.ts`         | Pre-deploy buffer budget with `analyzeSpec`: peak bytes, the unbounded punch list |

## Conventions

- Specs live in [`specs/`](./specs) as YAML files, loaded via
  `loadSpec` + `createYamlFileReader`. The same pattern works for a
  real application's spec; swap the entry path.
- Success paths print `ok`; failure paths print the formatted error
  tree so you can see what the validator surfaces.

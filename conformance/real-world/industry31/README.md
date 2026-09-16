# Selected industry OpenAPI 3.1 corpus

Eight API roots from five standards bodies, selected on 2026-09-15. The aim is
new authoring patterns and independent producers, so no vendor APIs are
included. This is a research corpus, outside CI, with a recorded snapshot
rather than a pass-count gate.

The local starting population contained 37 byte-distinct 3.1 documents among
305 byte-distinct documents from the existing detection and conformance
real-world directories. Twenty-five of the 37 were Adyen documents and seven
were Codat documents. That concentration motivated looking beyond API catalogs.
These counts describe the inspected local population, not the current contents
of upstream catalogs.

## Selection

All selected entry documents declare `openapi: 3.1.0`. Industry API versions
are shown separately. Each linked source is pinned to the inspected commit.

| Entry                                                                                                                                                                                                        | Industry version     | Paths / webhooks | Documents read | Why keep it                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | ---------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [UIC OSDM webhooks](https://github.com/UnionInternationalCheminsdeFer/OSDM/blob/9e03234e7d8855ff1d146f7725cd30b84c6a8abe/specification/OSDM-online-webhook.yml)                                              | 3.8.0                | 1 / 1            | 1              | Rail booking events: webhook-only payloads, discriminator mappings and inherited schemas. The main OSDM API is still OAS 3.0; only the webhook entry is selected.                                              |
| [OMF MDS Agency](https://github.com/openmobilityfoundation/mds-openapi/blob/0c07bc3d294237dd41c6273f059efb11b8149c66/reference/agency.yaml)                                                                  | 2.0                  | 10 / 0           | 51             | Mode-specific `const` tags, conditionals and enum constraints spread over external schemas. Contains malformed authored assertions, so it exercises located rejection too.                                     |
| [OMF MDS Policy](https://github.com/openmobilityfoundation/mds-openapi/blob/0c07bc3d294237dd41c6273f059efb11b8149c66/reference/policy.yaml)                                                                  | 2.0                  | 5 / 0            | 27             | A second OMF entry earns its place through externally referenced local `$defs` and closed policy objects. It reaches a different path from the malformed Agency roots.                                         |
| [OGC Connected Systems, Part 2](https://github.com/opengeospatial/ogcapi-connected-systems/blob/3fd86c73e744b7e2faaf7f1c17366bfb9ff4cd6f/api/part2/openapi/openapi-connectedsystems-2.yaml)                  | 0.0.1, draft example | 23 / 0           | 175            | Multi-file Path Items, SensorML/SWE schemas, remote GeoJSON and mixed schema dialects. Part 2 already reaches Part 1 resources; another sibling entry would add much duplication.                              |
| [WBCSD PACT](https://github.com/wbcsd/data-exchange-protocol/blob/cf4ebedb18d42f3453bcc868e01159321297c09a/spec/v3/openapi.yaml)                                                                             | 3.0.3                | 3 / 0            | 1              | Carbon-footprint exchange and CloudEvents with `const` tags. The canonical current repository contains malformed event inheritance that the obsolete OpenAPI-only repository does not expose in the same form. |
| [IRI application status](https://github.com/Insured-Retirement-Institute/Digital-First-Specifications/blob/257e6dc98ecb65c10f87a89124cecc2642675591/docs/specs/appstatusv1.yaml)                             | 1.0.0                | 9 / 0            | 1              | A `cusip` pattern written `(9)` where `{9}` was meant, so nothing validates against a nine-character CUSIP, plus seven patterns that compile only outside unicode mode.                                        |
| [IRI status push notifications](https://github.com/Insured-Retirement-Institute/Digital-First-Specifications/blob/257e6dc98ecb65c10f87a89124cecc2642675591/docs/specs/appstatuspushNotifications_1.1.1.yaml) | 1.1.1                | 2 / 12           | 1              | Twelve webhooks whose composed `status` enums spell the same state two ways, leaving one legal value. The second webhook-carrying entry, after UIC.                                                            |
| [IRI one-time withdrawal](https://github.com/Insured-Retirement-Institute/Digital-First-Specifications/blob/257e6dc98ecb65c10f87a89124cecc2642675591/docs/specs/onetimewithdrawal_1.0.1.yaml)                | 1.0.1                | 3 / 0            | 1              | A YAML indentation slip that parses `if` as null inside an `allOf` branch.                                                                                                                                     |

The resource closure contains **244 distinct URLs, 589,483 bytes**, including
four GeoJSON resources. Shared files are counted once in the closure; the
per-entry counts above overlap. These are eight corpus members, not 244 APIs.
The roots are pinned default-branch artifacts, not a claim that each is a
ratified or latest release. OGC explicitly describes its entry as an example
for a draft standard.

## Reproduce

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node conformance/real-world/industry31/fetch.mjs
node conformance/real-world/industry31/check.mjs
node conformance/real-world/industry31/triage.mjs
```

`manifest.json` pins repository revisions and SHA-256 hashes for every resource
read during resolution. `fetch.mjs` downloads original bytes into the ignored
`conformance/real-world/specs/industry31/blobs/` directory and verifies both
fresh and cached bytes. A changed upstream response fails rather than silently
refreshing the corpus. The four GeoJSON URLs lack immutable revision URLs;
their byte hashes still pin what this run used, though future availability is
not guaranteed.

`check.mjs` runs entirely offline. Its reader maps original resource URIs to
verified bytes and refuses unpinned reads. This preserves reference bases,
resource identifiers and source provenance without bundling or rewriting the
upstream documents. Full findings go to the ignored
`conformance/real-world/specs/industry31/results/` directory; stdout contains a
compact summary. Findings, including fatal schema findings, are observations
and do not fail this research runner. Read, hash, resolution and checker throws
do fail it. The runner does not inherit the CLI's severity-based exit codes.

`snapshot.json` records the result against `b086f492`, after the composed
finite-value diagnostic and hoisted-definition reachability fixes. It is an
observation, not a conformance baseline. Compared with the first snapshot of
the five non-IRI entries, taken on `df1b824c`, 30 `unreachable-defs` findings
disappeared: eight from MDS Policy and 22 from OGC. All other findings were
unchanged; none were added.

`check.mjs --diff-snapshot` reports the delta against that record and still
exits 0. Because the upstream bytes are pinned, a delta is attributable to a
checker change rather than to upstream editing a document. It is not a gate:
findings move whenever the checker improves, and a runner that goes red on an
improvement stops being read. Update `snapshot.json` and its `measuredAgainst`
revision deliberately, in the commit whose delta explains it. The existing flat-directory real-world runners do not discover these
nested inputs; use this dedicated runner to preserve their resource closures.

`triage.mjs` asserts the source shapes behind the findings below against the
pinned bytes, which is all it can do from outside the unit suite. The minimal
schemas that reproduce each rejection are pinned in
`packages/schema/test/well-formed.test.ts`, and the reachability case in
`packages/check/test/external-defs.test.ts`, so they run in CI without the
corpus. Run the hash-verifying fetch first.

## Findings worth carrying forward

### Confirmed malformed upstream schemas

**MDS Agency:** `models/modes/car-share/event.yaml` places an array under
`if.properties.event_types.contains`. `contains` requires a Schema Object or
boolean, so the published shape cannot compile. The checker reports the
original external-file pointer. A minimal `{type: "array", contains:
["trip_start"]}` reproduces the rejection, pinned in the unit suite. The snapshot has four
`malformed-schema` findings; these are reported findings with occurrence
aggregation, not four independently classified defects.

**PACT:** the event schemas put `$ref` directly inside the `properties` map,
with the string `#/components/schemas/BaseEvent/properties` as its value.
That makes `$ref` a property name whose schema is a string, which is invalid.
It does not import the base property map. `triage.mjs` checks the exact
`RequestCreatedEvent.properties.$ref` value; a minimal
`{type: "object", properties: {$ref: "..."}}` reproduces the rejection, pinned
in the unit suite.
The snapshot has four malformed event-schema findings. This is why the selected
source is `wbcsd/data-exchange-protocol`, not its obsolete `pact-openapi` sibling.

**IRI one-time withdrawal:** the third `allOf` branch of `TransactionAmounts`
indents `properties` level with `if` rather than under it, so `if` parses as
null and its intended condition becomes a sibling keyword. `triage.mjs` asserts
both the null and the displaced sibling, since the shape only exists in YAML.

Two of the authored cases in `detection/cases/malformed/` turn out to model
real mistakes: `if-null.yaml` is this defect, and `type-boolean.yaml` is the
`type: Boolean` in IRI policy inquiry, a document left out below. The labelled
corpus was written from what looked plausible, and published documents agree.

### Confirmed unsatisfiable upstream schemas

**IRI application status:** the shared `cusip` parameter declares
`minLength: 9`, `maxLength: 9` and `pattern: (^[a-zA-Z0-9](9)$)`. The `(9)` is
a group matching the literal digit where `{9}` was meant, so the pattern accepts
only two-character strings and no value satisfies both. It appears three times,
once on the parameter and twice on response schemas, and a real nine-character
CUSIP is rejected. The probe compiles the parameter schema and checks that
`037833100` fails.

**IRI status push notifications:** `FundingReceivedNotification` composes
`TransferNotificationBase`, whose `status` enum is
`[awaitingReview, inProgress, completed]`, with its own `status` enum
`[inProgress, complete]`. Under `allOf` the intersection is `[inProgress]`
alone: `complete` and `completed` are two spellings of one state, and the
composition silently drops every value but one. The checker reports this
through the composed finite-value diagnostic that shipped in #1080, which
makes these two findings the first real-world instances of that rule.

### Repaired checker false positive

**MDS Policy:** the original snapshot reported eight `unreachable-defs`
findings. For example, `models/requirements.yaml` explicitly references
`#/$defs/metadata` and `#/$defs/program` from its root properties. Resolution
hoisted the referenced target and rewrote the reference to the hoisted
component. Hygiene then saw the retained original definition without a
reference and reported it as unused.

The repair merged in [#1082](https://github.com/oaverify/oaverify/pull/1082).
The refreshed MDS Policy snapshot has no findings. #1082 carries the
regression test, covering the inline and external forms across the sync,
async and provenance combinations, so this corpus keeps no probe of its own
and contains no checker implementation. The repair also fixed the pre-existing attribution defect recorded in
[#1081](https://github.com/oaverify/oaverify/issues/1081). No upstream defect
report was filed as part of this corpus pass.

### Other inspected signals

**UIC:** `AbstractEvent.required` includes `revision`, but its properties do
not declare it. `triage.mjs` confirms that omission fails while `revision: {}`
validates. This is legal JSON Schema with an unconstrained required field,
not an unsatisfiable schema. The other undeclared event identifiers are similar
warning leads. The snapshot contains nine such findings and one format warning.

**OGC:** `/systems/{systemId}/history` has no declaration for its `systemId`
path parameter in the referenced Path Item. That source omission is visible in
`api/part2/openapi/paths/systemHistory.yaml`. Separately, 84
`unsupported-schema-dialect` findings reflect draft-07 and other foreign schema
resources; they are checker support limits, not upstream schema defects.
The refreshed snapshot has 251 total findings, including one remaining
`unreachable-defs` report, metaschema reports and example reports that were
not individually triaged. A large count is not a count of confirmed bugs.

**IRI application status, again:** seven `pattern` values compile only without
the `u` flag, so the validator falls back to non-unicode mode. That is a
silent-rewrite report rather than a defect: the patterns work, and the finding
records that they are read differently from the source as written.

PACT's `note` and `comment` keywords and OGC's draft dialects also make useful
controls against treating every diagnostic as a source defect. Unknown schema
annotations can be intentional. No precision or prevalence claim follows from
this selected sample.

## Candidates deliberately left out

| Candidate inspected                                  | Decision                                                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenADR public specification copy, commit `e47c6da5` | OpenADR 3.1 is the industry version. Inspected YAML declares OAS 3.0.0. The copy also distinguishes reformatted and original bytes; neither belongs in the 3.1 sample.                 |
| DCSA OpenAPI, commit `d03a1c79`                      | Service APIs inspected declare OAS 3.0.3. The lone `models/CommonComponents.yaml` OAS 3.1 document is a small shared-header/parameter catalog, with little additional schema coverage. |
| OpenBankingUK read-write specs, commit `8e68cb50`    | Inspected specifications do not declare OAS 3.1; Open Banking's 3.1 release number is a different version axis.                                                                        |
| openEHR ITS REST, commit `24058992`                  | Inspected generated and authored OAS documents declare 3.0.3.                                                                                                                          |
| GA4GH Beacon v2, commit `c6558bf2`                   | Inspected endpoint documents declare 3.0.2.                                                                                                                                            |
| OGC Records                                          | Inspected OpenAPI example declares 3.0.2. Connected Systems provides a stronger 3.1 candidate.                                                                                         |
| OMF's other MDS roots                                | Agency and Policy capture distinct features. Adding every sibling would overweight one producer again.                                                                                 |
| Old WBCSD `pact-openapi` repository                  | Its README points to the canonical data-exchange repository. Avoid counting old and current copies as independent evidence.                                                            |
| GBFS, Eclipse Dataspace Protocol, Perseus demo       | No suitable checked-in OAS 3.1 root identified in this pass. JSON Schema alone or a running demo is not a substitute for an authored API document.                                     |
| Third-party API catalog rewrites                     | Search results often led to copies without clear equivalence to the publisher's artifact. Selected roots come from the responsible organizations.                                      |
| IRI policy inquiry, 182KB                            | Its `type: Boolean` is a malformed-schema class already covered by the one-time withdrawal entry, and it would add 42% to the closure for one further defect.                          |
| IRI per-working-group draft repositories             | The `draft-api-specs` documents in each working group's own repository restate what `Digital-First-Specifications` publishes. Counting both would double one producer.                 |
| IRI hackathon and team repositories                  | Event demos rather than the organization's standards, so they carry no authority about how the industry writes documents.                                                              |

This was a bounded search, not an exhaustive standards inventory. Search hits
were discovery leads; actual version declarations and source contents decided
inclusion. Healthcare, energy and financial standards remain useful areas for
a later pass when suitable publisher-authored OAS 3.1 documents become available.

## Source ownership

The upstream files remain excluded from git. The manifest records where to
obtain them, and downloading retains each publisher's terms:

- [UIC OSDM license](https://github.com/UnionInternationalCheminsdeFer/OSDM/blob/9e03234e7d8855ff1d146f7725cd30b84c6a8abe/LICENSE).
- [Open Mobility Foundation license](https://github.com/openmobilityfoundation/mds-openapi/blob/0c07bc3d294237dd41c6273f059efb11b8149c66/LICENSE).
- [OGC license](https://github.com/opengeospatial/ogcapi-connected-systems/blob/3fd86c73e744b7e2faaf7f1c17366bfb9ff4cd6f/LICENSE).
- [WBCSD license](https://github.com/wbcsd/data-exchange-protocol/blob/cf4ebedb18d42f3453bcc868e01159321297c09a/LICENSE.md).
- [IRI license](https://github.com/Insured-Retirement-Institute/Digital-First-Specifications/blob/257e6dc98ecb65c10f87a89124cecc2642675591/LICENSE) (MIT).

# Triage: leads not filed

Everything here was looked at and not turned into an issue. Each entry
says what was seen and why it stopped there. Nothing in this file is a
claim that oaverify is wrong.

Corpus: 313 specs, base commit `76c42f9`. Generated leads are in
`leads.md` and `crashes.md`; this file is hand-written.

## Comparator findings that are the comparator's bug

**Redocly `no-unresolved-refs` on DigitalOcean (10 findings).** The refs
are JSON pointers into `paths` with percent-encoded braces, e.g.
`#/paths/~1v2~1domains~1%7Bdomain_name%7D~1records/get/...`. Redocly
reports `Can't resolve $ref: ENOENT`, treating them as file paths.
oaverify resolves them and enforces the target; checked against a
hand-written 20-line spec with a percent-encoded pointer, where
`validate` correctly rejects a body violating the referenced schema.

**Redocly `no-required-schema-properties-undefined` on
`guru-ix-api.net-3.0.0.yaml` (5 findings).** `VLanConfigDot1Q` is
`allOf: [$ref PartialVLanConfigDot1Q, {required: [vlan, vlan_type]}]`
and `vlan` is declared in the ref target. Redocly does not follow the
ref across the `allOf`; oaverify's #503 model does, and stays correctly
silent. Redocly raises the same shape on 8 of the audited specs.

**Ajv "can't resolve reference #/components/schemas/X" (many thousands).**
An artifact of `../ajv-probe.mjs`, which compiles each schema standalone
with the document registered under a separate `$id`, so in-document
pointers do not resolve from the compiled schema's base. A limit of the
sibling corpus's probe, carrying no signal about oaverify. It dominates
the raw differential counts and should be ignored when reading
`leads.md`.

## Real differences that look like deliberate scope boundaries

**Redocly `no-ambiguous-paths` (235 findings, ~30 specs).** Redocly
flags any pair where some request could match both, including
literal-versus-parameter overlap: `/company/announcement/{id}` against
`/company/{id}/announcements`. oaverify's router rejects only the
narrower case where parameter names differ in the same structural
position, so every request matches both. I built the Redocly shape by
hand and confirmed oaverify resolves it deterministically, picking the
same operation with either declaration order. Not chased further:
whether the tie-break matches what Express or Fastify would do is a
separate question I did not test, and it is the question that would
decide whether anything is wrong here.

**Redocly `no-schema-type-mismatch` (55 findings, 8+ specs).** Mostly
`'object' type should not contain 'items'`. The `items` is inert rather
than unsatisfiable, so this is weaker than the `malformed` class in
`../cases.ts`, which is about constraints being lost. Nothing is lost
here; there was no array constraint to keep. Left alone.

**Redocly `nullable-type-sibling` (571) and Ajv `"nullable" cannot be
used without "type"` (50).** Checked directly: for
`value: {nullable: true}` with no `type`, oaverify accepts a string, a
number, and null, which is correct (OAS 3.0 `nullable` only widens a
declared type). An argument exists that the author expected "null or
nothing else" and should be told the keyword did nothing, which would be
a new lint rather than a defect. Not filed; #514 covers the one
new-rule case I thought was worth the cost.

**Spectral `array-items` (8).** `type: array` without `items`. Legal
JSON Schema, no constraint lost. OAS 3.0 requires `items` structurally,
which is #491's territory.

## oaverify behaviour that is defensible but was slow to read

**Repeated findings for one shared component.** `guru-airbyte.local_config-3.0.0.yaml`
reports the same `required: "json_schema"` finding 9 times, once per
operation whose body reaches `AirbyteStream`. `collectRequiredIssues`
dedupes per schema object, but each operation compiles separately so the
map is fresh each time. 328 `required-not-in-properties` findings across
the corpus collapse to far fewer distinct defects. Annoying to read,
not wrong, and plausibly a deliberate consequence of per-operation
compilation. Would be a `polish` if anything.

**`path-param-undeclared` on paths containing a query string.**
`guru-clicksend.com-3.0.0.yaml` has the path key
`/uploads?convert={convert}`, and oaverify reports that `{convert}` has
no declared path parameter. True as stated, and the actual defect is
that a path key must not contain a query string, which oaverify has no
rule for (Spectral and Redocly both ship `path-not-include-query`). The
finding points at a symptom. Not filed because the message is not wrong
and the missing rule is document-structure validation, i.e. #491.

**Missing operation context on schema findings.** Tracing a finding at
`anyOf[6]` back to a source operation took a script, and I initially
misread a DigitalOcean finding as a false positive because two different
operations both have an `anyOf` with 7+ branches and the location
distinguishes neither. It turned out correct: `anyOf[6]` and `anyOf[4]`
in `POST /v2/droplets/{droplet_id}/actions` differ only in `description`
and `example`, which are annotations. This is #493, already filed as
`polish`. Worth noting that it cost real time on a real spec, which is
an argument for raising its priority.

## Checked and clean

Rules I sampled for false positives against the source specs, and found
correct every time:

- `silent-rewrite/required-not-in-properties` (328 findings, 36 specs).
  Read the source schema for asana (`SectionRequest` requires `project`,
  declares `insert_after` / `insert_before` / `name`), Atlassian Jira
  (`required: [defaultScreen]`, property is `default`,
  `additionalProperties: false`), Airbyte (`required: [json_schema]`,
  property is `jsonSchema`), and biapi.pro (`required` on a schema whose
  intended properties are mis-indented as siblings of `schema`). All
  true positives. The rule that most needed watching came out clean.
- `silent-rewrite/redundant-composition-branches` (25). Verified both
  DigitalOcean sites by diffing the branch bodies.
- `unknown-keyword` (85). All 65 `nullable` findings are on 3.1
  documents, where `nullable` is genuinely not a keyword. `definitions`
  (14) is the draft-07 spelling of `$defs`. The rest are typos
  (`descrciption`, `regex`, `name`).
- Exit-2 rejections. 7 of 8 name the position; the eighth is #504.

No false positive was found anywhere in the corpus.

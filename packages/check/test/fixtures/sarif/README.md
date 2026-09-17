# SARIF schema fixture

`sarif-schema-2.1.0.json` is an unmodified copy of the OASIS SARIF 2.1.0
Errata 01 schema, retrieved September 16, 2026 from:

<https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json>

SHA-256: `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e`.

The schema uses JSON Schema draft-04. `sarif.test.ts` validates emitted
reports with `ajv-draft-04` and `ajv-formats`, using only this local file.
Schema validation checks document structure; requirements expressed only
in the SARIF specification still need separate tests. The same validator
checks the stored CLI SARIF reports, and a test checks the fixture bytes
against the checksum above.

`ajv` is declared directly because `ajv-draft-04` requires it as a peer
and the workspace disables automatic peer installation.

This test fixture intentionally stays outside the scheduled pins job: it
records the schema chosen for the emitter's declared SARIF version, and
updates require an explicit review of that contract. Its test-only role
makes manual refresh sufficient for now. The checksum test detects local
edits; it does not detect changes at the upstream URL or assume that an
OASIS OS URL can never change.

To refresh, fetch the versioned source above, review the diff, update the
checksum here, and run `pnpm vitest run packages/check/test/sarif.test.ts`.
Keep upstream bytes intact so the checksum can be compared directly.

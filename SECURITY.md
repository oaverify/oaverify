# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security-relevant bugs.

Use GitHub's private vulnerability reporting:
<https://github.com/oaverify/oaverify/security/advisories/new>

If that isn't available to you, email <aah@roarmouse.org> with
"oaverify security" in the subject line.

Please include:

- A description of the issue and its impact.
- Steps to reproduce, or a minimal proof of concept.
- The affected package name and version(s).
- Any mitigations or workarounds you're aware of.

You should receive an acknowledgement within a few business days.
Fixes will be released as patch versions; the advisory will be
published via GitHub Security Advisories once a fix is available.

## Supported versions

Security fixes are issued for the latest minor release of the current
major version line. Older minor versions do not receive backports.

## Scope of published packages

The published packages (`oaverify`, `@oaverify/core`,
`@oaverify/express4`, `@oaverify/express5`,
`@oaverify/fastify`) declare framework runtimes (`express`,
`fastify`) as peer dependencies. Nothing from those frameworks ships
inside any of the tarballs, and `@oaverify/core` has no runtime
dependencies at all.

Three sub-roots in this repo own their own lockfiles for test and
benchmark dependencies, isolated from the main workspace:

- `framework-tests/`: real-server integration tests for the
  `@oaverify/express4`, `@oaverify/express5`, and `@oaverify/fastify` adapters.
- `performance/`: benchmarks against other JSON Schema / OpenAPI
  validators.
- `conformance/`: upstream JSON Schema and OpenAPI Overlay test-suite
  harnesses.

Dependabot scans each of those lockfiles. CVEs reported against a
package that only appears under one of those directories affect that
sub-root's test or benchmark harness; they do not reach the runtime
tree that consumers of the npm packages receive. A downstream consumer
who sees such a CVE on the security tab is not affected: the package is
not present in any published tarball, so transitive resolution does not
pick it up.

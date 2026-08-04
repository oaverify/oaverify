# @oaverify/check

The composed OpenAPI document check behind `oaverify check`, as a
library.

`oaverify check` runs several passes over a resolved spec, normalises
what they find into one finding list, and grades each finding by
consequence. This package is that logic. The CLI is a renderer over it:
anything `oaverify check` prints, a caller here can compute.

Reach for it when you want spec checks inside something that is already
a program — a build script, a test, a CI step that wants findings rather
than an exit code, a service that lints uploaded specs.

```bash
npm install @oaverify/check @oaverify/core
```

`@oaverify/core` is a peer of the workflow rather than an implementation
detail: you load a spec with it, then check what it gives you.

## Status

The finding contract (`CheckFinding`, `CheckClass`, `CheckSeverity`,
`FindingTarget`) ships here now. The passes, the composition and the
grading are being moved across (#572); until that lands, `oaverify
check` remains the only way to run them.

## Node only

This package reads and formats file addresses, so it uses `node:path`
and `node:url` and does not run in a browser. `@oaverify/core` itself
has no such constraint.

## Why a package rather than a `@oaverify/core` subpath

Two reasons, and the second is the binding one.

The existing `@oaverify/core` subpaths (`/schema`, `/spec`, `/formats`,
`/core`, `/overlay-spec`) are all parts of core, so a `/check` subpath
would read as one and is not.

More concretely, one of the passes uses `redos-detector`, which is about
1MB unpacked. npm installs a dependency whichever entry imports it, so a
`@oaverify/core/check` subpath would land that on every `@oaverify/core`
consumer and break core's zero-runtime-dependency claim. The weight goes
here instead.

## License

MIT

# Changelog

## [5.4.0](https://github.com/oaverify/oaverify/compare/check-v5.3.0...check-v5.4.0) (2026-08-04)

First release. `@oaverify/check` is the document check that `oaverify check` runs, published so you can call it from your own tooling.

`checkSpec(resolved, options)` returns the findings from the six passes. `severityFor`, `defaultSeverityFor` and `parseSeverityMap` grade them, `renderSarif` emits SARIF 2.1.0, and the class and code registries plus the finding types are exported alongside. Findings from your own rules can be concatenated with oaverify's and graded and rendered through the same functions.

It takes a `ResolvedSpec` rather than an `OpenAPIDocument`: provenance regions and inlined components are byproducts of resolution, and without them a finding loses its source address and SARIF loses its locations.

The version starts at 5.4.0 because the package is part of the linked release group, not because there were five earlier ones.


### Features

* **check:** move the composed spec check into @oaverify/check ([#654](https://github.com/oaverify/oaverify/issues/654)) ([2b376e2](https://github.com/oaverify/oaverify/commit/2b376e253f59dcf97b6b8a71cdc670e6fbb8260d))

# Migrating to v7

## Breaking: `@oaverify/yaml` is now `@oaverify/syntax`

The package that carries the parsers is named for what it does rather
than for the first syntax it carried. Nothing it exports changed, so the
migration is the specifier and nothing else:

```bash
npm uninstall @oaverify/yaml
npm install @oaverify/syntax
```

```diff
-import { createYamlFileReader, loadSpecSync } from "@oaverify/yaml";
+import { createYamlFileReader, loadSpecSync } from "@oaverify/syntax";
```

`createYamlFileReader`, `createYamlStdinReader`, `createSmartHttpReader`,
`parseYamlString`, `loadSpecSync`, `FileReaderOptions` and
`HttpReaderOptions` all keep their names and their behaviour. The
YAML-specific ones stay YAML-specific; a reader for another syntax would
be a new export beside them.

There is no compatibility package. `@oaverify/yaml` stops at 6.x and is
deprecated on npm; installs of the old name keep working and stop
receiving updates.

`@oaverify/core` is unaffected and still parses JSON only. The source
address and span contracts (`SourceAddress`, `SourceSpan`, `SourceText`,
`SourceSyntax`, `createSourceSpanResolver`) live there, and
`@oaverify/syntax` implements them for a given syntax. That split is why
the package is not called `@oaverify/source`.

## Checklist

- [ ] Replace `@oaverify/yaml` with `@oaverify/syntax` in every manifest.
- [ ] Replace it in every import specifier. No imported name changes.
- [ ] If you pin the CLI, `oaverify` depends on the new name for you.

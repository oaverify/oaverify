Run 2026-08-07 against:

- oaverify 5.4.0
- ajv 8.20.0
- spectral 6.16.2
- redocly 2.43.2

| case | class | oaverify | ajv | spectral | redocly |
| --- | --- | --- | --- | --- | --- |
| `malformed/items-array` | malformed | yes | yes | yes | yes |
| `malformed/type-boolean` | malformed | yes | - | yes | yes |
| `malformed/if-null` | malformed | yes | - | - | - |
| `malformed/enum-scalar` | malformed | yes | yes | yes | yes |
| `malformed/required-string` | malformed | yes | yes | yes | yes |
| `malformed/properties-array` | malformed | yes | yes | yes | yes |
| `lint/required-typo` | lint | yes | yes | - | - |
| `lint/required-typo-behind-ref` | lint | yes | yes | - | yes |
| `lint/enum-type-mismatch` | lint | yes | - | yes | yes |
| `lint/ref-siblings-oas30` | lint | yes | - | yes | - |
| `lint/redundant-oneof` | lint | yes | - | - | - |
| `lint/unknown-keyword` | lint | yes | yes | - | yes |
| `lint/annotation-null-description` | lint | yes | yes | - | yes |
| `lint/prefixitems-in-30` | lint | yes | yes | yes | yes |
| `lint/catastrophic-pattern` | lint | yes | - | - | - |
| `style/missing-operationid` | style | - | - | yes | yes |
| `style/duplicate-operationid` | style | - | - | yes | yes |
| `style/unused-component` | style | yes | - | yes | yes |
| `style/undeclared-path-param` | style | yes | - | yes | yes |
| `style/undefined-security-scheme` | style | - | - | yes | yes |
| `style/example-contradicts-schema` | style | yes | - | yes | yes |
| `structural/missing-info-version` | structural | yes | - | yes | yes |
| `structural/response-missing-description` | structural | yes | - | yes | yes |
| `structural/parameter-schema-and-content` | structural | yes | - | yes | - |
| `structural/license-identifier-and-url` | structural | yes | - | yes | - |
| `structural/path-param-not-required` | structural | yes | - | yes | - |
| `structural/dangling-discriminator-mapping` | structural | yes | yes | - | yes |
| `structural/undeclared-server-variable` | structural | - | - | yes | yes |
| `structural/dangling-ref` | structural | yes | yes | yes | yes |
| `control/clean` | control | - | - | - | - |
| `control/required-on-sibling` | control | - | - | - | - |
| `control/required-via-composition` | control | - | - | - | - |
| `control/additional-properties-open` | control | - | - | - | - |

| class | oaverify | ajv | spectral | redocly |
| --- | --- | --- | --- | --- |
| malformed (6) | 6/6 | 4/6 | 5/6 | 5/6 |
| lint (9) | 9/9 | 5/9 | 3/9 | 5/9 |
| structural (8) | 7/8 | 2/8 | 7/8 | 5/8 |
| style (6) | 3/6 | 0/6 | 6/6 | 6/6 |
| control false positives (4) | 0 | 0 | 0 | 0 |
| total findings raised | 25 | 19 | 183 | 195 |

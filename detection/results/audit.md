# Detection audit

## `malformed/items-array` (malformed)
- **oaverify**: malformed-schema: GET /things 200 response body (application/json): "items" at <root> must be an object or boolean; got an array. In JSON Schema 2020-12 the tuple form is "prefixItems"; an array-valued "items" is the draft-04 / Swagger 2.0 spelling. [GET /things 200 response]
- **ajv**: ajv/compile: strict mode: "items" is 1-tuple, but minItems or maxItems/additionalItems are not specified or different at path "#" [paths./things.get.responses.200.application/json]
- **spectral**: oas3-schema: "items" property must be a valid Schema Object. [paths//things/get/responses/200/content/application/json/schema/items]
- **redocly**: struct: Expected type `Schema` (object) but got `array` [#/paths/~1things/get/responses/200/content/application~1json/schema/items]

## `malformed/type-boolean` (malformed)
- **oaverify**: malformed-schema: GET /things 200 response body (application/json): keyword "type" at "properties.flag.type" has unknown type name "Boolean"; expected one of "null", "boolean", "object", "array", "string", "number", "integer". Did you mean "boolean"? [GET /things 200 response]
- ajv: no matching finding (1 raised)
- **spectral**: oas3-schema: "type" property must be equal to one of the allowed values: "array", "boolean", "integer", "null", "number", "object", "string". Did you mean "boolean"?. [paths//things/get/responses/200/content/application/json/schema/properties/flag/type]
- **redocly**: struct: `type` can be one of the following only: "object", "array", "string", "number", "integer", "boolean", "null". [#/paths/~1things/get/responses/200/content/application~1json/schema/properties/flag/type]

## `malformed/if-null` (malformed)
- **oaverify**: malformed-schema: GET /things 200 response body (application/json): "if" at <root> must be an object or boolean; got null. [GET /things 200 response]
- ajv: no matching finding (1 raised)
- spectral: no matching finding (1 raised)
- redocly: no matching finding (7 raised)

## `malformed/enum-scalar` (malformed)
- **oaverify**: malformed-schema: GET /things 200 response body (application/json): keyword "enum" at "properties.status.enum" requires an array of values; got number [GET /things 200 response]
- **ajv**: ajv/compile: schema is invalid: data/properties/status/enum must be array [paths./things.get.responses.200.application/json]
- **spectral**: oas3-schema: "enum" property must be array. [paths//things/get/responses/200/content/application/json/schema/properties/status/enum]
- **redocly**: struct: Expected type `array` but got `integer`. [#/paths/~1things/get/responses/200/content/application~1json/schema/properties/status/enum]

## `malformed/required-string` (malformed)
- **oaverify**: malformed-schema: GET /things 200 response body (application/json): keyword "required" requires an array of strings; got string "id" [GET /things 200 response]
- **ajv**: ajv/compile: schema is invalid: data/required must be array [paths./things.get.responses.200.application/json]
- **spectral**: oas3-schema: "required" property must be array. [paths//things/get/responses/200/content/application/json/schema/required]
- **redocly**: struct: Expected type `array` but got `string`. [#/paths/~1things/get/responses/200/content/application~1json/schema/required]

## `malformed/properties-array` (malformed)
- **oaverify**: malformed-schema: GET /things 200 response body (application/json): "properties" at <root> must be an object mapping names to schemas; got an array. [GET /things 200 response]
- **ajv**: ajv/compile: schema is invalid: data/properties must be object [paths./things.get.responses.200.application/json]
- **spectral**: oas3-schema: "properties" property must be object. [paths//things/get/responses/200/content/application/json/schema/properties]
- **redocly**: struct: Expected type `SchemaProperties` (object) but got `array` [#/paths/~1things/get/responses/200/content/application~1json/schema/properties]

## `lint/required-typo` (lint)
- **oaverify**: silent-rewrite/required-not-in-properties: required: "nam" at <root> is not declared in properties reachable here (likely a typo) [GET /things 200 response body (application/json) -> <root>]
- **ajv**: ajv/compile: strict mode: required property "nam" is not defined at "#" (strictRequired) [paths./things.get.responses.200.application/json]
- spectral: no matching finding (5 raised)
- redocly: no matching finding (6 raised)

## `lint/required-typo-behind-ref` (lint)
- **oaverify**: silent-rewrite/required-not-in-properties: required: "total" at "items" is not declared in properties reachable here (likely a typo) [GET /things 200 response body (application/json) -> items]
- **ajv**: ajv/compile: strict mode: required property "total" is not defined at "#" (strictRequired) [components.schemas.Item]
- spectral: no matching finding (5 raised)
- **redocly**: no-required-schema-properties-undefined: Required property 'total' is not defined. [#/components/schemas/Item/required/1]

## `lint/ref-siblings-oas30` (lint)
- **oaverify**: silent-rewrite/ref-siblings-oas30: OAS 3.0: "required" sibling of $ref at <root> is silently dropped (only description/summary survive) [GET /things 200 response body (application/json) -> <root>]
- ajv: no matching finding (1 raised)
- **spectral**: no-$ref-siblings: $ref must not be placed next to any other properties [paths//things/get/responses/200/content/application/json/schema/required]
- redocly: no matching finding (5 raised)

## `lint/redundant-oneof` (lint)
- **oaverify**: silent-rewrite/redundant-composition-branches: oneOf[1] is structurally identical to oneOf[0] (annotation-only differences ignored); branches collapse and the validator's match-count behavior diverges from the source spec [GET /things 200 response body (application/json) -> oneOf[1]]
- ajv: no matching finding (0 raised)
- spectral: no matching finding (5 raised)
- redocly: no matching finding (5 raised)

## `lint/unknown-keyword` (lint)
- **oaverify**: unknown-keyword: unknown keyword "minLenght" at "properties.name" [GET /things 200 response body (application/json) -> properties.name]
- **ajv**: ajv/compile: strict mode: unknown keyword: "minLenght" [paths./things.get.responses.200.application/json]
- spectral: no matching finding (5 raised)
- **redocly**: struct: Property `minLenght` is not expected here. [#/paths/~1things/get/responses/200/content/application~1json/schema/properties/name/minLenght]

## `lint/annotation-null-description` (lint)
- **oaverify**: annotation-value-type: "description" at "properties.statusDate" should be a string; got null [GET /things 200 response body (application/json) -> properties.statusDate]
- **ajv**: ajv/compile: schema is invalid: data/properties/statusDate/description must be string [paths./things.get.responses.200.application/json]
- spectral: no matching finding (1 raised)
- **redocly**: struct: Expected type `string` but got `null`. [#/paths/~1things/get/responses/200/content/application~1json/schema/properties/statusDate/description]

## `lint/prefixitems-in-30` (lint)
- **oaverify**: additionalProperties: additional property "prefixItems" is not allowed [/paths/~1things/get/responses/200/content/application~1json/schema/prefixItems]
- **ajv**: ajv/compile: strict mode: unknown keyword: "prefixItems" [paths./things.get.responses.200.application/json]
- **spectral**: oas3-schema: Property "prefixItems" is not expected to be here. [paths//things/get/responses/200/content/application/json/schema/prefixItems]
- **redocly**: struct: Property `prefixItems` is not expected here. [#/paths/~1things/get/responses/200/content/application~1json/schema/prefixItems]

## `style/missing-operationid` (style)
- oaverify: no matching finding (0 raised)
- ajv: no matching finding (0 raised)
- **spectral**: operation-operationId: Operation must have "operationId". [paths//things/get]
- **redocly**: operation-operationId: Operation object should contain `operationId` field. [#/paths/~1things/get/operationId]

## `style/duplicate-operationid` (style)
- oaverify: no matching finding (0 raised)
- ajv: no matching finding (0 raised)
- **spectral**: operation-operationId-unique: Every operation must have unique "operationId". [paths//others/get/operationId]
- **redocly**: operation-operationId-unique: Every operation must have a unique `operationId`. [#/paths/~1others/get/sameId]

## `style/unused-component` (style)
- **oaverify**: unused-component: components.schemas.NeverReferenced is declared but no operation reaches it [/components/schemas/NeverReferenced]
- ajv: no matching finding (0 raised)
- **spectral**: oas3-unused-component: Potentially unused component has been detected. [components/schemas/NeverReferenced]
- **redocly**: no-unused-components: Component: "NeverReferenced" is never used. [#/components/schemas/NeverReferenced]

## `style/undeclared-path-param` (style)
- **oaverify**: path-param-undeclared: path template "/things/{thingId}" references "{thingId}" but neither the operation nor its path item declares a path parameter named "thingId" [/paths/~1things~1{thingId}/get]
- ajv: no matching finding (0 raised)
- **spectral**: operation-description: Operation "description" must be present and non-empty string. [paths//things/{thingId}/get]
- **redocly**: operation-summary: Operation object should contain `summary` field. [#/paths/~1things~1{thingId}/get/summary]

## `style/undefined-security-scheme` (style)
- oaverify: no matching finding (0 raised)
- ajv: no matching finding (0 raised)
- **spectral**: oas3-operation-security-defined: Operation "security" values must match a scheme defined in the "components.securitySchemes" object. [paths//things/get/security/0/notDefinedAnywhere]
- **redocly**: security-defined: There is no `notDefinedAnywhere` security scheme defined. [#/paths/~1things/get/security/0/notDefinedAnywhere]

## `style/example-contradicts-schema` (style)
- **oaverify**: example-invalid: oaverify rejects "example" against its schema: count: must be integer (example: {"count":"not-an-integer"}) [/paths/~1things/get/responses/200/content/application~1json/example]
- ajv: no matching finding (0 raised)
- **spectral**: oas3-valid-media-example: "count" property type must be integer [paths//things/get/responses/200/content/application/json/example/count]
- **redocly**: no-invalid-media-type-examples: Example value must conform to the schema: `count` property type must be integer. [#/paths/~1things/get/responses/200/content/application~1json/example/count]

## `structural/missing-info-version` (structural)
- **oaverify**: required: must have required property "version" [/info/version]
- ajv: no matching finding (0 raised)
- **spectral**: oas3-schema: "info" property must have required property "version". [info]
- **redocly**: struct: The field `version` must be present on this level. [#/info]

## `structural/response-missing-description` (structural)
- **oaverify**: required: must have required property "description" [/paths/~1things/get/responses/200/description]
- ajv: no matching finding (0 raised)
- **spectral**: info-description: Info "description" must be present and non-empty string. [info]
- **redocly**: struct: The field `description` must be present on this level. [#/paths/~1things/get/responses/200]

## `structural/parameter-schema-and-content` (structural)
- **oaverify**: oneOf: must match exactly one of 2 schemas (matched 2) [/paths/~1things/get/parameters/0]
- ajv: no matching finding (0 raised)
- **spectral**: oas3-schema: "0" property must match exactly one schema in oneOf. [paths//things/get/parameters/0]
- redocly: no matching finding (5 raised)

## `structural/license-identifier-and-url` (structural)
- **oaverify**: not: must NOT match the schema [/info/license]
- ajv: no matching finding (0 raised)
- **spectral**: oas3-schema: "license" property must not be valid. [info/license]
- redocly: no matching finding (4 raised)

## `structural/path-param-not-required` (structural)
- **oaverify**: const: must equal the expected constant [/paths/~1things~1{thingId}/get/parameters/0/required]
- ajv: no matching finding (0 raised)
- **spectral**: path-params: Path parameter "thingId" must have "required" property that is set to "true". [paths//things/{thingId}/get/parameters/0]
- redocly: no matching finding (5 raised)

## `structural/dangling-discriminator-mapping` (structural)
- **oaverify**: silent-rewrite/discriminator-unroutable: "discriminator" at <root> cannot select a branch: mapping value(s) "dog" name no branch. The discriminator is ignored and the composition validates every branch instead. [GET /things 200 response body (application/json) -> <root>]
- **ajv**: ajv/compile: strict mode: unknown keyword: "discriminator" [paths./things.get.responses.200.application/json]
- spectral: no matching finding (5 raised)
- **redocly**: no-unresolved-refs: Can't resolve $ref [#/paths/~1things/get/responses/200/content/application~1json/schema/discriminator/mapping/dog]

## `structural/undeclared-server-variable` (structural)
- oaverify: no matching finding (0 raised)
- ajv: no matching finding (0 raised)
- **spectral**: oas3-server-variables: Not all server's variables are described with "variables" object. Missed: region. [servers/0]
- **redocly**: no-undefined-server-variable: The `region` variable is not defined in the `variables` objects. [#/servers/0/url]

## `structural/dangling-ref` (structural)
- **oaverify**: malformed-schema: JSON pointer /components/schemas/DoesNotExist not found (at components) [GET /things 200 response]
- **ajv**: ajv/compile: can't resolve reference #/components/schemas/DoesNotExist from id # [paths./things.get.responses.200.application/json]
- **spectral**: invalid-ref: '#/components/schemas/DoesNotExist' does not exist [paths//things/get/responses/200/content/application/json/schema/$ref]
- **redocly**: no-unresolved-refs: Can't resolve $ref [#/paths/~1things/get/responses/200/content/application~1json/schema]

## `control/clean` (control)
- oaverify: no matching finding (0 raised)
- ajv: no matching finding (1 raised)
- spectral: no matching finding (5 raised)
- redocly: no matching finding (5 raised)

## `control/required-on-sibling` (control)
- oaverify: no matching finding (0 raised)
- ajv: no matching finding (1 raised)
- spectral: no matching finding (5 raised)
- redocly: no matching finding (6 raised)

## `control/required-via-composition` (control)
- oaverify: no matching finding (0 raised)
- ajv: no matching finding (1 raised)
- spectral: no matching finding (5 raised)
- redocly: no matching finding (5 raised)

## `control/additional-properties-open` (control)
- oaverify: no matching finding (0 raised)
- ajv: no matching finding (1 raised)
- spectral: no matching finding (5 raised)
- redocly: no matching finding (6 raised)


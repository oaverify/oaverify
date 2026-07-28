/**
 * The labelled corpus.
 *
 * Each case is a minimal OpenAPI document carrying exactly one seeded
 * defect (or, in the `control` class, none). `signals` is what counts as
 * *catching that defect*: a tool that reports something unrelated on the
 * same file has not caught it, and a raw finding count would say
 * otherwise. Matching is case-insensitive substring, applied to each
 * finding's rule id and message.
 *
 * The corpus is only worth anything if it can show oaverify losing.
 * `expect` records what we believe today; a run that disagrees is the
 * interesting result, not a test failure.
 */
export type CaseClass = "malformed" | "lint" | "style" | "structural" | "control";

export interface DetectionCase {
  /** Path under `cases/`, also the row label. */
  readonly id: string;
  readonly class: CaseClass;
  /** What is wrong with the document, in one line. */
  readonly defect: string;
  /** Substrings that identify *this* defect in a tool's output. */
  readonly signals: readonly string[];
  /** Whether oaverify is expected to report it. Documents intent, not a gate. */
  readonly oaverify: "catches" | "misses";
  /** Why a miss is a deliberate scope boundary rather than a gap. */
  readonly note?: string;
}

export const CASES: readonly DetectionCase[] = [
  // ---- malformed: the schema is not a schema. oaverify throws. ----
  {
    id: "malformed/items-array",
    class: "malformed",
    defect: "`items` is an array, so every element constraint is silently dropped",
    signals: ["items"],
    oaverify: "catches",
  },
  {
    id: "malformed/type-boolean",
    class: "malformed",
    defect: '`type: "Boolean"` is not a JSON Schema type name; the schema is unsatisfiable',
    signals: ["boolean"],
    oaverify: "catches",
  },
  {
    id: "malformed/if-null",
    class: "malformed",
    defect: "`if: null` is not a schema",
    signals: ['"if"'],
    oaverify: "catches",
  },
  {
    id: "malformed/enum-scalar",
    class: "malformed",
    defect: "`enum` is a scalar rather than an array",
    signals: ["enum"],
    oaverify: "catches",
  },
  {
    id: "malformed/required-string",
    class: "malformed",
    defect: '`required: "id"` is a string, which reads as a per-character requirement',
    signals: ["required"],
    oaverify: "catches",
  },
  {
    id: "malformed/properties-array",
    class: "malformed",
    defect: "`properties` is an array of field descriptors rather than a name -> schema map",
    signals: ["properties"],
    oaverify: "catches",
  },

  // ---- lint: valid schema, behaviour that will surprise the author ----
  {
    id: "lint/required-typo",
    class: "lint",
    defect: "`required: [nam]` names a property nothing declares",
    signals: ['"nam"'],
    oaverify: "catches",
  },
  {
    id: "lint/required-typo-behind-ref",
    class: "lint",
    defect: "same typo, reachable only through a nested $ref into components",
    signals: ['"total"', "total"],
    oaverify: "catches",
    note: "The #503 case. Discriminates tools that resolve refs before linting.",
  },
  {
    id: "lint/ref-siblings-oas30",
    class: "lint",
    defect: "OAS 3.0 $ref with a sibling `required`, which is silently dropped",
    signals: ["sibling", "silently dropped"],
    oaverify: "catches",
  },
  {
    id: "lint/redundant-oneof",
    class: "lint",
    defect: "two structurally identical `oneOf` branches can never match exactly once",
    signals: ["identical", "duplicate", "redundant"],
    oaverify: "catches",
  },
  {
    id: "lint/unknown-keyword",
    class: "lint",
    defect: "`minLenght` is a typo, so the length constraint never applies",
    signals: ["minlenght"],
    oaverify: "catches",
  },
  {
    id: "lint/prefixitems-in-30",
    class: "lint",
    defect: "`prefixItems` is 2020-12 only; under OAS 3.0 it does nothing",
    signals: ["prefixitems"],
    oaverify: "catches",
  },

  // ---- style: outside oaverify's scope, and stated as such ----
  {
    id: "style/missing-operationid",
    class: "style",
    defect: "operation has no operationId",
    signals: ["operationid"],
    oaverify: "misses",
    note: "Codegen and tooling ergonomics, not validation behaviour.",
  },
  {
    id: "style/duplicate-operationid",
    class: "style",
    defect: "two operations share an operationId",
    signals: ["operationid"],
    oaverify: "misses",
    note: "Does not change how any request validates.",
  },
  {
    id: "style/unused-component",
    class: "style",
    defect: "a components schema nothing references",
    signals: ["unused", "never referenced", "neverreferenced"],
    oaverify: "misses",
    note: "Dead weight, not a defect.",
  },
  {
    id: "style/undeclared-path-param",
    class: "style",
    defect: "path templating declares {thingId} but no parameter defines it",
    signals: ["thingid"],
    oaverify: "misses",
    note: "Arguably in scope: an undeclared path param IS unvalidated input.",
  },
  {
    id: "style/undefined-security-scheme",
    class: "style",
    defect: "operation requires a security scheme that components never defines",
    signals: ["notdefinedanywhere", "security scheme"],
    oaverify: "misses",
    note: "In scope when validateSecurity is on; not reported by `check`.",
  },
  {
    id: "style/example-contradicts-schema",
    class: "style",
    defect: "declared example does not satisfy its own schema",
    signals: ["example"],
    oaverify: "misses",
    note: "The deliberately deferred `check --examples`.",
  },

  // ---- structural: not a valid OpenAPI document at all ----
  {
    id: "structural/missing-info-version",
    class: "structural",
    defect: "info.version is required and absent",
    signals: ["version"],
    oaverify: "catches",
  },
  {
    id: "structural/response-missing-description",
    class: "structural",
    defect: "response object omits the required description",
    signals: ["description"],
    oaverify: "catches",
  },
  {
    id: "structural/dangling-ref",
    class: "structural",
    defect: "$ref points at a component that does not exist",
    signals: ["doesnotexist", "unresolved", "can't resolve", "not found"],
    oaverify: "catches",
  },

  // ---- control: nothing is wrong. Any finding here is noise. ----
  {
    id: "control/clean",
    class: "control",
    defect: "(none) a small valid spec",
    signals: [],
    oaverify: "misses",
  },
  {
    id: "control/required-on-sibling",
    class: "control",
    defect: "(none) `required` under then.properties.id, declared by properties.id",
    signals: [],
    oaverify: "misses",
    note: "The paperlessreplacements shape. Flagging it is a false positive.",
  },
  {
    id: "control/required-via-composition",
    class: "control",
    defect: "(none) oneOf branches require properties the parent declares",
    signals: [],
    oaverify: "misses",
    note: "The shape that made the old rule 2.6% signal.",
  },
  {
    id: "control/additional-properties-open",
    class: "control",
    defect: "(none) required name is undeclared but additionalProperties allows it",
    signals: [],
    oaverify: "misses",
  },
];

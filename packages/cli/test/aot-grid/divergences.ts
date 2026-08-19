/**
 * The divergence registry: the differences between `createValidator`
 * and a `compile-spec` module that this gate accepts, and what each one
 * is.
 *
 * **An entry does not excuse a case. An entry asserts what the
 * difference is.** Three rules keep that from being a place to bury a
 * defect, and the gate enforces all three:
 *
 * 1. An entry whose predicate matches no case fails the run, so a fixed
 *    defect cannot leave a stale exemption behind.
 * 2. A case whose observed signature is not one the entry lists fails
 *    the run. Widening an entry is a visible edit to a signature rather
 *    than a predicate quietly growing.
 * 3. `open-defect` and `intentional` are not interchangeable. An
 *    `open-defect` entry names the issue and is expected to stop
 *    matching when that issue is fixed. An `intentional` entry has to
 *    say why the difference is correct, because nothing else will.
 *
 * The predicate reads the structured axes of a case, never its id.
 * Keying on ids would rot every entry the moment the generator gains an
 * axis, which is exactly when someone is least willing to rewrite them.
 *
 * Every entry below was written from the grid's first run against an
 * empty registry, and none of them was written before it. That run is
 * reproduced in this directory's README, and reproducing it is one
 * edit: empty this array.
 */

import type { CaseAxes } from "./cases.js";
import type { CaseResult } from "./run.js";

export interface DivergenceEntry {
  /** Short name, used in the report. */
  name: string;
  kind: "open-defect" | "intentional";
  /** The issue this divergence belongs to. */
  issue: string;
  /**
   * Why this difference is correct. Required for `intentional`, and
   * left unset for `open-defect`, where "it is a defect" is the reason.
   */
  why?: string;
  /** Matches on axes and on the wire input, never on the case id. */
  match: (axes: CaseAxes, wireId: string) => boolean;
  /**
   * Every signature this divergence is allowed to produce, as
   * `signatureOf` renders it. A case the predicate claims whose
   * signature is not listed fails the run, so an entry cannot quietly
   * come to cover a second, different defect in the same shape.
   */
  signatures: string[];
}

const isJsonContent = (axes: CaseAxes): boolean =>
  axes.source === "content" && axes.mediaType === "application/json";

export const DIVERGENCES: DivergenceEntry[] = [
  // #903, in three entries rather than one. The three payloads fail in
  // three different channels, and a single `content` predicate would
  // have hidden two of them behind the first: a broad entry is a
  // hiding place even when the issue number is right.
  {
    name: "content-json/valid-payload",
    kind: "open-defect",
    issue: "#903",
    match: (axes, wireId) => isJsonContent(axes) && wireId === "validJson",
    // The emitted module never parses, so the schema sees the raw
    // string: the runtime accepts and delivers an object, the AOT
    // rejects and delivers nothing.
    signatures: [
      'verdict:valid->invalid | leaves:[]->[{"code":"type","path":"cookie.p"}] | value:{"path":{},"query":{},"headers":{},"cookies":{"p":{"R":1,"G":2}}}->{"path":{},"query":{},"headers":{},"cookies":{}}',
      'verdict:valid->invalid | leaves:[]->[{"code":"type","path":"header.p"}] | value:{"path":{},"query":{},"headers":{"p":{"R":1,"G":2}},"cookies":{}}->{"path":{},"query":{},"headers":{},"cookies":{}}',
      'verdict:valid->invalid | leaves:[]->[{"code":"type","path":"path.p"}] | value:{"path":{"p":{"R":1,"G":2}},"query":{},"headers":{},"cookies":{}}->{"path":{},"query":{},"headers":{},"cookies":{}}',
      'verdict:valid->invalid | leaves:[]->[{"code":"type","path":"query.p"}] | value:{"path":{},"query":{"p":{"R":1,"G":2}},"headers":{},"cookies":{}}->{"path":{},"query":{},"headers":{},"cookies":{}}',
    ],
  },
  {
    name: "content-json/schema-invalid-payload",
    kind: "open-defect",
    issue: "#903",
    match: (axes, wireId) => isJsonContent(axes) && wireId === "schemaInvalidJson",
    // Both reject. The leaf path is what differs: the runtime blames
    // the property inside the parsed object, the AOT blames the
    // parameter, so a client is told the wrong field is wrong.
    signatures: [
      'leaves:[{"code":"type","path":"cookie.p.R"}]->[{"code":"type","path":"cookie.p"}]',
      'leaves:[{"code":"type","path":"header.p.R"}]->[{"code":"type","path":"header.p"}]',
      'leaves:[{"code":"type","path":"path.p.R"}]->[{"code":"type","path":"path.p"}]',
      'leaves:[{"code":"type","path":"query.p.R"}]->[{"code":"type","path":"query.p"}]',
    ],
  },
  {
    name: "content-json/unparseable-payload",
    kind: "open-defect",
    issue: "#903",
    match: (axes, wireId) => isJsonContent(axes) && wireId === "notJson",
    // Both reject. The runtime says the parameter is not valid JSON
    // (`<location>-param`, `reason: content-parse`); the AOT says the
    // schema's type is wrong.
    signatures: [
      'leaves:[{"code":"cookie-param","path":"cookie.p"}]->[{"code":"type","path":"cookie.p"}]',
      'leaves:[{"code":"header-param","path":"header.p"}]->[{"code":"type","path":"header.p"}]',
      'leaves:[{"code":"path-param","path":"path.p"}]->[{"code":"type","path":"path.p"}]',
      'leaves:[{"code":"query-param","path":"query.p"}]->[{"code":"type","path":"query.p"}]',
    ],
  },

  // #899. The router answers HEAD with the GET operation on the
  // interpreted side and not in the emitted module, so a HEAD request
  // to a path declaring only `get` is a 404 from a compiled validator.
  // Four channels at once, and `operation` is the one that names the
  // router rather than the symptom.
  {
    name: "router/implicit-head",
    kind: "open-defect",
    issue: "#899",
    match: (axes, wireId) =>
      axes.shape === "methods" && wireId === "HEAD" && axes.methods?.includes("get") === true,
    signatures: [
      'verdict:valid->invalid | leaves:[]->[{"code":"route","path":""}] | value:{"path":{},"query":{"q":"x"},"headers":{},"cookies":{}}->{"path":{},"query":{},"headers":{},"cookies":{}} | operation:"/t"->null',
    ],
  },

  // #895, in three entries: the same issue reaches the request by
  // three different routes, and each has its own signature.
  {
    name: "security/not-configurable-off",
    kind: "open-defect",
    issue: "#895",
    match: (axes, wireId) =>
      axes.shape === "security" && axes.runtimeSecurity === "off" && wireId === "noCredential",
    // Operation-level security, runtime default. The runtime does not
    // check security unless asked; the emitted module always does, so
    // a compiled validator rejects a request the interpreted one
    // accepts and there is no option to turn it off.
    signatures: [
      'verdict:valid->invalid | leaves:[]->[{"code":"security","path":"security"}] | value:{"path":{},"query":{"q":"x"},"headers":{},"cookies":{}}->{"path":{},"query":{},"headers":{},"cookies":{}}',
    ],
  },
  {
    name: "security/document-level-unenforced",
    kind: "open-defect",
    issue: "#895",
    match: (axes, wireId) =>
      axes.shape === "security" && axes.runtimeSecurity === "shape" && wireId === "noCredential",
    // The reverse, and the half a grid without a runtime-option axis
    // cannot see: document-level security asked for by name is
    // enforced by the runtime and ignored by the emitted module.
    signatures: [
      'verdict:invalid->valid | leaves:[{"code":"security","path":"security"}]->[] | value:{"path":{},"query":{},"headers":{},"cookies":{}}->{"path":{},"query":{"q":"x"},"headers":{},"cookies":{}}',
    ],
  },
  {
    name: "security/gate-ordering",
    kind: "open-defect",
    issue: "#895",
    match: (axes, wireId) =>
      axes.shape === "security-x-parameter" &&
      axes.runtimeSecurity === "shape" &&
      wireId === "badParamNoCredential",
    // Verdicts agree, both invalid, and the reported reason does not:
    // the runtime stops at the security gate, the emitted module has
    // no gate to stop at and reports the parameter instead. The cell
    // exists because a verdict-only comparison calls this identical.
    signatures: [
      'leaves:[{"code":"security","path":"security"}]->[{"code":"type","path":"query.n"}]',
    ],
  },
];

/** The entry claiming a case, or undefined when nothing claims it. */
export function entryFor(c: CaseResult): DivergenceEntry | undefined {
  return DIVERGENCES.find((e) => e.match(c.axes, c.wireId));
}

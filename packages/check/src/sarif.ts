/**
 * SARIF 2.1.0 output for `check`, so findings land in GitHub code
 * scanning, GitLab, editors and security dashboards without anyone
 * adopting a new CLI workflow.
 *
 * The mapping is mostly direct, because `check`'s finding contract was
 * designed around the same distinctions SARIF makes: `code` is a
 * `ruleId`, `class` is a rule taxonomy, `severity` is a `level`, and
 * `target.source` is a `physicalLocation`. What needed deciding is
 * documented on each function below, and the three that a reader is
 * most likely to want to argue with are collected here.
 *
 * **Locations come from `target.source`, never from `target.pointer`.**
 * The pointer addresses the resolved document, which for a multi-file
 * spec is a position no author typed and no file contains. A result
 * anchored there would point code scanning at a line that does not
 * exist. The pointer is kept in `properties` instead, where it is
 * available and not mistaken for a place on disk.
 *
 * **No `region`.** SARIF locates a result with `artifactLocation` plus
 * a `region` of line and column, and oaverify has files and pointers
 * but not lines (#610). So a finding is attributed to the right file
 * and appears in the security tab, and it is not annotated on the diff
 * line. Emitting a `region` of line 1 to fill the field would put every
 * finding on the first line of its file, which is worse than none.
 *
 * **`via` is `relatedLocations`, not a code flow.** Where a finding's
 * anchor is `definition` or `scoped-definition`, `via` records how the
 * *resolver* first reached that shared text, not the route this finding
 * took to it. `codeFlows` asserts a path taken, so using it here would
 * state something untrue.
 *
 * @packageDocumentation
 */

import { isAbsolute, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { type CheckClass, type CheckFinding, type CheckSeverity } from "./finding.js";
import type { SkipReportEntry } from "./skip.js";
import type { TermReport } from "./selection.js";

/** The version this emitter targets, and the schema it declares. */
const SARIF_VERSION = "2.1.0";
const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

/**
 * `severity` to SARIF `level`.
 *
 * SARIF has `error`, `warning`, `note` and `none`; oaverify has three,
 * and `fatal` has no counterpart. It maps to `error`, which is the only
 * honest target: a document that cannot be compiled is at least an
 * error, and the distinction survives in `properties.severity` for a
 * consumer that wants it back.
 *
 * A consumer's `--severity` mapping has already been applied by the
 * time findings reach here, so their grading flows through to code
 * scanning rather than this file carrying a policy of its own.
 */
function levelOf(severity: CheckSeverity): "error" | "warning" {
  return severity === "warning" ? "warning" : "error";
}

/**
 * Turn a source URI into an `artifactLocation`.
 *
 * Code scanning matches a result to a repository file by a path
 * relative to the checkout root, so a local path is emitted relative to
 * `base` with `uriBaseId: "%SRCROOT%"`. That makes the run's
 * correctness depend on where it was invoked from, which is why `base`
 * is a parameter and why the README says to run `check` from the
 * repository root, as CI does.
 *
 * Two cases deliberately produce no `uriBaseId`:
 *
 * - An `http(s)` spec, which has no file in the checkout. It gets its
 *   absolute URL, will not annotate a diff, and should not pretend to.
 * - A local path outside `base`. Relativising it would emit a `../`
 *   traversal that code scanning rejects, so it becomes an absolute
 *   `file:` URL instead and is attributed honestly to somewhere else.
 */
export function artifactLocation(uri: string, base: string): { uri: string; uriBaseId?: string } {
  if (/^https?:/i.test(uri)) return { uri };

  const path = uri.startsWith("file:") ? decodeURIComponent(uri.replace(/^file:\/\//, "")) : uri;
  const absolute = isAbsolute(path) ? path : `${base}${sep}${path}`;
  const rel = relative(base, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { uri: pathToFileURL(absolute).href };
  }
  // SARIF URIs use forward slashes whatever the platform.
  return { uri: rel.split(sep).join("/"), uriBaseId: "%SRCROOT%" };
}

/**
 * A stable identity for a finding, across commits and file moves.
 *
 * Code scanning uses `partialFingerprints` to decide whether a result
 * in this run is the same one it saw before. Its default keys on the
 * content of the line, which churns whenever a file is reformatted or
 * moved. `code` plus the source pointer is stable under both, and stays
 * meaningful when a `region` arrives later.
 *
 * Falls back to the resolved pointer, then to the message, so the field
 * is always present: a result with no fingerprint gets the churning
 * default rather than nothing.
 */
function fingerprint(finding: CheckFinding): string {
  const where =
    finding.target?.source === undefined
      ? (finding.target?.pointer ?? finding.message)
      : `${finding.target.source.uri}${finding.target.source.pointer}`;
  return `${finding.code} ${where}`;
}

interface SarifLocation {
  physicalLocation: { artifactLocation: { uri: string; uriBaseId?: string } };
  message?: { text: string };
}

function locationsOf(finding: CheckFinding, base: string): SarifLocation[] {
  const source = finding.target?.source;
  if (source === undefined) return [];
  return [{ physicalLocation: { artifactLocation: artifactLocation(source.uri, base) } }];
}

function relatedLocationsOf(finding: CheckFinding, base: string): SarifLocation[] {
  const via = finding.target?.source?.via ?? [];
  return via.map((hop, i) => ({
    physicalLocation: { artifactLocation: artifactLocation(hop.uri, base) },
    message: {
      text: `reference ${i + 1} of ${via.length} the resolver followed to reach this document: ${hop.pointer}`,
    },
  }));
}

/**
 * Rule metadata for every code the run produced.
 *
 * Generated from the findings rather than from a hand-kept list, so a
 * rule added to oaverify needs no edit here and cannot be forgotten.
 * The cost is that `rules` describes this run rather than the tool's
 * whole catalogue, which SARIF permits and which no consumer of a
 * single run can tell apart.
 */
function rulesOf(findings: readonly CheckFinding[]): {
  rules: unknown[];
  indexOf: Map<string, number>;
} {
  const indexOf = new Map<string, number>();
  const rules: unknown[] = [];
  for (const finding of findings) {
    if (indexOf.has(finding.code)) continue;
    indexOf.set(finding.code, rules.length);
    rules.push({
      id: finding.code,
      name: finding.code,
      shortDescription: { text: finding.code },
      defaultConfiguration: { level: levelOf(finding.severity) },
      properties: { "oaverify:class": finding.class, tags: [finding.class] },
    });
  }
  return { rules, indexOf };
}

/**
 * Render a `check` report as a SARIF 2.1.0 log.
 *
 * A data transformation rather than a rendering choice, which is why it
 * lives here and the text report does not: uploading findings to code
 * scanning is not a CLI-only need.
 *
 * **Locations come from `target.source`, so a spec checked without
 * provenance produces results with `locations: []`.** They still carry
 * `ruleId`, `level`, `message` and the `oaverify:*` properties, and
 * they will not annotate a file. See {@link FindingTarget.source}.
 *
 * **Excluded findings are absent, and the log says so.** They were not
 * produced, so there is no result to suppress; the exclusion is reported
 * as a run notification instead of as `result.suppressions`, which would
 * mean emitting the results and contradicting that. The JSON report's
 * `skipped` block is the machine-readable form.
 *
 * The notification echoes the term as it was written, sign included, so
 * a reader fixing a CI configuration can match a line back to what they
 * typed. A term that changed nothing is reported the same way, at the
 * same level, under its own descriptor.
 *
 * @param findings - The findings, after any regrading and any skipping.
 * @param options - `version` names the tool and defaults to `"0.0.0"`;
 *   `base` is the directory local paths are made relative to, and
 *   defaults to the working directory; `classes` names the classes the
 *   run selected: the same list passed to `checkSpec` as `only`, or
 *   `CHECK_CLASSES` for a full run. Required rather than defaulted,
 *   because the log asserts it as `oaverify:classes` so a consumer can
 *   tell a partial run from a clean document; a default of all five
 *   would label a partial run complete.
 *
 * @public
 */
export function renderSarif(
  findings: readonly CheckFinding[],
  options: {
    version?: string;
    base?: string;
    classes: readonly CheckClass[];
    /** What the exclusions dropped, if anything. See {@link SkipReportEntry}. */
    skipped?: readonly SkipReportEntry[];
    /**
     * Terms that changed nothing. Absent
     * from the log entirely when there are none, so a clean command
     * produces no notification.
     */
    noopTerms?: readonly TermReport[];
  },
): string {
  const version = options.version ?? "0.0.0";
  const base = options.base ?? process.cwd();
  const classes = options.classes;
  const { rules, indexOf } = rulesOf(findings);
  const skipNotifications = (options.skipped ?? []).map((entry) => ({
    level: "note",
    message: {
      text:
        `--findings -${entry.key} suppressed ${entry.count} finding(s); ` +
        `they are absent from this log.`,
    },
    descriptor: { id: "oaverify:skipped" },
    properties: { "oaverify:skipKey": `-${entry.key}`, "oaverify:skipCount": entry.count },
  }));
  // A no-op term changed nothing, so nothing is missing from the log
  // because of it. It is reported anyway, for the reason the zero counts
  // above are: a CI configuration naming work it no longer reaches is
  // how a real defect eventually arrives suppressed and unnoticed.
  const noopNotifications = (options.noopTerms ?? []).map((term) => ({
    level: "note",
    message: {
      text: `--findings ${term.term} changed nothing (${term.noop ?? ""}).`,
    },
    descriptor: { id: "oaverify:noop-term" },
    properties: { "oaverify:term": term.term, "oaverify:reason": term.noop ?? "" },
  }));

  const notifications = [...skipNotifications, ...noopNotifications];

  const results = findings.map((finding) => {
    const related = relatedLocationsOf(finding, base);
    return {
      ruleId: finding.code,
      ruleIndex: indexOf.get(finding.code),
      level: levelOf(finding.severity),
      message: { text: finding.message },
      locations: locationsOf(finding, base),
      ...(related.length > 0 ? { relatedLocations: related } : {}),
      partialFingerprints: { oaverifyFindingV1: fingerprint(finding) },
      properties: {
        "oaverify:class": finding.class,
        // The grading as this run reported it, so `fatal` survives its
        // collapse into SARIF's `error`.
        "oaverify:severity": finding.severity,
        // Display text, and an address into the resolved document that
        // is not a place on disk. Both are useful and neither is a
        // location, so they travel as properties.
        "oaverify:location": finding.location,
        ...(finding.target === undefined
          ? {}
          : {
              "oaverify:pointer": finding.target.pointer,
              "oaverify:anchor": finding.target.anchor,
              ...(finding.target.source === undefined
                ? {}
                : { "oaverify:sourcePointer": finding.target.source.pointer }),
            }),
        ...(finding.occurrences === undefined
          ? {}
          : { "oaverify:occurrences": finding.occurrences }),
      },
    };
  });

  const log = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: "oaverify",
            informationUri: "https://github.com/oaverify/oaverify",
            version,
            semanticVersion: version,
            rules,
          },
        },
        // Named so a consumer can tell a partial run from a clean
        // document: `check --only schema` reporting nothing means
        // something different from a full run reporting nothing.
        properties: { "oaverify:classes": [...classes].sort() },
        // Same reason, for the other way a report can be short of what
        // the passes found. A note rather than a result, because a
        // skipped finding was not produced.
        ...(notifications.length === 0
          ? {}
          : {
              invocations: [
                { executionSuccessful: true, toolExecutionNotifications: notifications },
              ],
            }),
        results,
      },
    ],
  };
  return JSON.stringify(log, null, 2) + "\n";
}

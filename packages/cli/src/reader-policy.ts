/**
 * The CLI's reader posture: what `--remote-refs` and `--untrusted`
 * mean in terms of the reader options that already exist.
 *
 * The readers own the controls (`allowUri`, `redirects`, `timeoutMs`,
 * `maxBytes`, `confine`); this module owns the decision about which
 * combination each posture is. Individual controls are deliberately not
 * exposed as flags: a control may be exposed on its own only when it can
 * only subtract capability, and `allowUri` fails that test, because an
 * allowlist without `redirects: "error"` does not survive a redirect.
 */
import { dirname, resolve as resolvePath } from "node:path";
import type { DocumentReader, FileReaderOptions, HttpReaderOptions } from "@oaverify/internal-spec";

/**
 * How the CLI treats http(s) reads.
 *
 * Governs every http(s) read, the entry document included, not only
 * `$ref` targets. `deny` therefore refuses a remote entry; see
 * {@link entryRefusal}.
 */
export const REMOTE_REFS_MODES = ["allow", "same-origin", "deny"] as const;

/** @see {@link REMOTE_REFS_MODES} */
export type RemoteRefsMode = (typeof REMOTE_REFS_MODES)[number];

/** The default posture. */
export const DEFAULT_REMOTE_REFS: RemoteRefsMode = "allow";

/**
 * Size and time caps applied whatever the posture.
 *
 * Generous on purpose. The largest document these are calibrated
 * against is 12MB, so 64MiB is not a limit a spec meets by being large.
 * It is there so a `$ref` at something that is not a spec fails
 * quickly.
 */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** @see {@link DEFAULT_MAX_BYTES} */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Caps under `--untrusted`, where the document is the adversary. */
export const UNTRUSTED_MAX_BYTES = 8 * 1024 * 1024;
/** @see {@link UNTRUSTED_MAX_BYTES} */
export const UNTRUSTED_TIMEOUT_MS = 5_000;

/** What a command knows by the time it can build a reader. */
export interface ReaderPolicy {
  /** The entry URI or path, as typed. */
  entry: string;
  remoteRefs: RemoteRefsMode;
  untrusted: boolean;
  /**
   * Called once per successful read that `same-origin` would have
   * refused, the entry excluded.
   *
   * Cross-origin rather than remote, because that is what the notice it
   * drives says: a remote entry whose refs are all siblings on its own
   * origin is unaffected by a stricter default and should not be told
   * otherwise. See {@link remoteRefsNotice}.
   */
  onCrossOriginRead?: (uri: string) => void;
}

/** The flags a command parsed, before they are resolved to a posture. */
export interface ReaderFlags {
  /** `--remote-refs`, absent when the flag was not passed. */
  remoteRefs?: RemoteRefsMode;
  /** `--untrusted`. */
  untrusted?: boolean;
}

/**
 * Resolve flags to a posture.
 *
 * `--untrusted` implies `same-origin`. The other thing it sets is
 * `confine`, which is not a limit: `maxBytes` and `timeoutMs` answer
 * "how much", `confine` answers "where may a read go". `same-origin` is
 * that same question asked of the network, so bounding one surface and
 * leaving the other open would be half a boundary. A spec confined to
 * its own directory on disk could still `$ref`
 * `http://169.254.169.254/`.
 *
 * An explicit `--remote-refs` wins, including `--untrusted
 * --remote-refs allow`. A posture that cannot be overridden is one
 * people work around.
 */
export function policyFor(entry: string, flags: ReaderFlags = {}): ReaderPolicy {
  const untrusted = flags.untrusted === true;
  return {
    entry,
    remoteRefs: flags.remoteRefs ?? (untrusted ? "same-origin" : DEFAULT_REMOTE_REFS),
    untrusted,
  };
}

/** True for a URI the http reader would claim. */
export function isHttpUri(uri: string): boolean {
  return /^https?:/i.test(uri);
}

/**
 * Parse a `--remote-refs` value, naming the legal set on a typo rather
 * than falling back to a default the caller did not ask for.
 */
export function parseRemoteRefs(value: string): RemoteRefsMode {
  const found = REMOTE_REFS_MODES.find((m) => m === value);
  if (found === undefined) {
    throw new Error(
      `--remote-refs: unknown mode "${value}" (expected ${REMOTE_REFS_MODES.join(", ")})`,
    );
  }
  return found;
}

/**
 * The origin an http(s) entry consents to, or `undefined` when the
 * entry is not remote.
 *
 * Handing the tool a remote spec opts into that origin rather than that
 * one URI: whoever served the entry already controls the document, so a
 * sibling file on the same host is covered by the same act. A different
 * host is not, which is the SSRF shape that matters.
 */
export function originOf(entry: string): string | undefined {
  if (!isHttpUri(entry)) return undefined;
  try {
    return new URL(entry).origin;
  } catch {
    return undefined;
  }
}

/**
 * The usage error for a posture that cannot read the entry it was
 * given, or `undefined` when the two agree.
 *
 * Reported before anything is read, so the message names the
 * contradiction rather than surfacing later as a reader with nothing
 * that can handle the URI.
 */
export function entryRefusal(policy: ReaderPolicy): string | undefined {
  if (policy.remoteRefs !== "deny" || !isHttpUri(policy.entry)) return undefined;
  return (
    `--remote-refs deny refuses http(s) reads, but the entry is ${policy.entry}. ` +
    `Pass --remote-refs same-origin, or give a local entry.`
  );
}

/**
 * Http reader options for a posture.
 *
 * `redirects: "error"` rides along with every posture that restricts by
 * URI, because `fetch` follows redirects internally and `allowUri` never
 * sees the hop: an approved origin answering 302 would otherwise send
 * the reader to an internal address with the allowlist none the wiser.
 */
export function httpOptionsFor(policy: ReaderPolicy): HttpReaderOptions {
  const caps = {
    maxBytes: policy.untrusted ? UNTRUSTED_MAX_BYTES : DEFAULT_MAX_BYTES,
    timeoutMs: policy.untrusted ? UNTRUSTED_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
  };
  if (policy.remoteRefs === "allow") return caps;
  if (policy.remoteRefs === "deny") {
    return { ...caps, allowUri: () => false, redirects: "error" };
  }
  return {
    ...caps,
    allowUri: (uri) => allowsUri(policy, uri),
    redirects: "error",
  };
}

/**
 * Whether a posture admits a URI. The single statement of the rule:
 * {@link httpOptionsFor} enforces it and {@link policyHttpReader}
 * explains it, so the refusal message and the refusal cannot disagree.
 *
 * A local or stdin entry gave no opt-in, so there is no origin to match
 * and nothing remote resolves.
 */
export function allowsUri(policy: ReaderPolicy, uri: string): boolean {
  if (policy.remoteRefs === "allow") return true;
  if (policy.remoteRefs === "deny") return false;
  const origin = originOf(policy.entry);
  return origin !== undefined && originOf(uri) === origin;
}

/**
 * The directory `confine` confines to, or `undefined` when the posture
 * does not confine.
 *
 * `createFileReader` resolves relative URIs against its `cwd` and
 * confines to it, so a caller that sets this root must also give the
 * loader an absolute entry; see {@link confinedEntry}. Left relative,
 * the entry would be resolved against its own directory a second time
 * (`specs/openapi.json` under root `specs/` reads
 * `specs/specs/openapi.json`).
 */
export function confineRootFor(policy: ReaderPolicy): string | undefined {
  if (!policy.untrusted || isHttpUri(policy.entry) || policy.entry === "-") return undefined;
  return dirname(resolvePath(policy.entry));
}

/**
 * The entry as the loader should be given it: absolute when the posture
 * confines, so that it and every `$ref` base derived from it resolve
 * against the same root {@link confineRootFor} returned. Unchanged
 * otherwise, so ordinary runs keep reporting the path as typed.
 */
export function confinedEntry(policy: ReaderPolicy): string {
  return confineRootFor(policy) === undefined ? policy.entry : resolvePath(policy.entry);
}

/**
 * File reader options for a posture.
 *
 * `confine` is set only when {@link confineRootFor} yields a root to
 * confine to. The two are one decision: confining without a root of the
 * entry's own falls back to the process working directory, which bears
 * no relation to the document.
 */
export function fileOptionsFor(policy: ReaderPolicy): FileReaderOptions {
  return {
    maxBytes: policy.untrusted ? UNTRUSTED_MAX_BYTES : DEFAULT_MAX_BYTES,
    // Confine stays opt-in: `$ref: ../shared/common.yaml` is normal and
    // correct, so confining by default breaks working specs to close a
    // read that needs an attacker to name a sensitive file that already
    // exists locally.
    ...(confineRootFor(policy) !== undefined && { confine: true }),
  };
}

/**
 * Wrap an http reader so a refusal names the posture that refused, and
 * a success is counted.
 *
 * The count is what the `allow` posture reports afterwards, and covers
 * only the reads a stricter default would refuse. The notice it drives
 * has to reach a user who has set no flag, so nothing about it depends
 * on their having asked.
 */
export function policyHttpReader(
  inner: DocumentReader,
  policy: ReaderPolicy,
  onCrossOriginRead: ((uri: string) => void) | undefined = policy.onCrossOriginRead,
): DocumentReader {
  return {
    canRead: (uri) => inner.canRead(uri),
    async read(uri) {
      const refusal = refuse(policy, uri);
      if (refusal !== undefined) throw new Error(refusal);
      const doc = await inner.read(uri);
      // The entry goes through this reader too, and pointing at a URL
      // is not a $ref. Counting it would report one to a user who has
      // none.
      if (uri !== policy.entry && !allowsUri({ ...policy, remoteRefs: "same-origin" }, uri)) {
        onCrossOriginRead?.(uri);
      }
      return doc;
    },
  };
}

/** Why a posture refused a URI, or `undefined` when it admits it. */
function refuse(policy: ReaderPolicy, uri: string): string | undefined {
  if (allowsUri(policy, uri)) return undefined;
  if (policy.remoteRefs === "deny") return `${uri}: refused by --remote-refs deny`;
  const origin = originOf(policy.entry);
  return origin === undefined
    ? `${uri}: refused by --remote-refs same-origin (the entry is not remote, so no origin was opted into)`
    : `${uri}: refused by --remote-refs same-origin (the entry's origin is ${origin})`;
}

/**
 * The notice printed after a run that resolved remote `$ref`s under the
 * default posture. Empty when nothing remote was read.
 */
export function remoteRefsNotice(command: string, count: number): string {
  if (count === 0) return "";
  const plural = count === 1 ? "" : "s";
  return (
    `${command}: resolved ${count} cross-origin $ref${plural} over the network. ` +
    `A future major refuses cross-origin refs by default; pass --remote-refs allow ` +
    `to keep this, or --remote-refs same-origin to adopt it now.\n`
  );
}

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

/** The default posture. v5 and v6 behaviour, unchanged. */
export const DEFAULT_REMOTE_REFS: RemoteRefsMode = "allow";

/**
 * Size and time caps applied whatever the posture.
 *
 * Generous on purpose: the largest document in this repo's real-world
 * corpus is `github.json` at 12MB, so 64MiB is not a limit a spec meets
 * by being large. It is there so a `$ref` at something that is not a
 * spec at all fails quickly.
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
   * Called once per remote read that succeeded, the entry excluded.
   * The command counts these to decide whether to print the notice; see
   * {@link remoteRefsNotice}.
   */
  onRemoteRead?: () => void;
}

/** The posture a command starts from before flags are applied. */
export function defaultPolicy(entry: string): ReaderPolicy {
  return { entry, remoteRefs: DEFAULT_REMOTE_REFS, untrusted: false };
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
 * explains it, so a change here cannot leave the message describing a
 * rule the reader no longer applies.
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
 * `createFileReader` confines to its `cwd` argument, so the root and the
 * option have to be decided together: confining to the process working
 * directory would be a different (and wrong) rule for
 * `oaverify check ../elsewhere/spec.yaml`.
 */
export function confineRootFor(policy: ReaderPolicy): string | undefined {
  if (!policy.untrusted || isHttpUri(policy.entry) || policy.entry === "-") return undefined;
  return dirname(resolvePath(policy.entry));
}

/** File reader options for a posture. */
export function fileOptionsFor(policy: ReaderPolicy): FileReaderOptions {
  return {
    maxBytes: policy.untrusted ? UNTRUSTED_MAX_BYTES : DEFAULT_MAX_BYTES,
    // Confine stays opt-in: `$ref: ../shared/common.yaml` is normal and
    // correct, so confining by default breaks working specs to close a
    // read that needs an attacker to name a sensitive file that already
    // exists locally.
    ...(policy.untrusted && { confine: true }),
  };
}

/**
 * Wrap an http reader so a refusal names the posture that refused, and
 * a success is counted.
 *
 * The count is what the `allow` posture reports afterwards: a user who
 * never sets the flag is the one who breaks when the default changes,
 * so the notice has to reach them without their doing anything.
 */
export function policyHttpReader(
  inner: DocumentReader,
  policy: ReaderPolicy,
  onRemoteRead: (() => void) | undefined = policy.onRemoteRead,
): DocumentReader {
  return {
    canRead: (uri) => inner.canRead(uri),
    async read(uri) {
      const refusal = refuse(policy, uri);
      if (refusal !== undefined) throw new Error(refusal);
      const doc = await inner.read(uri);
      // The entry goes through this reader too, and pointing at a URL
      // is not a remote $ref. Counting it would report a ref to a user
      // who has none and warn them about a default that never applied
      // to what they did.
      if (uri !== policy.entry) onRemoteRead?.();
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
    `${command}: resolved ${count} remote $ref${plural} over the network. ` +
    `A future major refuses cross-origin refs by default; pass --remote-refs allow ` +
    `to keep this, or --remote-refs same-origin to adopt it now.\n`
  );
}

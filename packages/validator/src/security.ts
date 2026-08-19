import {
  createLeafError,
  type HttpRequest,
  type OpenAPIDocument,
  type OperationObject,
  type ReferenceObject,
  type SecurityRequirementObject,
  type SecuritySchemeObject,
  type ValidationError,
  setSpecKey,
} from "@oaverify/internal-core";
import {
  isHeaderObjectPrototypePropertyName,
  isObjectPrototypePropertyName,
} from "@oaverify/internal-core/prototype-properties";
import { getHeaderValue, getHeaderValueFast, getOwn } from "./headers.js";

/**
 * Shape-only security check precompiled from a single OpenAPI security
 * scheme definition. Returns `null` when the request carries the
 * declared credential (presence + structural shape only); returns a
 * short human-readable reason when it doesn't. Credential verification
 * (token validity, API key lookup, password match) is outside scope;
 * that's the app's auth middleware.
 *
 * @internal
 */
interface CompiledSchemeCheck {
  scheme: string;
  check: (req: HttpRequest) => string | null;
}

/**
 * One security requirement: an AND of `CompiledSchemeCheck`s. All must
 * return `null` for the requirement to be satisfied.
 *
 * @internal
 */
export interface CompiledSecurityRequirement {
  schemes: CompiledSchemeCheck[];
}

/**
 * A pre-compiled, operation-level security check. An OR across one or
 * more `CompiledSecurityRequirement`s; at least one must fully satisfy
 * for the request to pass. `null` (stored as `undefined` on
 * `OperationCache`) means "no security required" and skips the check.
 *
 * @internal
 */
export type CompiledSecurity = CompiledSecurityRequirement[];

/**
 * Strictness toggle for shape-only security validation. `"shape"`
 * checks recognized schemes (`bearer`, `basic`, `apiKey`) and silently
 * passes on everything else (oauth2, openIdConnect, mutualTLS, HTTP
 * non-bearer/non-basic). `"strict"` checks recognized schemes and
 * fails the request on any unrecognized scheme. Mirrors the `"shape"`
 * / `"strict"` values of {@link ValidatorOptions.validateSecurity}.
 *
 * @internal
 */
export type SecurityMode = "shape" | "strict";

/**
 * Compile the effective security for one operation. Applies OAS
 * precedence: operation-level `security` (including an explicit empty
 * array opt-out) overrides `document.security`. Unknown scheme names
 * compile to always-failing checks so a typo produces a 401 rather
 * than silently passing.
 *
 * Returns `undefined` when no requirement applies (no check emitted at
 * request time): distinct from an empty array, which is never returned
 * here: empty means "no security" and we fold that into `undefined`.
 *
 * @internal
 */
export function compileOperationSecurity(
  operation: OperationObject,
  document: OpenAPIDocument,
  resolveRef: <T>(v: T | ReferenceObject | undefined) => T | undefined,
  mode: SecurityMode = "shape",
): CompiledSecurity | undefined {
  const effective = operation.security ?? document.security;
  // `== null`, not `=== undefined`: `security:` with nothing under it
  // parses as `null` and says nothing is declared, which is readable.
  // Reading it as unreadable made a commented-out document-level
  // requirement fail every request to every operation, including one
  // carrying the credential, while the same YAML on an operation passed.
  // The overlay reader spells the same predicate the same way.
  if (effective == null) return undefined;
  if (!Array.isArray(effective)) return [unreadableSecurityRequirement()];
  if (effective.length === 0) return undefined;

  const schemes = document.components?.securitySchemes ?? {};
  const resolvedSchemes: Record<string, SecuritySchemeObject | undefined> = {};
  for (const [name, raw] of Object.entries(schemes)) {
    setSpecKey(resolvedSchemes, name, resolveRef<SecuritySchemeObject>(raw));
  }

  return effective.map((req) => compileRequirement(req, resolvedSchemes, mode));
}

/**
 * The requirement an unreadable `security` compiles to: one that no
 * request satisfies.
 *
 * OpenAPI declares `security` as an array of Security Requirement
 * Objects, and a document writing one as a mapping is a missing `- `.
 * Iterating it threw `TypeError: effective.map is not a function` out of
 * every `validateRequest` (#883).
 *
 * Reading it as absent is what the sibling shape does for a `parameters`
 * that is not a list (#837), and it is the wrong answer here. The
 * consequence there is that nothing asserts the parameters the document
 * meant to declare; the same consequence for `security` is that nothing
 * asserts the credential, so an operation whose author did require auth
 * serves every anonymous request. This file already answers that
 * question the other way twice: an undeclared scheme name and a
 * malformed `apiKey` definition both compile to a failing check rather
 * than a passing one, so a typo produces a 401 instead of silently
 * passing.
 *
 * The document defect still reaches the author through `check`, which
 * reports `must be array` at the pointer. The 401 is what stops an
 * unreadable requirement being read as no requirement in the meantime.
 *
 * `declared` names the field rather than a scheme because there is no
 * readable scheme name to report: the mapping's own keys would be a
 * guess at a shape that failed to parse.
 */
function unreadableSecurityRequirement(): CompiledSecurityRequirement {
  return {
    schemes: [
      {
        scheme: "security",
        check: () => "is not a list of security requirement objects",
      },
    ],
  };
}

/**
 * A Security Requirement Object is a mapping of scheme name to scopes.
 * A list item written with nothing under it parses as `null`, which is
 * an array element rather than a malformed container, so it passes the
 * `Array.isArray` guard above and used to reach `Object.keys(null)`:
 *
 * ```yaml
 * security:
 *   -
 * ```
 *
 * That threw the same raw `TypeError` out of `validateRequest` and took
 * `oaverify check` to exit 3, which is the symptom #883 exists to
 * remove, so the element gets the same fail-closed answer the container
 * does.
 *
 * `checkSecurity` ORs across requirements, so a readable alternative
 * that the request satisfies still passes. That is the right reading of
 * an OR: only one alternative has to hold, and the unreadable one is
 * simply never the one that does.
 */
function compileRequirement(
  req: SecurityRequirementObject,
  schemes: Record<string, SecuritySchemeObject | undefined>,
  mode: SecurityMode,
): CompiledSecurityRequirement {
  if (req === null || typeof req !== "object" || Array.isArray(req)) {
    return unreadableSecurityRequirement();
  }
  const compiled: CompiledSchemeCheck[] = [];
  for (const name of Object.keys(req)) {
    const scheme = getOwn(schemes, name);
    compiled.push(compileSchemeCheck(name, scheme, mode));
  }
  return { schemes: compiled };
}

function compileSchemeCheck(
  name: string,
  scheme: SecuritySchemeObject | undefined,
  mode: SecurityMode,
): CompiledSchemeCheck {
  if (scheme === undefined) {
    return {
      scheme: name,
      check: () => `"${name}" is not declared in components.securitySchemes`,
    };
  }
  switch (scheme.type) {
    case "http":
      if (scheme.scheme?.toLowerCase() === "bearer") return bearerCheck(name);
      if (scheme.scheme?.toLowerCase() === "basic") return basicCheck(name);
      return unsupportedSchemeCheck(name, `http "${scheme.scheme ?? "?"}"`, mode);
    case "apiKey":
      return apiKeyCheck(name, scheme);
    case "oauth2":
      return unsupportedSchemeCheck(name, "oauth2", mode);
    case "openIdConnect":
      return unsupportedSchemeCheck(name, "openIdConnect", mode);
    case "mutualTLS":
      return unsupportedSchemeCheck(name, "mutualTLS", mode);
    default:
      return unsupportedSchemeCheck(name, String(scheme.type), mode);
  }
}

function unsupportedSchemeCheck(
  name: string,
  description: string,
  mode: SecurityMode,
): CompiledSchemeCheck {
  // Shape mode: pass. The validator can't shape-check the credential
  // (oauth2, openIdConnect, mutualTLS, HTTP digest/mutual/etc.), so
  // declaring it satisfied avoids spurious 401s. Strict mode: fail,
  // surfacing the gap rather than letting the caller assume coverage.
  if (mode === "shape") return { scheme: name, check: () => null };
  return {
    scheme: name,
    check: () =>
      `scheme "${name}" (${description}) is not shape-checkable; ` +
      `set validateSecurity to "shape" to allow it through, ` +
      `or verify the credential in your auth middleware`,
  };
}

function bearerCheck(name: string): CompiledSchemeCheck {
  return {
    scheme: name,
    check: (req) => {
      const auth = getHeader(req, "authorization", false);
      if (auth === undefined) return `missing "Authorization: Bearer ..." header`;
      if (!/^bearer\s+\S/i.test(auth)) return `"Authorization" is not a Bearer token`;
      return null;
    },
  };
}

function basicCheck(name: string): CompiledSchemeCheck {
  return {
    scheme: name,
    check: (req) => {
      const auth = getHeader(req, "authorization", false);
      if (auth === undefined) return `missing "Authorization: Basic ..." header`;
      const m = /^basic\s+(\S+)$/i.exec(auth);
      if (!m) return `"Authorization" is not a Basic credential`;
      const decoded = tryBase64Decode(m[1]!);
      if (decoded === undefined) return `"Authorization: Basic" value is not valid base64`;
      if (!decoded.includes(":")) return `"Authorization: Basic" is not "user:pass" shape`;
      return null;
    },
  };
}

function apiKeyCheck(name: string, scheme: SecuritySchemeObject): CompiledSchemeCheck {
  const keyName = scheme.name;
  const keyIn = scheme.in;
  if (!keyName || !keyIn) {
    // Malformed scheme definition: emit a failure rather than silently
    // treating every request as passing the check.
    return {
      scheme: name,
      check: () => `apiKey scheme "${name}" is missing required "name" or "in"`,
    };
  }
  const readOwn =
    keyIn === "header"
      ? isHeaderObjectPrototypePropertyName(keyName)
      : isObjectPrototypePropertyName(keyName);
  return {
    scheme: name,
    check: (req) => {
      const v = pickApiKey(req, keyIn, keyName, readOwn);
      if (v === undefined || v === "") return `missing ${keyIn} "${keyName}"`;
      return null;
    },
  };
}

function getHeader(req: HttpRequest, name: string, readOwn: boolean): string | undefined {
  const raw = readOwn ? getHeaderValue(req.headers, name) : getHeaderValueFast(req.headers, name);
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

function pickApiKey(
  req: HttpRequest,
  loc: "header" | "query" | "cookie",
  name: string,
  readOwn: boolean,
): string | undefined {
  // `getHeader` lowercases internally; doing it again here would turn
  // "valueOf" into "valueof" and mask the inherited-member bug rather
  // than fix it.
  if (loc === "header") return getHeader(req, name, readOwn);
  if (loc === "query") {
    const q = readOwn ? getOwn(req.query, name) : req.query?.[name];
    return Array.isArray(q) ? q[0] : q;
  }
  // A credential is one value. A repeated cookie name takes the first
  // crumb, the same answer the query branch above gives.
  const c = readOwn ? getOwn(req.cookies, name) : req.cookies?.[name];
  return Array.isArray(c) ? c[0] : c;
}

function tryBase64Decode(s: string): string | undefined {
  try {
    // `atob` is available in Node 16+ and in every modern browser /
    // runtime; avoid a `Buffer` import to keep this file portable.
    return atob(s);
  } catch {
    return undefined;
  }
}

/**
 * Evaluate a compiled security plan against a request. OR across
 * requirements: the first passing requirement short-circuits to `null`
 * (success). If all fail, returns a single leaf `security` error
 * describing the declared alternatives.
 *
 * @internal
 */
export function checkSecurity(
  compiled: CompiledSecurity,
  req: HttpRequest,
): ValidationError | null {
  const reasons: string[] = [];
  const declared: string[][] = [];
  for (const requirement of compiled) {
    const schemeNames = requirement.schemes.map((s) => s.scheme);
    declared.push(schemeNames);
    const failures: string[] = [];
    for (const s of requirement.schemes) {
      const r = s.check(req);
      if (r !== null) failures.push(`${s.scheme}: ${r}`);
    }
    if (failures.length === 0) return null; // first satisfying alternative wins
    reasons.push(failures.join(" AND "));
  }
  const message =
    declared.length === 1
      ? `request failed security validation (${reasons[0]})`
      : `request failed security validation; no declared alternative matched: ${reasons
          .map((r, i) => `[${i}] ${r}`)
          .join(" | ")}`;
  return createLeafError("security", ["security"], message, { declared });
}

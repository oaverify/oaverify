import type { SchemaLintIssue } from "./compiler.js";

/**
 * The seven type names JSON Schema defines.
 *
 * `assertWellFormedSchema` rejects any other name before a lint runs,
 * so nothing reaching here through `compileSchema` can carry one. The
 * check stays for a direct caller of this function, and because the
 * alternative is treating an unrecognised name as admitting nothing
 * and reporting every member of the enum.
 */
const TYPE_NAMES = new Set(["null", "boolean", "object", "array", "number", "string", "integer"]);

/**
 * Can this value satisfy this type name?
 *
 * `integer` follows JSON Schema rather than JavaScript: `1.0` is an
 * integer, since the spec tests the mathematical value and not how it
 * was written.
 */
function satisfies(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return Array.isArray(value);
    default:
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

/**
 * The type names an instance at this position may take, or `undefined`
 * where they cannot be enumerated and the rule must stay silent.
 *
 * `nullable: true` adds `"null"`, but only where the active dialect
 * treats `nullable` as a keyword. That is OAS 3.0 alone: under 3.1 the
 * key is an unrecognised extension that changes nothing, so honouring
 * it there would suppress a member that really is dead.
 */
function declaredTypes(
  obj: Record<string, unknown>,
  nullableIsKeyword: boolean,
): Set<string> | undefined {
  const declared = obj["type"];
  const names =
    typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : undefined;
  if (names === undefined || names.length === 0) return undefined;
  const types = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || !TYPE_NAMES.has(name)) return undefined;
    types.add(name);
  }
  if (nullableIsKeyword && obj["nullable"] === true) types.add("null");
  return types;
}

/** Keeps a finding readable when an enum member is a large value. */
const MEMBER_ECHO_LIMIT = 40;

function echoMember(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    return "the value";
  }
  return text.length <= MEMBER_ECHO_LIMIT ? text : `${text.slice(0, MEMBER_ECHO_LIMIT)}...`;
}

function at(path: string): string {
  return path === "" ? "<root>" : `"${path}"`;
}

/**
 * Report `enum` members that the sibling `type` can never admit.
 *
 * `type: string` with `enum: [1, 2, 3]` is the shape in the wild: the
 * author wrote the values as they appear in a payload and the type as
 * they think of the field, and no instance can ever select one of those
 * members. Redocly reports it as `no-enum-type-mismatch` and Spectral
 * as `typed-enum`.
 *
 * **The claim is about the member, not the position.** A partial
 * mismatch (`type: string`, `enum: ["a", 2]`) leaves the position
 * perfectly satisfiable by `"a"`, and only `2` is dead. So this rule
 * names the dead members and their indices, and says separately when
 * every member is dead, which is the case where the position itself
 * cannot be satisfied. Reporting the whole enum for one bad member
 * would be the kind of over-report #503 spent two rewrites removing.
 *
 * Silent, rather than widened, wherever the answer is not provable:
 *
 * - No `type`. Nothing constrains the members, so nothing is dead.
 * - `nullable: true` under OAS 3.0, where `enum: ["a", null]` beside
 *   `type: string` is valid and Redocly's equivalent rule reports it
 *   anyway. Under 3.1 `nullable` is inert and the `null` member really
 *   is dead, so the same input is reported there and not here.
 *
 * @internal
 */
export function collectEnumTypeIssue(
  obj: Record<string, unknown>,
  path: string,
  nullableIsKeyword: boolean,
): SchemaLintIssue | undefined {
  const members = obj["enum"];
  if (!Array.isArray(members) || members.length === 0) return undefined;

  const types = declaredTypes(obj, nullableIsKeyword);
  if (types === undefined) return undefined;

  const dead: number[] = [];
  for (let i = 0; i < members.length; i += 1) {
    let ok = false;
    for (const type of types) {
      if (satisfies(members[i], type)) {
        ok = true;
        break;
      }
    }
    if (!ok) dead.push(i);
  }
  if (dead.length === 0) return undefined;

  const named = [...types].join(" or ");
  const listed = dead.map((i) => `[${i}] ${echoMember(members[i])}`).join(", ");
  const all = dead.length === members.length;
  const tail = all
    ? "; every member is dead, so no value validates here"
    : dead.length === 1
      ? "; that member can never be selected"
      : "; those members can never be selected";

  return {
    code: "unsatisfiable/enum-member-type",
    keyword: "enum",
    path,
    message: `"enum" at ${at(path)} has ${dead.length === 1 ? "a member" : `${dead.length} members`} that "type": ${named} can never admit: ${listed}${tail}`,
  };
}

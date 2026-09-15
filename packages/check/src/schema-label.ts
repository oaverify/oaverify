import {
  HTTP_METHODS,
  detectOpenAPIVersion,
  escapePointerSegment,
  followsRef,
  pointerFromRefFragment,
  refPositionFor,
  resolveJsonPointer,
  type RefNodeKind,
  type OpenAPIDocument,
} from "@oaverify/internal-core";

/** Render an authored schema entry in its enclosing operation's vocabulary. */
function schemaLabel(
  document: OpenAPIDocument,
  pointer: string,
  parameterPointer = pointer,
): string {
  const parts = pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let itemAt: number;
  if (parts[0] === "paths" || parts[0] === "webhooks") itemAt = 2;
  else if (parts[0] === "components" && parts[1] === "pathItems") itemAt = 3;
  else if (parts[0] === "components" && parts[1] === "callbacks") itemAt = 4;
  else return pointer;

  let operation = parts[itemAt - 1]!;
  let tailAt = itemAt;
  while (itemAt < parts.length) {
    const field = parts[itemAt]!;
    if (HTTP_METHODS.some((method) => method === field)) {
      operation = `${field.toUpperCase()} ${parts[itemAt - 1]}`;
      tailAt = itemAt + 1;
    } else if (field === "additionalOperations" && parts[itemAt + 1] !== undefined) {
      operation = `${parts[itemAt + 1]} ${parts[itemAt - 1]}`;
      tailAt = itemAt + 2;
    } else break;
    if (parts[tailAt] !== "callbacks") break;
    itemAt = tailAt + 3;
  }

  const tail = parts.slice(tailAt);
  if (tail[0] === "parameters") {
    let parameter: unknown;
    try {
      parameter = resolveJsonPointer(
        document,
        parameterPointer
          .split("/")
          .slice(0, -(tail.length - 2))
          .join("/"),
      );
    } catch {
      return pointer;
    }
    if (
      typeof parameter === "object" &&
      parameter !== null &&
      "in" in parameter &&
      "name" in parameter
    )
      return `${operation} ${String(parameter.in)} parameter "${String(parameter.name)}"`;
  }
  if (tail[0] === "requestBody" && tail[1] === "content" && tail[3] === "schema")
    return `${operation} request body (${tail[2]})`;
  if (tail[0] === "responses") {
    if (tail[2] === "content" && tail[4] === "schema")
      return `${operation} ${tail[1]} response body (${tail[3]})`;
    if (tail[2] === "headers") return `${operation} ${tail[1]} response header "${tail[3]}"`;
  }
  return pointer;
}

/** Prefer the first operation using a referenced document object; unused entries keep their pointer. */
export function schemaLabeler(document: OpenAPIDocument): (pointer: string) => string {
  const version = detectOpenAPIVersion(document);
  if (version === undefined) return (pointer) => schemaLabel(document, pointer);
  const aliases = new Map<string, string>();
  const seen = new Set<object>();
  const walk = (value: unknown, kind: RefNodeKind, pointer: string, refable = false): void => {
    if (
      kind === "schema" ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      seen.has(value)
    )
      return;
    seen.add(value);
    const node = value as Record<string, unknown>;
    if (followsRef(kind, refable) && typeof node.$ref === "string") {
      const targetPointer = pointerFromRefFragment(node.$ref);
      if (targetPointer !== undefined) {
        try {
          const target = resolveJsonPointer(document, targetPointer);
          if (target !== undefined) {
            if (!aliases.has(targetPointer)) aliases.set(targetPointer, pointer);
            walk(target, kind, pointer, refable);
          }
        } catch {
          // Reference diagnostics belong to the checker; a label is optional.
        }
      }
    }
    // Served uses establish the first label even if components were authored first.
    const entries = Object.entries(node).sort(
      ([a], [b]) => Number(a === "components") - Number(b === "components"),
    );
    for (const [key, child] of entries) {
      const position = refPositionFor(version, kind, key);
      if (position === undefined) continue;
      const at = `${pointer}/${escapePointerSegment(key)}`;
      if (position.arity === "one") walk(child, position.kind, at, position.refable);
      else if (typeof child === "object" && child !== null) {
        for (const [name, entry] of Object.entries(child))
          walk(entry, position.kind, `${at}/${escapePointerSegment(name)}`, position.refable);
      }
    }
  };
  walk(document, "document", "");
  return (pointer) => {
    let prefix = pointer;
    while (prefix !== "") {
      const alias = aliases.get(prefix);
      if (alias !== undefined)
        return schemaLabel(document, `${alias}${pointer.slice(prefix.length)}`, pointer);
      prefix = prefix.slice(0, prefix.lastIndexOf("/"));
    }
    return schemaLabel(document, pointer);
  };
}

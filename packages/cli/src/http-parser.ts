import type { HttpRequest, JsonValue } from "@oaverify/internal-core";

/**
 * Parse a string in the standard `.http` file format (method/path line,
 * headers, blank line, body) into an {@link HttpRequest}.
 *
 * @param text - Raw contents of the .http file.
 * @returns An {@link HttpRequest} ready for the validator.
 *
 * @example
 * ```ts
 * parseHttpFile(`POST /pets?limit=10 HTTP/1.1
 * Content-Type: application/json
 *
 * {"name":"Fido"}`);
 * ```
 *
 * @public
 */
export function parseHttpFile(text: string): HttpRequest {
  const normalized = text.replace(/\r\n/g, "\n");
  const blankIdx = normalized.indexOf("\n\n");
  const headerPart = blankIdx === -1 ? normalized : normalized.slice(0, blankIdx);
  const bodyPart = blankIdx === -1 ? "" : normalized.slice(blankIdx + 2);
  const lines = headerPart.split("\n");
  const requestLine = lines.shift() ?? "";
  const match = /^(\S+)\s+(\S+)(?:\s+HTTP\/\S+)?$/.exec(requestLine.trim());
  if (!match) throw new Error(`invalid request line: "${requestLine}"`);
  const method = (match[1] ?? "").toUpperCase();
  const fullPath = match[2] ?? "/";
  const [path, queryString = ""] = fullPath.split("?") as [string, string | undefined];
  const query: Record<string, string | string[]> = {};
  if (queryString !== "") {
    const pairs = queryString.split("&");
    for (const pair of pairs) {
      const [rawKey, rawValue = ""] = pair.split("=");
      if (rawKey === undefined || rawKey === "") continue;
      const key = decodeURIComponent(rawKey);
      const value = decodeURIComponent(rawValue);
      const prev = query[key];
      if (prev === undefined) query[key] = value;
      else if (Array.isArray(prev)) prev.push(value);
      else query[key] = [prev, value];
    }
  }
  const headers: Record<string, string | string[]> = {};
  let contentType: string | undefined;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "content-type") contentType = value;
    const prev = headers[key];
    if (prev === undefined) headers[key] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else headers[key] = [prev, value];
  }
  const bodyText = bodyPart.trim();
  let body: JsonValue | undefined;
  const rawBody: string | undefined = bodyText.length > 0 ? bodyText : undefined;
  if (bodyText.length > 0) {
    if (contentType?.includes("json") || bodyText.startsWith("{") || bodyText.startsWith("[")) {
      try {
        body = JSON.parse(bodyText) as JsonValue;
      } catch {
        body = bodyText;
      }
    } else {
      body = bodyText;
    }
  }
  return { method, path, query, headers, contentType, body, rawBody };
}

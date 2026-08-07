import { setSpecKey, type HttpRequest, type JsonValue } from "@oaverify/internal-core";

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
  // Everything after the first "?" is the query; RFC 3986 allows more
  // "?" inside it, so splitting on every one dropped query text.
  const qIdx = fullPath.indexOf("?");
  const path = qIdx === -1 ? fullPath : fullPath.slice(0, qIdx);
  const queryString = qIdx === -1 ? "" : fullPath.slice(qIdx + 1);
  const query: Record<string, string | string[]> = {};
  if (queryString !== "") {
    // URLSearchParams is what the fetch adapter parses with, so one
    // request text means one query whichever door it comes in through.
    // The hand-rolled loop this replaces truncated values at a second
    // "=", left "+" undecoded, and threw on a malformed escape.
    const params = new URLSearchParams(queryString);
    for (const key of new Set(params.keys())) {
      if (key === "") continue;
      const values = params.getAll(key);
      setSpecKey(query, key, values.length === 1 ? (values[0] ?? "") : values);
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
    const mediaType = (contentType?.split(";")[0] ?? "").trim().toLowerCase();
    const declaredJson = mediaType === "application/json" || mediaType.endsWith("+json");
    if (declaredJson) {
      // A declared-JSON body that does not parse is a defect in the
      // file, and the author wants to hear about the typo. The silent
      // string fallback validated the broken text against the JSON
      // schema, producing a type error that pointed everywhere except
      // the missing brace.
      try {
        body = JSON.parse(bodyText) as JsonValue;
      } catch (err) {
        throw new Error(
          `request body is not valid JSON (Content-Type ${contentType}): ${(err as Error).message}`,
          { cause: err },
        );
      }
    } else if (bodyText.startsWith("{") || bodyText.startsWith("[")) {
      // No declared type; the brace is a guess, so a parse failure
      // falls back to the raw string rather than rejecting the file.
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

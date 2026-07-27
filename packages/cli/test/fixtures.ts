import { createMemoryReader, type DocumentReader } from "@oaverify/internal-spec";
import type { CommandIo } from "../src/commands.js";

/**
 * Shared helpers for the CLI test suite. The two callers
 * (`cli.test.ts` argv coverage, `commands.test.ts` in-process coverage)
 * both need a `CommandIo` wired to in-memory documents, text files, and
 * capture buffers for stdout / stderr / file writes, factored out
 * here so the helpers can't drift.
 */

export interface MemoryIo {
  io: CommandIo;
  /** `-o FILE` writes land here as `[path, content]` pairs. */
  writes: Array<[string, string]>;
  /** Captured stdout payload (concatenated, in write order). */
  stdout: { value: string };
  /** Captured stderr payload (concatenated, in write order). */
  stderr: { value: string };
  textMap: Map<string, string>;
}

export function memoryIo(
  entries: Array<[string, unknown]>,
  textFiles: Array<[string, string]> = [],
): MemoryIo {
  const reader: DocumentReader = createMemoryReader(new Map(entries));
  const textMap = new Map(textFiles);
  const writes: Array<[string, string]> = [];
  const stdout = { value: "" };
  const stderr = { value: "" };
  return {
    io: {
      reader,
      async readText(path: string) {
        const hit = textMap.get(path);
        if (hit === undefined) throw new Error(`missing text file: ${path}`);
        return hit;
      },
      async writeText(path: string, content: string) {
        writes.push([path, content]);
      },
      stdout: (chunk: string) => {
        stdout.value += chunk;
      },
      stderr: (chunk: string) => {
        stderr.value += chunk;
      },
    },
    writes,
    stdout,
    stderr,
    textMap,
  };
}

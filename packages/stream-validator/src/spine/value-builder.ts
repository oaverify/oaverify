/**
 * Builds a JS value from tokenizer events, for BUFFER islands: a subtree
 * the classifier marked non-streamable is materialized here and handed to
 * the in-memory validator. The builder tracks container depth so the
 * driver knows when the island's top-level value is complete.
 *
 * @packageDocumentation
 */

import { setSpecKey } from "@oaverify/internal-core";
import type { JsonEventHandler } from "../tokenizer/index.js";

/**
 * A {@link JsonEventHandler} that reconstructs a JS value. After the
 * top-level value completes, {@link ValueBuilder.complete} is `true` and
 * {@link ValueBuilder.value} holds it.
 */
export class ValueBuilder implements JsonEventHandler {
  private stack: Array<{ container: unknown; key: string | null }> = [];
  private root: unknown = undefined;
  private started = false;
  private depth = 0;
  private inString = false;
  private curString = "";

  /** The materialized value (meaningful once {@link complete}). */
  get value(): unknown {
    return this.root;
  }

  /** True once the top-level value has finished. */
  get complete(): boolean {
    return this.started && this.depth === 0 && !this.inString;
  }

  private add(v: unknown): void {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      this.root = v;
      return;
    }
    if (Array.isArray(top.container)) top.container.push(v);
    else setSpecKey(top.container as Record<string, unknown>, top.key as string, v);
  }

  onStartObject(): void {
    this.started = true;
    this.depth += 1;
    const c = {};
    this.add(c);
    this.stack.push({ container: c, key: null });
  }
  onEndObject(): void {
    this.depth -= 1;
    this.stack.pop();
  }
  onStartArray(): void {
    this.started = true;
    this.depth += 1;
    const c: unknown[] = [];
    this.add(c);
    this.stack.push({ container: c, key: null });
  }
  onEndArray(): void {
    this.depth -= 1;
    this.stack.pop();
  }
  onKey(value: string): void {
    const top = this.stack[this.stack.length - 1];
    if (top !== undefined) top.key = value;
  }
  onStringStart(): void {
    this.started = true;
    this.inString = true;
    this.curString = "";
  }
  onStringChunk(chunk: string): void {
    this.curString += chunk;
  }
  onStringEnd(): void {
    this.inString = false;
    this.add(this.curString);
  }
  onNumber(value: number): void {
    this.started = true;
    this.add(value);
  }
  onBoolean(value: boolean): void {
    this.started = true;
    this.add(value);
  }
  onNull(): void {
    this.started = true;
    this.add(null);
  }
}

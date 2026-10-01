/**
 * An input key exceeded `StreamValidatorOptions.maxKeyBytes`. Fatal during
 * active validation, independent of the schema and validation error budget.
 * No incomplete key text or instance path is attached.
 *
 * @public
 */
export class KeyLimitError extends Error {
  /** Configured allowance in original input bytes, including quotes and escapes. */
  readonly limit: number;
  /** Absolute input offset of the first refused byte. */
  readonly byteOffset: number;
  /** Absolute input offset of the key's opening quote. */
  readonly keyStart: number;

  constructor(limit: number, byteOffset: number, keyStart: number) {
    super(`input key exceeded maxKeyBytes=${limit} (at byte ${byteOffset})`);
    this.name = "KeyLimitError";
    this.limit = limit;
    this.byteOffset = byteOffset;
    this.keyStart = keyStart;
  }
}

/**
 * An input number exceeded `StreamValidatorOptions.maxNumberBytes`. Fatal
 * during active validation, independent of numeric magnitude or schema.
 * No partial number text or instance path is attached.
 *
 * @public
 */
export class NumberLimitError extends Error {
  /** Configured allowance in original number-token bytes, excluding its terminator. */
  readonly limit: number;
  /** Absolute input offset of the first refused byte continuing the number. */
  readonly byteOffset: number;
  /** Absolute input offset of the minus sign or first digit. */
  readonly numberStart: number;

  constructor(limit: number, byteOffset: number, numberStart: number) {
    super(`input number exceeded maxNumberBytes=${limit} (at byte ${byteOffset})`);
    this.name = "NumberLimitError";
    this.limit = limit;
    this.byteOffset = byteOffset;
    this.numberStart = numberStart;
  }
}

/** Validate a token policy before parsing any input. */
export function tokenByteLimit(name: string, value: number | undefined): number {
  if (value === undefined || value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer or Infinity`);
  }
  return value;
}

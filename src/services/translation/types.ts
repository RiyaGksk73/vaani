/**
 * Shared contracts for the translation layer.
 *
 * Nothing in this file imports a provider. Providers depend on these types,
 * `translator.ts` depends on these types, and the two never see each other -
 * which is what lets a second provider be added without touching callers.
 */

import type { LanguageCode } from "./languages";

export type { LanguageCode };

/** Formality/register knob. Only `formal` is supported by sarvam-translate:v1. */
export type TranslationMode =
  | "formal"
  | "modern-colloquial"
  | "classic-colloquial"
  | "code-mixed";

export type SpeakerGender = "Male" | "Female";

/** A single unit of text handed to a provider. Already masked and chunked. */
export interface ProviderRequest {
  text: string;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  mode?: TranslationMode;
  speakerGender?: SpeakerGender;
  /** Provider-specific escape hatch; ignored by providers that do not use it. */
  options?: Record<string, unknown>;
}

export interface ProviderResult {
  text: string;
  provider: string;
  model: string;
  /** Wall-clock time of the underlying HTTP call, for cost/throughput logging. */
  latencyMs: number;
}

/**
 * The one interface a provider has to satisfy.
 *
 * `maxInputChars` lets the caller chunk correctly per provider without
 * hardcoding any provider's limit. `supports` lets the router skip a provider
 * that cannot serve a language pair instead of discovering it via a 400.
 */
export interface TranslationProvider {
  readonly name: string;
  readonly model: string;
  readonly maxInputChars: number;
  supports(source: LanguageCode, target: LanguageCode): boolean;
  translate(request: ProviderRequest): Promise<ProviderResult>;
}

/**
 * Errors carry `retryable` so the worker can tell a rate limit (back off and
 * try again) from a malformed request (park the row, stop burning quota).
 */
export class TranslationError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly provider?: string;

  constructor(
    message: string,
    opts: { retryable?: boolean; status?: number; provider?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "TranslationError";
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.provider = opts.provider;
  }
}

export class UnsupportedLanguagePairError extends TranslationError {
  constructor(source: string, target: string) {
    super(
      `No configured provider translates ${source} -> ${target}. ` +
        `Sarvam covers English and the 22 scheduled Indian languages; ` +
        `add a provider in translator.ts to widen this.`,
      { retryable: false },
    );
    this.name = "UnsupportedLanguagePairError";
  }
}

// ---------------------------------------------------------------------------
// Caller-facing shapes
// ---------------------------------------------------------------------------

/** One script row on its way to being translated. */
export interface ScriptSegment {
  /** script_rows.id - echoed back so results can be matched to rows. */
  id: number;
  /** Never translated. Reattached verbatim to the output. */
  characterName?: string | null;
  sourceText: string;
}

export type TranslationOutcome = "translated" | "memory" | "skipped" | "failed";

export interface SegmentTranslation {
  id: number;
  outcome: TranslationOutcome;
  translatedText: string | null;
  /** Set when the result came out of translation memory. */
  memoryId?: number;
  provider?: string;
  model?: string;
  error?: string;
}

export interface TranslateBatchOptions {
  orgId: string;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  mode?: TranslationMode;
  /** Max concurrent provider calls. Tune to your plan's rate limit. */
  concurrency?: number;
  /** Set false to bypass the cache (e.g. a forced re-translation). */
  useMemory?: boolean;
  /** Called after each segment settles, for progress reporting. */
  onProgress?: (done: number, total: number) => void;
}

export interface BatchStats {
  total: number;
  translated: number;
  fromMemory: number;
  skipped: number;
  failed: number;
  providerCalls: number;
}

/**
 * Sarvam AI provider.
 *
 * POST {base}/translate
 *   headers: api-subscription-key, content-type: application/json
 *   body:    { input, source_language_code, target_language_code, model, ... }
 *   200:     { request_id, translated_text, source_language_code }
 *
 * The endpoint takes one `input` per call - there is no multi-input batch
 * form - so throughput comes from concurrency, not from packing. See
 * translator.ts.
 */

import { retry } from "@/lib/retry";
import { isMayuraLanguage, isLanguageCode } from "./languages";
import {
  TranslationError,
  type LanguageCode,
  type ProviderRequest,
  type ProviderResult,
  type TranslationProvider,
} from "./types";

export type SarvamModel = "sarvam-translate:v1" | "mayura:v1";

export interface SarvamConfig {
  apiKey: string;
  baseUrl?: string;
  model?: SarvamModel;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Attempts per call, including the first. */
  attempts?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Documented input ceilings. Exceeding them is a 400, so translator.ts chunks
 * against `maxInputChars` before calling.
 */
const MAX_INPUT_CHARS: Record<SarvamModel, number> = {
  "sarvam-translate:v1": 2000,
  "mayura:v1": 1000,
};

interface SarvamTranslateResponse {
  request_id?: string;
  translated_text?: string;
  source_language_code?: string;
}

export class SarvamProvider implements TranslationProvider {
  readonly name = "sarvam";
  readonly model: SarvamModel;
  readonly maxInputChars: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SarvamConfig) {
    if (!config.apiKey) {
      throw new TranslationError("SARVAM_API_KEY is not set", { provider: "sarvam" });
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.sarvam.ai").replace(/\/+$/, "");
    this.model = config.model ?? "sarvam-translate:v1";
    this.maxInputChars = MAX_INPUT_CHARS[this.model];
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.attempts = config.attempts ?? 3;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /**
   * sarvam-translate:v1 covers English + all 22 scheduled Indian languages.
   * mayura:v1 covers 12 of them but adds colloquial modes and transliteration.
   */
  supports(source: LanguageCode, target: LanguageCode): boolean {
    if (source === target) return false;
    if (!isLanguageCode(source) || !isLanguageCode(target)) return false;
    if (this.model === "mayura:v1") {
      return isMayuraLanguage(source) && isMayuraLanguage(target);
    }
    return true;
  }

  async translate(request: ProviderRequest): Promise<ProviderResult> {
    const { text, sourceLanguage, targetLanguage } = request;

    if (text.length > this.maxInputChars) {
      throw new TranslationError(
        `Input of ${text.length} chars exceeds the ${this.maxInputChars}-char limit for ${this.model}`,
        { provider: this.name },
      );
    }

    const body: Record<string, unknown> = {
      input: text,
      source_language_code: sourceLanguage,
      target_language_code: targetLanguage,
      model: this.model,
      // Keep digits as-is; native numerals would break IDs, timecodes and
      // anything the script counts on staying machine-readable.
      numerals_format: "international",
      ...request.options,
    };

    // mayura:v1 is the only model with register control and transliteration.
    if (this.model === "mayura:v1") {
      body.mode = request.mode ?? "formal";
      if (request.speakerGender) body.speaker_gender = request.speakerGender;
    }

    const started = Date.now();

    const translated = await retry(() => this.call(body), {
      attempts: this.attempts,
      baseDelayMs: 700,
      maxDelayMs: 30_000,
      isRetryable: (error) => error instanceof TranslationError && error.retryable,
      retryAfterMs: (error) =>
        error instanceof SarvamHttpError ? error.retryAfterMs : undefined,
    });

    return {
      text: translated,
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }

  private async call(body: Record<string, unknown>): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/translate`, {
        method: "POST",
        headers: {
          "api-subscription-key": this.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      // Network failure or timeout - both are worth another go.
      const aborted = cause instanceof Error && cause.name === "AbortError";
      throw new TranslationError(
        aborted ? `Sarvam request timed out after ${this.timeoutMs}ms` : "Sarvam request failed",
        { retryable: true, provider: this.name, cause },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw await SarvamHttpError.fromResponse(response);
    }

    let payload: SarvamTranslateResponse;
    try {
      payload = (await response.json()) as SarvamTranslateResponse;
    } catch (cause) {
      throw new TranslationError("Sarvam returned a non-JSON response", {
        retryable: true,
        provider: this.name,
        cause,
      });
    }

    if (typeof payload.translated_text !== "string") {
      throw new TranslationError("Sarvam response had no translated_text", {
        retryable: false,
        provider: this.name,
      });
    }

    return payload.translated_text;
  }
}

/**
 * 429 and 5xx are transient; 4xx is a request we built wrong and will keep
 * building wrong, so retrying it only burns quota.
 */
class SarvamHttpError extends TranslationError {
  readonly retryAfterMs?: number;

  private constructor(message: string, status: number, retryAfterMs?: number) {
    super(message, {
      status,
      retryable: status === 429 || status === 408 || status >= 500,
      provider: "sarvam",
    });
    this.name = "SarvamHttpError";
    this.retryAfterMs = retryAfterMs;
  }

  static async fromResponse(response: Response): Promise<SarvamHttpError> {
    const detail = (await response.text().catch(() => "")).slice(0, 500);

    const header = response.headers.get("retry-after");
    let retryAfterMs: number | undefined;
    if (header) {
      const seconds = Number(header);
      retryAfterMs = Number.isFinite(seconds)
        ? seconds * 1000
        : Math.max(0, new Date(header).getTime() - Date.now()) || undefined;
    }

    const hint =
      response.status === 401 || response.status === 403
        ? " (check SARVAM_API_KEY)"
        : response.status === 429
          ? " (rate limited - lower TRANSLATION_CONCURRENCY)"
          : "";

    return new SarvamHttpError(
      `Sarvam ${response.status} ${response.statusText}${hint}${detail ? `: ${detail}` : ""}`,
      response.status,
      retryAfterMs,
    );
  }
}

export { SarvamHttpError };

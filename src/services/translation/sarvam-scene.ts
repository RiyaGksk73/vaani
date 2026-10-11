/**
 * Scene-level translation through Sarvam's chat model.
 *
 * sarvam-translate:v1 sees one line at a time and nothing else, so it cannot
 * know who "he" is or who is speaking. Hindi (and most Indic languages) mark
 * gender on the verb, which made it guess - and against a real script it
 * guessed wrong often: "He smiles." came back as "वह मुस्कुराती है"
 * (feminine), and a male speaker's "I've been meaning to tell you" came back
 * as "चाह रही थी". Idioms suffered too: "cheesy" became "घटिया" (lousy).
 *
 * The chat model takes a whole run of script lines with their speakers, so
 * gender, register and running context come from the scene itself. It only
 * ever sees line bodies that preserve.ts has already masked and split, and
 * every result is verified line by line by the caller - anything that does not
 * come back intact falls through to the line-level provider.
 */

import { retry } from "@/lib/retry";
import { languageLabel } from "./languages";
import { TranslationError, type LanguageCode } from "./types";
import { SarvamHttpError } from "./sarvam";

export interface SceneLine {
  /** Opaque key echoed back so results can be matched. */
  key: string;
  /** Who says it; absent for narration, stage directions and captions. */
  speaker?: string;
  /** Already masked: sentinels such as #0# stand in for placeholders. */
  text: string;
}

export interface SceneTranslatorConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** A scene of ~40 lines takes 20-40s with reasoning on; leave headroom. */
  timeoutMs?: number;
  attempts?: number;
  fetchImpl?: typeof fetch;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
}

export class SarvamSceneTranslator {
  readonly name = "sarvam";
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SceneTranslatorConfig) {
    if (!config.apiKey) {
      throw new TranslationError("SARVAM_API_KEY is not set", { provider: "sarvam" });
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://api.sarvam.ai").replace(/\/+$/, "");
    this.model = config.model ?? "sarvam-105b";
    this.timeoutMs = config.timeoutMs ?? 240_000;
    this.attempts = config.attempts ?? 2;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /**
   * Translate a run of lines in one request. Returns whatever keys came back;
   * the caller treats a missing key as a miss and retries that line alone.
   */
  async translateScene(
    lines: readonly SceneLine[],
    source: LanguageCode,
    target: LanguageCode,
  ): Promise<Map<string, string>> {
    if (lines.length === 0) return new Map();

    const system = [
      `You are a professional localiser for comics, animation and dubbing scripts.`,
      `Translate each line from ${languageLabel(source)} into natural, conversational ${languageLabel(target)} that a dubbing artist could perform.`,
      `Rules:`,
      `- Read the whole scene first. Work out every character's gender from names, pronouns (he/she) and labels such as "Him"/"Her", and keep verb, adjective and pronoun agreement correct and consistent in every line.`,
      `- "speaker" is context only. Never translate it and never include it in your output.`,
      `- Translate meaning and tone, not word for word. Keep idioms, slang and emotion natural for the target audience.`,
      `- Translate every line completely. Do not summarise, merge, split, skip or add lines.`,
      `- Copy tokens like #0#, #1#, ((0)) exactly as written. Keep Markdown such as ** and quotation marks where they appear.`,
      `- Write the target language in its native script.`,
      `Return ONLY a JSON object mapping each line's "id" to its translation, e.g. {"a": "...", "b": "..."}.`,
    ].join("\n");

    const payload = lines.map((l) => (l.speaker ? { id: l.key, speaker: l.speaker, text: l.text } : { id: l.key, text: l.text }));

    const content = await retry(() => this.call(system, JSON.stringify(payload, null, 1)), {
      attempts: this.attempts,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      isRetryable: (error) => error instanceof TranslationError && error.retryable,
      retryAfterMs: (error) => (error instanceof SarvamHttpError ? error.retryAfterMs : undefined),
    });

    const parsed = parseJsonObject(content);
    const out = new Map<string, string>();
    for (const line of lines) {
      const value = parsed[line.key];
      if (typeof value === "string" && value.trim()) out.set(line.key, value.trim());
    }
    return out;
  }

  private async call(system: string, user: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "api-subscription-key": this.apiKey,
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          reasoning_effort: "low",
          // The model reasons before answering and the reasoning counts here;
          // too small a budget returns an empty answer with finish_reason=length.
          max_tokens: 24_000,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "AbortError";
      throw new TranslationError(
        aborted ? `Sarvam chat timed out after ${this.timeoutMs}ms` : "Sarvam chat request failed",
        { retryable: true, provider: this.name, cause },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw await SarvamHttpError.fromResponse(response);

    const json = (await response.json().catch(() => null)) as ChatResponse | null;
    const choice = json?.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      throw new TranslationError(
        `Sarvam chat returned no answer (finish_reason=${choice?.finish_reason ?? "unknown"})`,
        { retryable: true, provider: this.name },
      );
    }
    return content;
  }
}

/** Pull the JSON object out of a reply that may be fenced or carry a <think> block. */
export function parseJsonObject(content: string): Record<string, unknown> {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = withoutThinking.indexOf("{");
  const end = withoutThinking.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new TranslationError("Sarvam chat reply held no JSON object", {
      retryable: true,
      provider: "sarvam",
    });
  }
  try {
    const value = JSON.parse(withoutThinking.slice(start, end + 1));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new TranslationError("Sarvam chat reply was not valid JSON", {
    retryable: true,
    provider: "sarvam",
  });
}

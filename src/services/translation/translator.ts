/**
 * The provider layer.
 *
 * Callers ask the Translator for a language pair; the Translator picks a
 * provider that serves it. Adding Gemini, OpenAI or Claude later means writing
 * one class that satisfies `TranslationProvider` and registering it here -
 * no caller changes, no branching at the call sites.
 *
 * Today only Sarvam is registered, which bounds the product to English and the
 * 22 scheduled Indian languages. `resolve()` throws a specific error for
 * anything else rather than failing deep inside an HTTP call.
 */

import { mapWithConcurrency } from "@/lib/retry";
import { languageLabel } from "./languages";
import { memoryHash, noMemory, type MemoryPort, type NewMemoryEntry } from "./memory";
import {
  PLACEHOLDER_STYLE_COUNT,
  chunkText,
  hasTranslatableContent,
  joinLine,
  joinLines,
  missingTokens,
  protect,
  restore,
  speakerName,
  splitLine,
  splitLines,
  type LineParts,
  type Placeholder,
} from "./preserve";
import { SarvamProvider, type SarvamModel } from "./sarvam";
import { SarvamSceneTranslator, type SceneLine } from "./sarvam-scene";
import {
  TranslationError,
  UnsupportedLanguagePairError,
  type BatchStats,
  type LanguageCode,
  type ScriptSegment,
  type SegmentTranslation,
  type TranslateBatchOptions,
  type TranslationMode,
  type TranslationProvider,
} from "./types";

export interface TranslateTextOptions {
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  mode?: TranslationMode;
  /** Exact character names from the episode, so speaker prefixes are not guessed. */
  knownCharacters?: ReadonlySet<string>;
}

export interface TranslateTextResult {
  text: string;
  provider: string;
  model: string;
  /** Provider round-trips this row cost. Zero means everything was skippable. */
  calls: number;
}

export class Translator {
  private readonly providers: TranslationProvider[] = [];
  /** Optional context-aware first pass for batches; see sarvam-scene.ts. */
  private readonly scene?: SarvamSceneTranslator;

  constructor(
    providers: readonly TranslationProvider[] = [],
    options: { scene?: SarvamSceneTranslator } = {},
  ) {
    for (const provider of providers) this.register(provider);
    this.scene = options.scene;
  }

  /** Registration order is preference order. */
  register(provider: TranslationProvider): this {
    this.providers.push(provider);
    return this;
  }

  list(): readonly TranslationProvider[] {
    return this.providers;
  }

  resolve(source: LanguageCode, target: LanguageCode): TranslationProvider {
    const provider = this.providers.find((p) => p.supports(source, target));
    if (!provider) {
      throw new UnsupportedLanguagePairError(languageLabel(source), languageLabel(target));
    }
    return provider;
  }

  canTranslate(source: LanguageCode, target: LanguageCode): boolean {
    return this.providers.some((p) => p.supports(source, target));
  }

  // -------------------------------------------------------------------------
  // Single row
  // -------------------------------------------------------------------------

  /**
   * Translate one script row, preserving its structure.
   *
   * The row is decomposed into lines, each line into (marker, speaker, body),
   * and only the body is ever sent. Placeholders inside the body are masked
   * and verified on the way back. If a sentinel does not survive, the line is
   * retried with a different sentinel shape; if it still does not survive we
   * throw rather than return text with a broken placeholder.
   */
  async translateText(
    text: string,
    options: TranslateTextOptions,
  ): Promise<TranslateTextResult> {
    const provider = this.resolve(options.sourceLanguage, options.targetLanguage);
    const { lines, separators } = splitLines(text);
    let calls = 0;

    const translatedLines: string[] = [];

    for (const line of lines) {
      const { text: translated, calls: used } = await this.translateLine(
        line,
        provider,
        options,
      );
      calls += used;
      translatedLines.push(translated);
    }

    return {
      text: joinLines(translatedLines, separators),
      provider: provider.name,
      model: provider.model,
      calls,
    };
  }

  /**
   * Translate one line.
   *
   * Order matters: placeholders are masked across the WHOLE line before the
   * speaker prefix is split off. A stage cue like "[SFX: door creaks]" holds a
   * colon, and splitting first would read "[SFX" as the speaker and send
   * "door creaks]" off to be translated - which is exactly what happened
   * against the live API before this was reordered. Masking first turns the
   * cue into a single opaque token, so there is no colon left to trip on.
   */
  private async translateLine(
    line: string,
    provider: TranslationProvider,
    options: TranslateTextOptions,
  ): Promise<{ text: string; calls: number }> {
    let calls = 0;
    let lastMissing: string[] = [];

    for (let style = 0; style < PLACEHOLDER_STYLE_COUNT; style++) {
      const { masked, placeholders } = protect(line, style);
      const parts = splitLine(masked, options.knownCharacters);

      if (!hasTranslatableContent(parts.body)) {
        // Blank lines, "...", "---", a line that is only a stage cue: nothing
        // to translate, nothing to pay for.
        return { text: line, calls };
      }

      const chunks = chunkText(parts.body, provider.maxInputChars);
      const outputs: string[] = [];

      for (const chunk of chunks) {
        if (!hasTranslatableContent(chunk)) {
          outputs.push(chunk);
          continue;
        }
        const result = await provider.translate({
          text: chunk,
          sourceLanguage: options.sourceLanguage,
          targetLanguage: options.targetLanguage,
          mode: options.mode,
        });
        calls += 1;
        outputs.push(result.text);
      }

      // Chunk boundaries are sentence boundaries, so a single space rejoins
      // them cleanly even if the model trimmed its own output.
      const body = outputs.map((o) => o.trim()).filter(Boolean).join(" ");
      const rebuilt = joinLine(parts, body);

      if (placeholders.length === 0) {
        return { text: rebuilt, calls };
      }

      lastMissing = missingTokens(rebuilt, placeholders);
      if (lastMissing.length === 0) {
        return { text: restore(rebuilt, placeholders), calls };
      }
      // Otherwise fall through and retry with the next sentinel shape.
    }

    throw new TranslationError(
      `Placeholders did not survive translation (${lastMissing.join(", ")}). ` +
        `Row parked for manual localisation rather than shipping broken markup.`,
      { retryable: false, provider: provider.name },
    );
  }

  // -------------------------------------------------------------------------
  // Batch
  // -------------------------------------------------------------------------

  /**
   * Translate many rows, deduplicating aggressively.
   *
   * Two layers of savings before anything is sent:
   *   1. Rows that normalise to the same source text collapse to one call,
   *      even when the cache is cold.
   *   2. Whatever remains is looked up in translation memory first.
   *
   * Sarvam's /translate accepts a single `input` per call, so what is left
   * after deduplication is issued as bounded-concurrency parallel requests
   * rather than one packed payload.
   */
  async translateBatch(
    segments: readonly ScriptSegment[],
    options: TranslateBatchOptions & { memory?: MemoryPort },
  ): Promise<{ results: SegmentTranslation[]; stats: BatchStats }> {
    const {
      sourceLanguage,
      targetLanguage,
      mode,
      concurrency = 8,
      useMemory = true,
      onProgress,
    } = options;

    const provider = this.resolve(sourceLanguage, targetLanguage);
    const memory = useMemory ? (options.memory ?? noMemory) : noMemory;

    const knownCharacters = new Set(
      segments
        .map((s) => s.characterName?.trim().toLocaleLowerCase())
        .filter((n): n is string => Boolean(n)),
    );

    // ---- 1. collapse duplicates -------------------------------------------
    const groups = new Map<string, { sourceText: string; ids: number[] }>();
    for (const segment of segments) {
      const key = segment.sourceText;
      const group = groups.get(key);
      if (group) group.ids.push(segment.id);
      else groups.set(key, { sourceText: segment.sourceText, ids: [segment.id] });
    }
    const uniqueTexts = [...groups.keys()];

    // ---- 2. consult translation memory ------------------------------------
    const hits = await memory.lookup(uniqueTexts);

    const misses: string[] = [];
    const resolved = new Map<string, SegmentTranslation["translatedText"]>();
    const hitIds: number[] = [];
    let fromMemory = 0;

    for (const text of uniqueTexts) {
      const hit = hits.get(memoryHash(text));
      if (hit) {
        resolved.set(text, hit.translatedText);
        hitIds.push(hit.id);
        fromMemory += groups.get(text)!.ids.length;
      } else {
        misses.push(text);
      }
    }

    // ---- 3. translate what is genuinely new -------------------------------
    const stats: BatchStats = {
      total: segments.length,
      translated: 0,
      fromMemory,
      skipped: 0,
      failed: 0,
      providerCalls: 0,
    };

    const results: SegmentTranslation[] = [];
    const newMemory: NewMemoryEntry[] = [];
    const errors = new Map<string, string>();

    let settled = fromMemory;
    onProgress?.(settled, segments.length);

    // ---- 3a. scene pass: whole runs of lines with their speakers ----------
    const sceneDone = new Set<string>();
    if (this.scene && misses.length > 0) {
      const speakers = new Map(
        segments.map((s) => [s.sourceText, s.characterName?.trim() || undefined] as const),
      );
      const scene = await this.translateScenes(misses, speakers, {
        sourceLanguage,
        targetLanguage,
        knownCharacters,
        concurrency,
      });
      stats.providerCalls += scene.calls;
      for (const [sourceText, text] of scene.done) {
        const rowCount = groups.get(sourceText)!.ids.length;
        resolved.set(sourceText, text);
        sceneDone.add(sourceText);
        stats.translated += rowCount;
        newMemory.push({ sourceText, translatedText: text, origin: "machine" });
        settled += rowCount;
      }
      onProgress?.(settled, segments.length);
    }

    // ---- 3b. line by line: everything the scene pass did not settle -------
    const remaining = misses.filter((text) => !sceneDone.has(text));

    await mapWithConcurrency(remaining, concurrency, async (sourceText) => {
      const rowCount = groups.get(sourceText)!.ids.length;
      try {
        const result = await this.translateText(sourceText, {
          sourceLanguage,
          targetLanguage,
          mode,
          knownCharacters,
        });

        resolved.set(sourceText, result.text);
        stats.providerCalls += result.calls;

        if (result.calls === 0) {
          // Nothing translatable in the row - keep it, but do not pollute the
          // cache with an identity mapping.
          stats.skipped += rowCount;
        } else {
          stats.translated += rowCount;
          newMemory.push({ sourceText, translatedText: result.text, origin: "machine" });
        }
      } catch (error) {
        errors.set(sourceText, error instanceof Error ? error.message : String(error));
        stats.failed += rowCount;
      } finally {
        settled += rowCount;
        onProgress?.(settled, segments.length);
      }
    });

    // ---- 4. fan the unique results back out to every row ------------------
    for (const segment of segments) {
      const error = errors.get(segment.sourceText);
      if (error) {
        results.push({ id: segment.id, outcome: "failed", translatedText: null, error });
        continue;
      }

      const text = resolved.get(segment.sourceText) ?? null;
      const hit = hits.get(memoryHash(segment.sourceText));

      results.push({
        id: segment.id,
        outcome: hit ? "memory" : text === segment.sourceText ? "skipped" : "translated",
        translatedText: text,
        memoryId: hit?.id,
        provider: hit ? undefined : provider.name,
        model: hit
          ? undefined
          : sceneDone.has(segment.sourceText) && this.scene
            ? this.scene.model
            : provider.model,
      });
    }

    // ---- 5. feed the cache ------------------------------------------------
    await memory.store(newMemory);
    await memory.bumpUsage(hitIds);

    return { results, stats };
  }

  /**
   * Send rows to the scene translator in script order, SCENE_SIZE lines per
   * request. A row only counts as done when every one of its lines came back
   * with every placeholder intact; anything less is left for the line-level
   * path, so the scene pass can improve quality but never lower the bar.
   */
  private async translateScenes(
    texts: readonly string[],
    speakers: ReadonlyMap<string, string | undefined>,
    options: {
      sourceLanguage: LanguageCode;
      targetLanguage: LanguageCode;
      knownCharacters: ReadonlySet<string>;
      concurrency: number;
    },
  ): Promise<{ done: Map<string, string>; calls: number }> {
    const scene = this.scene!;
    type Planned =
      | { kind: "keep"; line: string }
      | { kind: "send"; key: string; parts: LineParts; placeholders: Placeholder[] };

    const plans: { sourceText: string; lines: Planned[]; separators: string[] }[] = [];
    const queue: SceneLine[] = [];
    let nextKey = 0;

    for (const sourceText of texts) {
      const { lines, separators } = splitLines(sourceText);
      const planned: Planned[] = [];
      let sendable = true;

      for (const line of lines) {
        const { masked, placeholders } = protect(line, 0);
        const parts = splitLine(masked, options.knownCharacters);
        if (!hasTranslatableContent(parts.body)) {
          planned.push({ kind: "keep", line });
          continue;
        }
        if (parts.body.length > SCENE_MAX_LINE_CHARS) sendable = false;
        const key = `L${nextKey++}`;
        planned.push({ kind: "send", key, parts, placeholders });
      }

      const sends = planned.filter((p) => p.kind === "send");
      if (!sendable || sends.length === 0) continue;

      const speaker =
        speakers.get(sourceText) ??
        (sends[0]!.parts.speaker ? speakerName(sends[0]!.parts.speaker) : undefined);
      for (const p of sends) {
        queue.push({
          key: p.key,
          speaker: (p.parts.speaker ? speakerName(p.parts.speaker) : undefined) ?? speaker,
          text: p.parts.body,
        });
      }
      plans.push({ sourceText, lines: planned, separators });
    }

    const chunks: SceneLine[][] = [];
    for (let i = 0; i < queue.length; i += SCENE_SIZE) chunks.push(queue.slice(i, i + SCENE_SIZE));

    const translated = new Map<string, string>();
    let calls = 0;
    await mapWithConcurrency(chunks, Math.min(options.concurrency, SCENE_CONCURRENCY), async (chunk) => {
      calls += 1;
      try {
        const out = await scene.translateScene(chunk, options.sourceLanguage, options.targetLanguage);
        for (const [key, value] of out) translated.set(key, value);
      } catch (error) {
        // Not fatal: these rows simply take the line-level path.
        console.warn(
          `[translate] scene pass failed for ${chunk.length} line(s), falling back: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    });

    const done = new Map<string, string>();
    for (const plan of plans) {
      const out: string[] = [];
      let ok = true;
      for (const p of plan.lines) {
        if (p.kind === "keep") {
          out.push(p.line);
          continue;
        }
        let body = translated.get(p.key);
        // The model sometimes bolds a line it read as a caption. Markdown the
        // source line never had is invention, not translation.
        if (body && !p.parts.body.includes("**")) body = body.replace(/\*\*/g, "").trim();
        if (!body) {
          ok = false;
          break;
        }
        const rebuilt = joinLine(p.parts, body);
        if (p.placeholders.length > 0 && missingTokens(rebuilt, p.placeholders).length > 0) {
          ok = false;
          break;
        }
        out.push(restore(rebuilt, p.placeholders));
      }
      if (ok) done.set(plan.sourceText, joinLines(out, plan.separators));
    }

    return { done, calls };
  }
}

/** Lines per scene request: enough context for gender and tone, small enough to stay fast. */
const SCENE_SIZE = 40;
/** Scene requests in flight at once; each is a long reasoning call. */
const SCENE_CONCURRENCY = 3;
/** Longer bodies go line-by-line, where chunking keeps them under the input limit. */
const SCENE_MAX_LINE_CHARS = 1800;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface TranslatorFactoryOptions {
  apiKey: string;
  baseUrl?: string;
  model?: SarvamModel;
  /**
   * "scene" (default) translates batches with Sarvam's chat model so gender
   * and context survive, falling back line by line; "line" uses only the
   * /translate model.
   */
  engine?: "scene" | "line";
  /** Chat model for the scene pass. */
  chatModel?: string;
}

/**
 * Build the configured translator.
 *
 * When a second provider is added, register it after Sarvam so Indic pairs
 * keep going to the specialist model and everything else falls through:
 *
 *   translator.register(new GeminiProvider({ ... }));
 */
export function createTranslator(options: TranslatorFactoryOptions): Translator {
  const scene =
    (options.engine ?? "scene") === "scene"
      ? new SarvamSceneTranslator({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          model: options.chatModel,
        })
      : undefined;

  return new Translator(
    [
      new SarvamProvider({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        model: options.model,
      }),
    ],
    { scene },
  );
}

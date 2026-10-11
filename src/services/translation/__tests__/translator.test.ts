import { describe, expect, it, vi } from "vitest";
import { Translator } from "../translator";
import { memoryHash } from "../memory";
import type {
  MemoryEntry,
  MemoryPort,
  NewMemoryEntry,
} from "../memory";
import {
  UnsupportedLanguagePairError,
  type LanguageCode,
  type ProviderRequest,
  type ProviderResult,
  type TranslationProvider,
} from "../types";

/** Deterministic stand-in: uppercases, so structure is easy to assert on. */
class FakeProvider implements TranslationProvider {
  readonly name = "fake";
  readonly model = "fake:v1";
  readonly calls: ProviderRequest[] = [];

  constructor(
    readonly maxInputChars = 2000,
    private readonly transform: (text: string) => string = (t) => t.toUpperCase(),
  ) {}

  supports(source: LanguageCode, target: LanguageCode): boolean {
    return source !== target;
  }

  async translate(request: ProviderRequest): Promise<ProviderResult> {
    this.calls.push(request);
    return {
      text: this.transform(request.text),
      provider: this.name,
      model: this.model,
      latencyMs: 1,
    };
  }
}

function fakeMemory(seed: Record<string, string> = {}): MemoryPort & { stored: NewMemoryEntry[] } {
  const entries = new Map<string, MemoryEntry>();
  let nextId = 1;
  for (const [source, translated] of Object.entries(seed)) {
    entries.set(memoryHash(source), { id: nextId++, translatedText: translated, origin: "human" });
  }

  const stored: NewMemoryEntry[] = [];
  return {
    stored,
    async lookup(texts) {
      const found = new Map<string, MemoryEntry>();
      for (const text of texts) {
        const hit = entries.get(memoryHash(text));
        if (hit) found.set(memoryHash(text), hit);
      }
      return found;
    },
    async store(newEntries) {
      stored.push(...newEntries);
    },
    async bumpUsage() {},
  };
}

const en = "en-IN" as LanguageCode;
const hi = "hi-IN" as LanguageCode;

describe("provider routing", () => {
  it("throws a specific error when no provider serves the pair", () => {
    const translator = new Translator([
      {
        name: "indic-only",
        model: "x",
        maxInputChars: 1000,
        supports: (_s, t) => t === hi,
        translate: async () => ({ text: "", provider: "x", model: "x", latencyMs: 0 }),
      },
    ]);

    expect(() => translator.resolve(en, "ta-IN" as LanguageCode)).toThrow(
      UnsupportedLanguagePairError,
    );
    expect(translator.canTranslate(en, hi)).toBe(true);
  });

  it("picks the first provider that supports the pair", () => {
    const first = new FakeProvider();
    const second = new FakeProvider();
    vi.spyOn(first, "supports").mockReturnValue(false);

    const translator = new Translator([first, second]);
    expect(translator.resolve(en, hi)).toBe(second);
  });
});

describe("translateText", () => {
  it("never sends the character name to the provider", async () => {
    const provider = new FakeProvider();
    const translator = new Translator([provider]);

    const result = await translator.translateText("Raju: Namaste sabhi ko.", {
      sourceLanguage: en,
      targetLanguage: hi,
    });

    expect(provider.calls[0]?.text).toBe("Namaste sabhi ko.");
    expect(result.text).toBe("Raju: NAMASTE SABHI KO.");
  });

  it("preserves line breaks and translates each line separately", async () => {
    const provider = new FakeProvider();
    const translator = new Translator([provider]);

    const result = await translator.translateText("first line\nsecond line", {
      sourceLanguage: en,
      targetLanguage: hi,
    });

    expect(provider.calls).toHaveLength(2);
    expect(result.text).toBe("FIRST LINE\nSECOND LINE");
  });

  it("restores placeholders after translation", async () => {
    const provider = new FakeProvider();
    const translator = new Translator([provider]);

    const result = await translator.translateText("Hello {name}, {count} left", {
      sourceLanguage: en,
      targetLanguage: hi,
    });

    expect(provider.calls[0]?.text).toBe("Hello #0#, #1# left");
    expect(result.text).toBe("HELLO {name}, {count} LEFT");
  });

  it("leaves a stage cue untouched and unpaid for", async () => {
    // Regression, caught against the live API: masking has to happen before
    // the speaker split, or the colon inside "[SFX: ...]" tears the cue apart.
    const provider = new FakeProvider();
    const translator = new Translator([provider]);

    const result = await translator.translateText("[SFX: door creaks]", {
      sourceLanguage: en,
      targetLanguage: hi,
    });

    expect(provider.calls).toHaveLength(0);
    expect(result.text).toBe("[SFX: door creaks]");
  });

  it("translates dialogue on a line that also carries a cue", async () => {
    const provider = new FakeProvider();
    const translator = new Translator([provider]);

    const result = await translator.translateText("[VO: narrator] Raju: Chalo!", {
      sourceLanguage: en,
      targetLanguage: hi,
    });

    expect(provider.calls[0]?.text).toBe("Chalo!");
    expect(result.text).toBe("[VO: narrator] Raju: CHALO!");
  });

  it("costs nothing for rows with no translatable content", async () => {
    const provider = new FakeProvider();
    const translator = new Translator([provider]);

    const result = await translator.translateText("...\n---\n42", {
      sourceLanguage: en,
      targetLanguage: hi,
    });

    expect(provider.calls).toHaveLength(0);
    expect(result.calls).toBe(0);
    expect(result.text).toBe("...\n---\n42");
  });

  it("refuses to return a line whose placeholders were destroyed", async () => {
    // A provider that eats sentinels no matter which shape is used.
    const provider = new FakeProvider(2000, (text) => text.replace(/#\d+#|\(\(\d+\)\)/g, ""));
    const translator = new Translator([provider]);

    await expect(
      translator.translateText("Hello {name}", { sourceLanguage: en, targetLanguage: hi }),
    ).rejects.toThrow(/Placeholders did not survive/);
  });

  it("retries with a second sentinel shape before giving up", async () => {
    // Drops '#0#' but leaves '((0))' alone.
    const provider = new FakeProvider(2000, (text) => text.replace(/#\d+#/g, ""));
    const translator = new Translator([provider]);

    const result = await translator.translateText("Hello {name}", {
      sourceLanguage: en,
      targetLanguage: hi,
    });

    expect(result.text).toContain("{name}");
    expect(provider.calls).toHaveLength(2);
  });

  it("chunks input that exceeds the provider limit", async () => {
    const provider = new FakeProvider(40, (t) => t);
    const translator = new Translator([provider]);

    const text = "One sentence here. Two sentence here. Three sentence here.";
    await translator.translateText(text, { sourceLanguage: en, targetLanguage: hi });

    expect(provider.calls.length).toBeGreaterThan(1);
    for (const call of provider.calls) expect(call.text.length).toBeLessThanOrEqual(40);
  });
});

describe("translateBatch", () => {
  it("collapses duplicate rows into one provider call", async () => {
    const provider = new FakeProvider();
    const translator = new Translator([provider]);

    const { results, stats } = await translator.translateBatch(
      [
        { id: 1, sourceText: "Chalo!" },
        { id: 2, sourceText: "Chalo!" },
        { id: 3, sourceText: "Chalo!" },
      ],
      { orgId: "o", sourceLanguage: en, targetLanguage: hi, memory: fakeMemory() },
    );

    expect(provider.calls).toHaveLength(1);
    expect(results.every((r) => r.translatedText === "CHALO!")).toBe(true);
    expect(stats.translated).toBe(3);
    expect(stats.providerCalls).toBe(1);
  });

  it("serves cached rows from memory without calling the provider", async () => {
    const provider = new FakeProvider();
    const translator = new Translator([provider]);
    const memory = fakeMemory({ "Chalo!": "चलो!" });

    const { results, stats } = await translator.translateBatch(
      [
        { id: 1, sourceText: "Chalo!" },
        { id: 2, sourceText: "Naya line." },
      ],
      { orgId: "o", sourceLanguage: en, targetLanguage: hi, memory },
    );

    expect(provider.calls).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: "memory", translatedText: "चलो!" });
    expect(results[1]?.outcome).toBe("translated");
    expect(stats.fromMemory).toBe(1);
    expect(stats.translated).toBe(1);
  });

  it("writes only new machine output back to memory", async () => {
    const translator = new Translator([new FakeProvider()]);
    const memory = fakeMemory({ "Chalo!": "चलो!" });

    await translator.translateBatch(
      [
        { id: 1, sourceText: "Chalo!" },
        { id: 2, sourceText: "Naya line." },
      ],
      { orgId: "o", sourceLanguage: en, targetLanguage: hi, memory },
    );

    expect(memory.stored).toEqual([
      { sourceText: "Naya line.", translatedText: "NAYA LINE.", origin: "machine" },
    ]);
  });

  it("bypasses memory when asked to re-translate", async () => {
    const provider = new FakeProvider();
    const translator = new Translator([provider]);
    const memory = fakeMemory({ "Chalo!": "चलो!" });

    const { results } = await translator.translateBatch([{ id: 1, sourceText: "Chalo!" }], {
      orgId: "o",
      sourceLanguage: en,
      targetLanguage: hi,
      memory,
      useMemory: false,
    });

    expect(provider.calls).toHaveLength(1);
    expect(results[0]?.translatedText).toBe("CHALO!");
  });

  it("isolates a failing row instead of losing the batch", async () => {
    const provider = new FakeProvider(2000, (text) => {
      if (text.includes("BOOM")) throw new Error("provider exploded");
      return text.toUpperCase();
    });
    const translator = new Translator([provider]);

    const { results, stats } = await translator.translateBatch(
      [
        { id: 1, sourceText: "fine line" },
        { id: 2, sourceText: "BOOM line" },
        { id: 3, sourceText: "also fine" },
      ],
      { orgId: "o", sourceLanguage: en, targetLanguage: hi, memory: fakeMemory() },
    );

    expect(stats.failed).toBe(1);
    expect(stats.translated).toBe(2);
    expect(results.find((r) => r.id === 2)).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("provider exploded"),
    });
    expect(results.find((r) => r.id === 3)?.translatedText).toBe("ALSO FINE");
  });

  it("reports progress as rows settle", async () => {
    const translator = new Translator([new FakeProvider()]);
    const seen: number[] = [];

    await translator.translateBatch(
      [
        { id: 1, sourceText: "a line" },
        { id: 2, sourceText: "b line" },
      ],
      {
        orgId: "o",
        sourceLanguage: en,
        targetLanguage: hi,
        concurrency: 1,
        memory: fakeMemory(),
        onProgress: (done) => seen.push(done),
      },
    );

    expect(seen.at(-1)).toBe(2);
  });
});

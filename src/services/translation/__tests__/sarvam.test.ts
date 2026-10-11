import { describe, expect, it, vi } from "vitest";
import { SarvamProvider } from "../sarvam";
import { TranslationError, type LanguageCode } from "../types";

const en = "en-IN" as LanguageCode;
const hi = "hi-IN" as LanguageCode;
const sat = "sat-IN" as LanguageCode;

/** Typed so `mock.calls` keeps fetch's argument tuple instead of collapsing to []. */
type FetchArgs = Parameters<typeof fetch>;

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("SarvamProvider", () => {
  it("posts the documented request shape", async () => {
    const fetchImpl = vi.fn(async (..._args: FetchArgs) =>
      jsonResponse({ request_id: "r1", translated_text: "नमस्ते" }),
    );
    const provider = new SarvamProvider({ apiKey: "k", fetchImpl: fetchImpl as never });

    const result = await provider.translate({
      text: "Hello",
      sourceLanguage: en,
      targetLanguage: hi,
    });

    expect(result.text).toBe("नमस्ते");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.sarvam.ai/translate");
    expect(init!.headers).toMatchObject({ "api-subscription-key": "k" });
    expect(JSON.parse(init!.body as string)).toEqual({
      input: "Hello",
      source_language_code: "en-IN",
      target_language_code: "hi-IN",
      model: "sarvam-translate:v1",
      numerals_format: "international",
    });
  });

  it("only sends mode and speaker_gender to mayura, which supports them", async () => {
    const fetchImpl = vi.fn(async (..._args: FetchArgs) => jsonResponse({ translated_text: "x" }));
    const provider = new SarvamProvider({
      apiKey: "k",
      model: "mayura:v1",
      fetchImpl: fetchImpl as never,
    });

    await provider.translate({
      text: "Hello",
      sourceLanguage: en,
      targetLanguage: hi,
      mode: "modern-colloquial",
      speakerGender: "Female",
    });

    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toMatchObject({
      mode: "modern-colloquial",
      speaker_gender: "Female",
    });
  });

  it("reports the right language coverage per model", () => {
    const translate = new SarvamProvider({ apiKey: "k", model: "sarvam-translate:v1" });
    const mayura = new SarvamProvider({ apiKey: "k", model: "mayura:v1" });

    expect(translate.supports(en, sat)).toBe(true);
    expect(mayura.supports(en, sat)).toBe(false); // Santali is not a mayura language
    expect(mayura.supports(en, hi)).toBe(true);
    expect(translate.supports(en, en)).toBe(false);
    expect(translate.supports(en, "es" as LanguageCode)).toBe(false); // Spanish: no Sarvam
  });

  it("carries the documented input ceiling per model", () => {
    expect(new SarvamProvider({ apiKey: "k" }).maxInputChars).toBe(2000);
    expect(new SarvamProvider({ apiKey: "k", model: "mayura:v1" }).maxInputChars).toBe(1000);
  });

  it("retries a 429 and honours Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ translated_text: "ok" }));

    const provider = new SarvamProvider({ apiKey: "k", fetchImpl: fetchImpl as never });
    const result = await provider.translate({
      text: "Hello",
      sourceLanguage: en,
      targetLanguage: hi,
    });

    expect(result.text).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400", async () => {
    const fetchImpl = vi.fn(async (..._args: FetchArgs) => new Response("bad input", { status: 400 }));
    const provider = new SarvamProvider({ apiKey: "k", fetchImpl: fetchImpl as never });

    await expect(
      provider.translate({ text: "Hello", sourceLanguage: en, targetLanguage: hi }),
    ).rejects.toThrow(TranslationError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("points at the API key on a 401", async () => {
    const fetchImpl = vi.fn(async (..._args: FetchArgs) => new Response("nope", { status: 401 }));
    const provider = new SarvamProvider({ apiKey: "k", fetchImpl: fetchImpl as never });

    await expect(
      provider.translate({ text: "Hello", sourceLanguage: en, targetLanguage: hi }),
    ).rejects.toThrow(/SARVAM_API_KEY/);
  });

  it("rejects input over the model ceiling before spending a call", async () => {
    const fetchImpl = vi.fn();
    const provider = new SarvamProvider({ apiKey: "k", fetchImpl: fetchImpl as never });

    await expect(
      provider.translate({ text: "x".repeat(2001), sourceLanguage: en, targetLanguage: hi }),
    ).rejects.toThrow(/exceeds the 2000-char limit/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

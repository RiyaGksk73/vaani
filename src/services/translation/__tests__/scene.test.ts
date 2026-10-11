import { describe, expect, it } from "vitest";
import { Translator } from "../translator";
import { SarvamSceneTranslator, parseJsonObject, type SceneLine } from "../sarvam-scene";
import { parseScriptLine, splitLine } from "../preserve";
import type { LanguageCode, ProviderRequest, ProviderResult, TranslationProvider } from "../types";

const en = "en-IN" as LanguageCode;
const hi = "hi-IN" as LanguageCode;

class LineProvider implements TranslationProvider {
  readonly name = "fake";
  readonly model = "line:v1";
  readonly maxInputChars = 2000;
  readonly calls: string[] = [];
  supports() {
    return true;
  }
  async translate(request: ProviderRequest): Promise<ProviderResult> {
    this.calls.push(request.text);
    return { text: `line(${request.text})`, provider: this.name, model: this.model, latencyMs: 1 };
  }
}

/** Scene stand-in: records what it was sent, answers through `answer`. */
function fakeScene(answer: (lines: readonly SceneLine[]) => Record<string, string> | Error) {
  const sent: SceneLine[][] = [];
  const scene = Object.assign(Object.create(SarvamSceneTranslator.prototype), {
    name: "sarvam",
    model: "scene:v1",
    async translateScene(lines: readonly SceneLine[]) {
      sent.push([...lines]);
      const out = answer(lines);
      if (out instanceof Error) throw out;
      return new Map(Object.entries(out));
    },
  }) as SarvamSceneTranslator;
  return { scene, sent };
}

describe("markdown speaker labels", () => {
  it("keeps **Him:** out of the payload", () => {
    const parts = splitLine("**Him:** “Only with you.”");
    expect(parts.speaker).toBe("**Him:** ");
    expect(parts.body).toBe("“Only with you.”");
  });

  it("accepts the colon outside the bold too", () => {
    expect(splitLine("**Her**: What?").speaker).toBe("**Her**: ");
  });

  it("leaves a bold heading alone", () => {
    expect(splitLine("**Shot 1 — Evening | Rooftop**").speaker).toBe("");
  });

  it("splits the character out on import", () => {
    expect(parseScriptLine("**Him:** “Never.”")).toEqual({ characterName: "Him", text: "“Never.”" });
    expect(parseScriptLine("Raju: Namaste.")).toEqual({ characterName: "Raju", text: "Namaste." });
    expect(parseScriptLine("[SFX: door creaks]")).toEqual({ characterName: null, text: "[SFX: door creaks]" });
    expect(parseScriptLine("He smiles.")).toEqual({ characterName: null, text: "He smiles." });
  });
});

describe("scene pass", () => {
  it("sends lines in order with their speakers and uses the answers", async () => {
    const line = new LineProvider();
    const { scene, sent } = fakeScene((lines) =>
      Object.fromEntries(lines.map((l) => [l.key, `hi(${l.text})`])),
    );
    const translator = new Translator([line], { scene });

    const { results, stats } = await translator.translateBatch(
      [
        { id: 1, characterName: null, sourceText: "He smiles." },
        { id: 2, characterName: "Him", sourceText: "“Only with you.”" },
        { id: 3, characterName: null, sourceText: "**Her:** “What?”" },
      ],
      { orgId: "o", sourceLanguage: en, targetLanguage: hi },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((l) => [l.speaker, l.text])).toEqual([
      [undefined, "He smiles."],
      ["Him", "“Only with you.”"],
      ["Her", "“What?”"],
    ]);
    expect(results.map((r) => r.translatedText)).toEqual([
      "hi(He smiles.)",
      "hi(“Only with you.”)",
      "**Her:** hi(“What?”)",
    ]);
    expect(results.every((r) => r.model === "scene:v1")).toBe(true);
    expect(line.calls).toHaveLength(0);
    expect(stats.translated).toBe(3);
  });

  it("falls back line by line for anything missing or with a lost placeholder", async () => {
    const line = new LineProvider();
    const { scene } = fakeScene((lines) => ({
      [lines[0]!.key]: "ठीक",
      // lines[1] dropped; lines[2] loses its sentinel
      [lines[2]!.key]: "कोई टोकन नहीं",
    }));
    const translator = new Translator([line], { scene });

    const { results } = await translator.translateBatch(
      [
        { id: 1, sourceText: "Fine." },
        { id: 2, sourceText: "Missing." },
        { id: 3, sourceText: "Hello {name}." },
      ],
      { orgId: "o", sourceLanguage: en, targetLanguage: hi },
    );

    expect(results[0]!.translatedText).toBe("ठीक");
    expect(results[1]!.translatedText).toBe("line(Missing.)");
    expect(results[2]!.translatedText).toBe("line(Hello {name}.)");
    expect(results[2]!.model).toBe("line:v1");
  });

  it("strips bold the source line never had", async () => {
    const { scene } = fakeScene((lines) => ({
      [lines[0]!.key]: "**आगे की कहानी में...**",
      [lines[1]!.key]: "**पैनल 1**",
    }));
    const translator = new Translator([new LineProvider()], { scene });
    const { results } = await translator.translateBatch(
      [
        { id: 1, sourceText: "To be continued…" },
        { id: 2, sourceText: "**Panel 1**" },
      ],
      { orgId: "o", sourceLanguage: en, targetLanguage: hi },
    );
    expect(results[0]!.translatedText).toBe("आगे की कहानी में...");
    expect(results[1]!.translatedText).toBe("**पैनल 1**");
  });

  it("survives the scene call failing outright", async () => {
    const line = new LineProvider();
    const { scene } = fakeScene(() => new Error("boom"));
    const translator = new Translator([line], { scene });

    const { results, stats } = await translator.translateBatch([{ id: 1, sourceText: "Hi." }], {
      orgId: "o",
      sourceLanguage: en,
      targetLanguage: hi,
    });
    expect(results[0]!.translatedText).toBe("line(Hi.)");
    expect(stats.failed).toBe(0);
  });
});

describe("parseJsonObject", () => {
  it("reads fenced JSON and ignores a think block", () => {
    expect(parseJsonObject('<think>{"x":1}</think>\n```json\n{"L0": "हाँ"}\n```')).toEqual({ L0: "हाँ" });
  });
  it("rejects a reply with no object", () => {
    expect(() => parseJsonObject("sorry")).toThrow();
  });
});

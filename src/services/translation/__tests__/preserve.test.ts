import { describe, expect, it } from "vitest";
import {
  chunkText,
  hasTranslatableContent,
  joinLine,
  joinLines,
  missingTokens,
  protect,
  restore,
  splitLine,
  splitLines,
} from "../preserve";

describe("protect / restore", () => {
  it("masks and restores every placeholder shape", () => {
    const source = "Hello {{name}}, you have {count} messages. <b>Read %s</b> now, ${user}.";
    const { masked, placeholders } = protect(source);

    expect(placeholders).toHaveLength(6);
    expect(masked).not.toContain("{{name}}");
    expect(restore(masked, placeholders)).toBe(source);
  });

  it("keeps SFX and stage cues out of the payload", () => {
    const { masked, placeholders } = protect("[SFX: door creaks] Raju steps back.");
    expect(placeholders[0]?.original).toBe("[SFX: door creaks]");
    expect(masked).not.toContain("door creaks");
  });

  it("reports sentinels the model dropped", () => {
    const { placeholders } = protect("Hi {name}, {count} left");
    expect(missingTokens("नमस्ते #0#, #1# बचे", placeholders)).toEqual([]);
    expect(missingTokens("नमस्ते, कुछ बचे", placeholders)).toHaveLength(2);
  });

  it("uses a different sentinel shape per style", () => {
    expect(protect("Hi {name}", 0).masked).toBe("Hi #0#");
    expect(protect("Hi {name}", 1).masked).toBe("Hi ((0))");
  });
});

describe("splitLine", () => {
  it("splits a speaker prefix off the dialogue", () => {
    const parts = splitLine("Raju: Namaste sabhi ko.");
    expect(parts.speaker).toBe("Raju: ");
    expect(parts.body).toBe("Namaste sabhi ko.");
    expect(joinLine(parts, "Hola a todos.")).toBe("Raju: Hola a todos.");
  });

  it("handles a parenthetical cue in the speaker", () => {
    const parts = splitLine("MEERA (angry): Stop right there!");
    expect(parts.speaker).toBe("MEERA (angry): ");
    expect(parts.body).toBe("Stop right there!");
  });

  it("does not mistake ordinary prose for a speaker", () => {
    const parts = splitLine("He paused and said the only thing that mattered: nothing.");
    expect(parts.speaker).toBe("");
    expect(parts.body).toBe("He paused and said the only thing that mattered: nothing.");
  });

  it("keeps list numbering out of the payload", () => {
    const parts = splitLine("  3. Raju: Chalo!");
    expect(parts.marker).toBe("  3. ");
    expect(parts.speaker).toBe("Raju: ");
    expect(parts.body).toBe("Chalo!");
    expect(joinLine(parts, "चलो!")).toBe("  3. Raju: चलो!");
  });

  it("preserves trailing whitespace exactly", () => {
    const parts = splitLine("Raju: Chalo!   ");
    expect(parts.trailing).toBe("   ");
    expect(joinLine(parts, "चलो!")).toBe("Raju: चलो!   ");
  });

  it("does not read a stage cue as a speaker", () => {
    // Regression: "[SFX" used to match the speaker pattern, which split the
    // cue in half and sent "door creaks]" off to be translated.
    const parts = splitLine("[SFX: door creaks]");
    expect(parts.speaker).toBe("");
    expect(parts.body).toBe("[SFX: door creaks]");
  });

  it("trusts known character names over the heuristic", () => {
    const known = new Set(["the narrator of everything you see"]);
    const parts = splitLine("The Narrator Of Everything You See: Once upon a time.", known);
    expect(parts.speaker).toBe("The Narrator Of Everything You See: ");
  });
});

describe("splitLines / joinLines", () => {
  it("round-trips mixed line endings", () => {
    const text = "one\r\ntwo\nthree\rfour";
    const { lines, separators } = splitLines(text);
    expect(lines).toEqual(["one", "two", "three", "four"]);
    expect(joinLines(lines, separators)).toBe(text);
  });

  it("preserves blank lines", () => {
    const text = "one\n\nthree";
    const { lines, separators } = splitLines(text);
    expect(lines).toHaveLength(3);
    expect(joinLines(lines, separators)).toBe(text);
  });
});

describe("hasTranslatableContent", () => {
  it("is false for punctuation, digits and bare markup", () => {
    expect(hasTranslatableContent("...")).toBe(false);
    expect(hasTranslatableContent("---")).toBe(false);
    expect(hasTranslatableContent("42")).toBe(false);
    expect(hasTranslatableContent("   ")).toBe(false);
  });

  it("is true for any script", () => {
    expect(hasTranslatableContent("hello")).toBe(true);
    expect(hasTranslatableContent("नमस्ते")).toBe(true);
    expect(hasTranslatableContent("வணக்கம்")).toBe(true);
  });
});

describe("chunkText", () => {
  it("returns the text untouched when it fits", () => {
    expect(chunkText("short", 100)).toEqual(["short"]);
  });

  it("splits on sentence boundaries and loses nothing", () => {
    const text = "First sentence here. Second sentence here. Third sentence here.";
    const chunks = chunkText(text, 30);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(30);
  });

  it("splits on the Devanagari danda", () => {
    const text = "पहला वाक्य। दूसरा वाक्य। तीसरा वाक्य।";
    const chunks = chunkText(text, 15);
    expect(chunks.join("")).toBe(text);
  });

  it("falls back to word boundaries for one very long sentence", () => {
    const text = `${"word ".repeat(100)}end.`;
    const chunks = chunkText(text, 60);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(60);
  });
});

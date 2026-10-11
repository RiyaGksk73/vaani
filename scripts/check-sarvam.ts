/**
 * Verify the Sarvam key and the translation pipeline against the live API.
 *
 *   npm run check:sarvam
 *   npm run check:sarvam -- --to ta-IN
 *
 * Needs no database. Runs real script lines through the full pipeline -
 * speaker splitting, placeholder masking, line breaks, chunking - so a green
 * run means the key works AND the localisation rules survive the round trip.
 */

import { createTranslator } from "../src/services/translation/translator";
import { LANGUAGES, isLanguageCode, languageLabel } from "../src/services/translation/languages";
import type { LanguageCode } from "../src/services/translation/types";

const SAMPLES: { label: string; text: string; expect: string }[] = [
  {
    label: "speaker prefix",
    text: "Raju: Namaste sabhi ko.",
    expect: "keeps 'Raju:' verbatim",
  },
  {
    label: "placeholder",
    text: "Meera: Kya tumne {item} dekha hai?",
    expect: "keeps {item} intact",
  },
  {
    label: "line breaks + SFX",
    text: "[SFX: door creaks]\nDadi: Kaun hai wahan?",
    expect: "keeps the SFX cue and the newline",
  },
  {
    label: "numbering",
    text: "1. Chintu: Chalo, der ho rahi hai!",
    expect: "keeps '1.' and the speaker",
  },
  {
    label: "no letters",
    text: "...",
    expect: "costs zero API calls",
  },
];

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    console.error("SARVAM_API_KEY is not set. Put it in .env.local.");
    process.exit(1);
  }

  const from = (arg("--from") ?? "hi-IN") as LanguageCode;
  const to = (arg("--to") ?? "ta-IN") as LanguageCode;

  for (const [name, code] of [
    ["--from", from],
    ["--to", to],
  ] as const) {
    if (!isLanguageCode(code)) {
      console.error(`${name}: "${code}" is not a supported language.`);
      console.error(`Supported: ${LANGUAGES.map((l) => l.code).join(", ")}`);
      process.exit(1);
    }
  }

  const translator = createTranslator({
    apiKey,
    baseUrl: process.env.SARVAM_API_BASE_URL,
    model: (process.env.SARVAM_MODEL as "sarvam-translate:v1") ?? "sarvam-translate:v1",
  });

  console.log(`Sarvam check: ${languageLabel(from)} -> ${languageLabel(to)}`);
  console.log(`Key: ...${apiKey.slice(-4)}  Model: ${translator.list()[0]?.model}\n`);

  let failures = 0;
  let calls = 0;

  for (const sample of SAMPLES) {
    try {
      const result = await translator.translateText(sample.text, {
        sourceLanguage: from,
        targetLanguage: to,
      });
      calls += result.calls;

      console.log(`[${sample.label}]  (${result.calls} call${result.calls === 1 ? "" : "s"})`);
      console.log(`  in   ${JSON.stringify(sample.text)}`);
      console.log(`  out  ${JSON.stringify(result.text)}`);
      console.log(`  want ${sample.expect}\n`);
    } catch (error) {
      failures += 1;
      console.error(`[${sample.label}]  FAILED`);
      console.error(`  ${error instanceof Error ? error.message : error}\n`);
    }
  }

  console.log(`${SAMPLES.length - failures}/${SAMPLES.length} samples translated, ${calls} API calls.`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error("check failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});

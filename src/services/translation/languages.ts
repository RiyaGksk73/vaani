/**
 * Supported languages.
 *
 * This is the honest list, not an aspirational one: Sarvam's /translate
 * endpoint covers English plus the 22 scheduled Indian languages, and nothing
 * else. Spanish, French, German, Japanese, Chinese, Arabic and friends are NOT
 * reachable through Sarvam - adding them means registering a second provider
 * in translator.ts, at which point their codes belong in this table with a
 * different `models` entry.
 *
 * Codes are Sarvam's own (BCP-47 with an -IN region), used verbatim as
 * source_language_code / target_language_code.
 */

export const LANGUAGES = [
  { code: "en-IN", name: "English",   nativeName: "English",   script: "Latin",      mayura: true },
  { code: "hi-IN", name: "Hindi",     nativeName: "हिन्दी",       script: "Devanagari", mayura: true },
  { code: "bn-IN", name: "Bengali",   nativeName: "বাংলা",       script: "Bengali",    mayura: true },
  { code: "gu-IN", name: "Gujarati",  nativeName: "ગુજરાતી",      script: "Gujarati",   mayura: true },
  { code: "kn-IN", name: "Kannada",   nativeName: "ಕನ್ನಡ",       script: "Kannada",    mayura: true },
  { code: "ml-IN", name: "Malayalam", nativeName: "മലയാളം",     script: "Malayalam",  mayura: true },
  { code: "mr-IN", name: "Marathi",   nativeName: "मराठी",       script: "Devanagari", mayura: true },
  { code: "od-IN", name: "Odia",      nativeName: "ଓଡ଼ିଆ",        script: "Odia",       mayura: true },
  { code: "pa-IN", name: "Punjabi",   nativeName: "ਪੰਜਾਬੀ",       script: "Gurmukhi",   mayura: true },
  { code: "ta-IN", name: "Tamil",     nativeName: "தமிழ்",       script: "Tamil",      mayura: true },
  { code: "te-IN", name: "Telugu",    nativeName: "తెలుగు",       script: "Telugu",     mayura: true },
  { code: "as-IN", name: "Assamese",  nativeName: "অসমীয়া",      script: "Bengali",    mayura: false },
  { code: "brx-IN", name: "Bodo",     nativeName: "बड़ो",        script: "Devanagari", mayura: false },
  { code: "doi-IN", name: "Dogri",    nativeName: "डोगरी",       script: "Devanagari", mayura: false },
  { code: "kok-IN", name: "Konkani",  nativeName: "कोंकणी",      script: "Devanagari", mayura: false },
  { code: "ks-IN", name: "Kashmiri",  nativeName: "کٲشُر",       script: "Arabic",     mayura: false },
  { code: "mai-IN", name: "Maithili", nativeName: "मैथिली",       script: "Devanagari", mayura: false },
  { code: "mni-IN", name: "Manipuri", nativeName: "ꯃꯤꯇꯩ ꯂꯣꯟ",   script: "Meetei",     mayura: false },
  { code: "ne-IN", name: "Nepali",    nativeName: "नेपाली",       script: "Devanagari", mayura: false },
  { code: "sa-IN", name: "Sanskrit",  nativeName: "संस्कृतम्",     script: "Devanagari", mayura: false },
  { code: "sat-IN", name: "Santali",  nativeName: "ᱥᱟᱱᱛᱟᱲᱤ",     script: "Ol Chiki",   mayura: false },
  { code: "sd-IN", name: "Sindhi",    nativeName: "سنڌي",        script: "Arabic",     mayura: false },
  { code: "ur-IN", name: "Urdu",      nativeName: "اردو",        script: "Arabic",     mayura: false },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];
export type Language = (typeof LANGUAGES)[number];

const BY_CODE = new Map<string, Language>(LANGUAGES.map((l) => [l.code, l]));

export function isLanguageCode(value: string): value is LanguageCode {
  return BY_CODE.has(value);
}

export function getLanguage(code: string): Language | undefined {
  return BY_CODE.get(code);
}

/** Display label, e.g. "Tamil (தமிழ்)". English gets no redundant suffix. */
export function languageLabel(code: string): string {
  const lang = BY_CODE.get(code);
  if (!lang) return code;
  return lang.name === lang.nativeName ? lang.name : `${lang.name} (${lang.nativeName})`;
}

/** Languages mayura:v1 can serve. Everything else must use sarvam-translate:v1. */
export function isMayuraLanguage(code: string): boolean {
  return BY_CODE.get(code)?.mayura === true;
}

/**
 * Right-to-left scripts, so the review editor can set `dir` correctly.
 * Urdu, Kashmiri and Sindhi are written in Perso-Arabic script.
 */
export function isRtl(code: string): boolean {
  return BY_CODE.get(code)?.script === "Arabic";
}

export const SOURCE_LANGUAGES = LANGUAGES;
export const TARGET_LANGUAGES = LANGUAGES;

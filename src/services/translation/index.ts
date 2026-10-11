/**
 * Public surface of the translation service.
 *
 * Import from here rather than reaching into individual files, so the
 * internals (which provider, how batching works) stay free to change.
 */

export * from "./types";
export * from "./languages";
export { Translator, createTranslator } from "./translator";
export type { TranslateTextOptions, TranslateTextResult } from "./translator";
export { SarvamProvider } from "./sarvam";
export type { SarvamConfig, SarvamModel } from "./sarvam";
export {
  createSupabaseMemory,
  memoryHash,
  normalizeForMemory,
  noMemory,
} from "./memory";
export type { MemoryEntry, MemoryPort, NewMemoryEntry } from "./memory";
export {
  chunkText,
  hasTranslatableContent,
  parseScriptLine,
  protect,
  restore,
  splitLine,
  splitLines,
} from "./preserve";

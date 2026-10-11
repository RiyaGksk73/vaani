/**
 * Translation memory.
 *
 * Every source line is hashed and looked up before it can cost an API call.
 * On a comic or dubbing script the hit rate is not marginal: recurring
 * catchphrases, SFX lines, episode intros and the same dialogue re-cut across
 * episodes all collapse onto one paid translation.
 *
 * Two rules keep the cache trustworthy:
 *   1. Normalisation lives here and nowhere else. The `source_hash` column is
 *      written by this module, so a second implementation would silently split
 *      the cache in two.
 *   2. A human correction outranks machine output. `upsert_translation_memory`
 *      refuses to let a machine result overwrite a human one, so the review
 *      loop compounds instead of being undone by the next run.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, TranslationOrigin } from "@/lib/supabase/database.types";

export interface MemoryEntry {
  id: number;
  translatedText: string;
  origin: TranslationOrigin;
}

export interface NewMemoryEntry {
  sourceText: string;
  translatedText: string;
  origin?: TranslationOrigin;
}

/**
 * The port translator.ts talks to. Keeping it an interface means the
 * translation pipeline can be unit-tested with an in-memory implementation and
 * never needs a database.
 */
export interface MemoryPort {
  lookup(sourceTexts: readonly string[]): Promise<Map<string, MemoryEntry>>;
  store(entries: readonly NewMemoryEntry[]): Promise<void>;
  bumpUsage(ids: readonly number[]): Promise<void>;
}

/**
 * Canonical form used for hashing.
 *
 * NFC so that visually identical Devanagari or Tamil text composed differently
 * still matches. Horizontal whitespace collapsed because indentation is
 * presentation, not content. Newlines are preserved - they are structural, and
 * the pipeline translates line by line.
 */
export function normalizeForMemory(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

export function memoryHash(text: string): string {
  return createHash("sha256").update(normalizeForMemory(text), "utf8").digest("hex");
}

/** Postgres has a parameter ceiling; look up in slices rather than one huge IN. */
const LOOKUP_CHUNK = 200;

export interface SupabaseMemoryOptions {
  orgId: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export function createSupabaseMemory(
  db: SupabaseClient<Database>,
  { orgId, sourceLanguage, targetLanguage }: SupabaseMemoryOptions,
): MemoryPort {
  return {
    async lookup(sourceTexts) {
      const byHash = new Map<string, MemoryEntry>();
      if (sourceTexts.length === 0) return byHash;

      const hashes = [...new Set(sourceTexts.map(memoryHash))];

      for (let i = 0; i < hashes.length; i += LOOKUP_CHUNK) {
        const slice = hashes.slice(i, i + LOOKUP_CHUNK);
        const { data, error } = await db
          .from("translation_memory")
          .select("id, source_hash, translated_text, origin")
          .eq("org_id", orgId)
          .eq("source_language", sourceLanguage)
          .eq("target_language", targetLanguage)
          .in("source_hash", slice);

        if (error) {
          throw new Error(`translation memory lookup failed: ${error.message}`);
        }

        for (const row of data ?? []) {
          byHash.set(row.source_hash, {
            id: row.id,
            translatedText: row.translated_text,
            origin: row.origin,
          });
        }
      }

      return byHash;
    },

    async store(entries) {
      if (entries.length === 0) return;

      // Deduplicate before writing: a batch routinely contains the same new
      // line several times, and ON CONFLICT cannot resolve duplicates that
      // arrive within a single statement.
      const unique = new Map<string, NewMemoryEntry & { hash: string }>();
      for (const entry of entries) {
        const hash = memoryHash(entry.sourceText);
        const existing = unique.get(hash);
        // A human entry in the same batch wins over a machine one.
        if (!existing || (entry.origin === "human" && existing.origin !== "human")) {
          unique.set(hash, { ...entry, hash });
        }
      }

      for (const entry of unique.values()) {
        const { error } = await db.rpc("upsert_translation_memory", {
          p_org_id: orgId,
          p_source_hash: entry.hash,
          p_source_text: entry.sourceText,
          p_source_language: sourceLanguage,
          p_target_language: targetLanguage,
          p_translated_text: entry.translatedText,
          p_origin: entry.origin ?? "machine",
        });

        // A cache write failing must not fail the translation that succeeded.
        if (error) {
          console.warn(`[tm] failed to store entry: ${error.message}`);
        }
      }
    },

    async bumpUsage(ids) {
      if (ids.length === 0) return;
      const { error } = await db.rpc("bump_translation_memory_usage", {
        p_ids: [...ids],
      });
      if (error) console.warn(`[tm] failed to bump usage: ${error.message}`);
    },
  };
}

/** No-op memory, for forced re-translation and for tests. */
export const noMemory: MemoryPort = {
  async lookup() {
    return new Map();
  },
  async store() {},
  async bumpUsage() {},
};

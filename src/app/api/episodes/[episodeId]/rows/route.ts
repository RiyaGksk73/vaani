import { NextResponse } from "next/server";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { Database, TranslationStatus } from "@/lib/supabase/database.types";
import { isLanguageCode, memoryHash } from "@/services/translation";

/**
 * GET  /api/episodes/:id/rows?lang=hi-IN  - every row of the episode with its
 *      translation, in script order. The page only shows 100 at a time; copy
 *      to Excel needs the whole episode.
 * POST /api/episodes/:id/rows             - { targetLanguage, action: "approve" }
 *      approves every translated row (machine or edited) in one go.
 *
 * Both run as the signed-in user, so RLS decides who may read and approve -
 * the same rule as approving a single cell.
 */

export interface EpisodeRow {
  rowIndex: number;
  characterName: string | null;
  sourceText: string;
  translationId: number | null;
  translatedText: string | null;
  status: TranslationStatus;
}

const PAGE = 1000;
const WRITE_CHUNK = 500;

async function loadRows(
  supabase: SupabaseClient<Database>,
  episodeId: string,
  targetLanguage: string,
): Promise<EpisodeRow[]> {
  const rows: EpisodeRow[] = [];
  // PostgREST caps a response at 1000 rows; page through bigger episodes.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("script_rows")
      .select("row_index, character_name, source_text, translations(id, translated_text, status, target_language)")
      .eq("episode_id", episodeId)
      .eq("translations.target_language", targetLanguage)
      .order("row_index")
      .range(from, from + PAGE - 1);

    if (error) throw new Error(error.message);
    // database.types.ts declares no relationships, so the embed is untyped.
    const page = (data ?? []) as unknown as {
      row_index: number;
      character_name: string | null;
      source_text: string;
      translations: { id: number; translated_text: string | null; status: TranslationStatus }[] | null;
    }[];
    for (const r of page) {
      const t = r.translations?.[0];
      rows.push({
        rowIndex: r.row_index,
        characterName: r.character_name,
        sourceText: r.source_text,
        translationId: t?.id ?? null,
        translatedText: t?.translated_text ?? null,
        status: t?.status ?? "pending",
      });
    }
    if (page.length < PAGE) break;
  }
  return rows;
}

async function requireUser(supabase: SupabaseClient<Database>) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ episodeId: string }> },
) {
  const { episodeId } = await context.params;
  const lang = new URL(request.url).searchParams.get("lang") ?? "";
  if (!isLanguageCode(lang)) {
    return NextResponse.json({ error: "unsupported target language" }, { status: 400 });
  }

  const supabase = await createClient();
  if (!(await requireUser(supabase))) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  try {
    return NextResponse.json({ rows: await loadRows(supabase, episodeId, lang) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "could not load rows" },
      { status: 500 },
    );
  }
}

const bodySchema = z.object({
  action: z.literal("approve"),
  targetLanguage: z.string().refine(isLanguageCode, { message: "unsupported target language" }),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ episodeId: string }> },
) {
  const { episodeId } = await context.params;
  const supabase = await createClient();
  const user = await requireUser(supabase);
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { targetLanguage } = parsed.data;

  const { data: episode } = await supabase
    .from("episodes")
    .select("org_id, books(source_language)")
    .eq("id", episodeId)
    .maybeSingle();
  if (!episode) return NextResponse.json({ error: "episode not found" }, { status: 404 });
  const book = Array.isArray(episode.books) ? episode.books[0] : episode.books;
  const sourceLanguage = book?.source_language ?? "";

  let rows: EpisodeRow[];
  try {
    rows = await loadRows(supabase, episodeId, targetLanguage);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "could not load rows" },
      { status: 500 },
    );
  }

  // Only rows that actually have a translation to sign off. Pending and
  // failed rows have nothing to approve.
  const approvable = rows.filter(
    (r) =>
      r.translationId !== null &&
      r.translatedText &&
      (r.status === "machine" || r.status === "edited"),
  );

  for (let i = 0; i < approvable.length; i += WRITE_CHUNK) {
    const ids = approvable.slice(i, i + WRITE_CHUNK).map((r) => r.translationId!);
    const { error } = await supabase
      .from("translations")
      .update({ status: "approved", origin: "human", edited_by: user.id, error: null })
      .in("id", ids);
    if (error) {
      const status = error.code === "42501" ? 403 : 500;
      return NextResponse.json(
        { error: `Approved ${i} of ${approvable.length}, then: ${error.message}` },
        { status },
      );
    }
  }

  // An approved line is a human-vetted line: promote it in translation memory
  // so it is reused verbatim, exactly as approving a single cell does.
  const memory = new Map<string, Database["public"]["Tables"]["translation_memory"]["Insert"]>();
  for (const r of approvable) {
    const hash = memoryHash(r.sourceText);
    memory.set(hash, {
      org_id: episode.org_id,
      source_hash: hash,
      source_text: r.sourceText,
      source_language: sourceLanguage,
      target_language: targetLanguage,
      translated_text: r.translatedText!,
      origin: "human",
      created_by: user.id,
    });
  }
  const entries = [...memory.values()];
  for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
    const { error } = await supabase
      .from("translation_memory")
      .upsert(entries.slice(i, i + WRITE_CHUNK), {
        onConflict: "org_id,source_hash,source_language,target_language",
      });
    // The approvals already landed; a cache write failing must not undo them.
    if (error) console.warn(`[approve] translation memory update failed: ${error.message}`);
  }

  return NextResponse.json({ approved: approvable.length });
}

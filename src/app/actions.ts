"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, getCurrentOrg } from "@/lib/supabase/server";
import { isLanguageCode, parseScriptLine } from "@/services/translation";

export interface FormState {
  error?: string;
  message?: string;
}

export async function createBook(_prev: FormState, formData: FormData): Promise<FormState> {
  const title = String(formData.get("title") ?? "").trim();
  const sourceLanguage = String(formData.get("sourceLanguage") ?? "");
  const description = String(formData.get("description") ?? "").trim();

  if (!title) return { error: "A title is required." };
  if (!isLanguageCode(sourceLanguage)) return { error: "Pick a source language." };

  const org = await getCurrentOrg();
  if (!org) return { error: "Your workspace is not set up yet. Sign out and sign in again." };

  const supabase = await createClient();
  const { error } = await supabase.from("books").insert({
    org_id: org.id,
    title,
    source_language: sourceLanguage,
    description: description || null,
  });

  if (error) return { error: error.message };

  revalidatePath("/");
  return { message: `Created "${title}".` };
}

export async function createEpisode(_prev: FormState, formData: FormData): Promise<FormState> {
  const bookId = String(formData.get("bookId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const number = Number(formData.get("number"));

  if (!bookId) return { error: "Missing book." };
  if (!title) return { error: "An episode title is required." };
  if (!Number.isInteger(number) || number < 0) return { error: "Episode number must be a whole number." };

  const org = await getCurrentOrg();
  if (!org) return { error: "Your workspace is not set up yet. Sign out and sign in again." };

  const supabase = await createClient();
  const { error } = await supabase
    .from("episodes")
    .insert({ book_id: bookId, org_id: org.id, number, title });

  if (error) {
    return {
      error: error.code === "23505" ? `Episode ${number} already exists in this book.` : error.message,
    };
  }

  revalidatePath(`/books/${bookId}`);
  return { message: `Added episode ${number}.` };
}

/**
 * Bulk script import.
 *
 * Accepts one line per row, either "CHARACTER: dialogue" or bare dialogue.
 * Rows are inserted in chunks so a 20,000-line episode does not arrive as one
 * enormous statement.
 */
export async function importScriptRows(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const episodeId = String(formData.get("episodeId") ?? "");
  const raw = String(formData.get("script") ?? "");

  if (!episodeId) return { error: "Missing episode." };

  const lines = raw
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return { error: "Nothing to import." };

  const org = await getCurrentOrg();
  if (!org) return { error: "Your workspace is not set up yet. Sign out and sign in again." };

  const supabase = await createClient();

  // Continue numbering after whatever is already there.
  const { data: last } = await supabase
    .from("script_rows")
    .select("row_index")
    .eq("episode_id", episodeId)
    .order("row_index", { ascending: false })
    .limit(1)
    .maybeSingle();

  let index = (last?.row_index ?? -1) + 1;

  const rows = lines.map((line) => {
    const { characterName, text } = parseScriptLine(line);

    return {
      episode_id: episodeId,
      org_id: org.id,
      row_index: index++,
      character_name: characterName,
      source_text: text,
    };
  });

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from("script_rows").insert(rows.slice(i, i + CHUNK));
    if (error) {
      return { error: `Imported ${i} of ${rows.length} rows, then: ${error.message}` };
    }
  }

  revalidatePath(`/episodes/${episodeId}`);
  return { message: `Imported ${rows.length} rows.` };
}

export async function startTranslation(formData: FormData) {
  const episodeId = String(formData.get("episodeId") ?? "");
  const targetLanguage = String(formData.get("targetLanguage") ?? "");

  if (!episodeId || !isLanguageCode(targetLanguage)) return;

  const supabase = await createClient();
  await supabase.rpc("enqueue_translation_job", {
    p_episode_id: episodeId,
    p_target_language: targetLanguage,
    p_retranslate: false,
  });

  revalidatePath(`/episodes/${episodeId}`);
  redirect(`/episodes/${episodeId}?lang=${targetLanguage}`);
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isLanguageCode } from "@/services/translation";

/**
 * POST /api/translate
 *
 * Queues an episode for translation and returns immediately. The work is done
 * by the worker (scripts/worker.ts or POST /api/worker/tick) - a request that
 * translated inline would time out long before a 5,000-row episode finished.
 *
 * Idempotent: enqueue_translation_job returns the live job if one already
 * exists for this episode/language pair.
 */

const bodySchema = z.object({
  episodeId: z.string().uuid(),
  targetLanguage: z.string().refine(isLanguageCode, {
    message: "unsupported target language",
  }),
  /** Re-translate rows that are already done, including human-edited ones. */
  retranslate: z.boolean().optional().default(false),
});

export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { episodeId, targetLanguage, retranslate } = parsed.data;

  // Runs as the user: enqueue_translation_job checks org membership itself and
  // raises insufficient_privilege for viewers and reviewers.
  const { data: jobId, error } = await supabase.rpc("enqueue_translation_job", {
    p_episode_id: episodeId,
    p_target_language: targetLanguage,
    p_retranslate: retranslate,
  });

  if (error) {
    const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  const { data: job } = await supabase
    .from("translation_jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  return NextResponse.json({ jobId, job }, { status: 202 });
}

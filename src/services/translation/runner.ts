/**
 * Job execution.
 *
 * One slice of work is: claim N queued items with SKIP LOCKED, translate them
 * (memory first, then bounded-concurrency provider calls), write the results
 * back in a single statement, and settle the queue items. Progress lands on
 * translation_jobs, which Realtime pushes to the browser.
 *
 * The loop is safe to run in several processes at once - claiming is the only
 * contended step and Postgres arbitrates it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { serverEnv } from "@/lib/env";
import type { Database, TranslationJob } from "@/lib/supabase/database.types";
import { createSupabaseMemory } from "./memory";
import { createTranslator, Translator } from "./translator";
import { isLanguageCode } from "./languages";
import { TranslationError, type LanguageCode, type ScriptSegment } from "./types";

/**
 * Server-side only. Not `import "server-only"` because the standalone worker
 * (scripts/worker.ts) runs outside Next and has to import this too; the check
 * below gives the same browser protection without the bundler condition.
 */
if (typeof window !== "undefined") {
  throw new Error("runner.ts must not be imported into client code");
}


export interface SliceResult {
  claimed: number;
  done: number;
  failed: number;
  requeued: number;
  fromMemory: number;
  providerCalls: number;
  job: TranslationJob | null;
}

export interface RunOptions {
  workerId?: string;
  batchSize?: number;
  concurrency?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

interface JobContext {
  job: TranslationJob;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
}

async function loadJobContext(
  db: SupabaseClient<Database>,
  jobId: string,
): Promise<JobContext> {
  const { data: job, error } = await db
    .from("translation_jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (error || !job) throw new Error(`job ${jobId} not found: ${error?.message ?? "no row"}`);

  // The source language belongs to the book, not the job - one book is always
  // authored in one language.
  const { data: episode, error: episodeError } = await db
    .from("episodes")
    .select("id, books(source_language)")
    .eq("id", job.episode_id)
    .single();

  if (episodeError || !episode) {
    throw new Error(`episode ${job.episode_id} not found: ${episodeError?.message ?? "no row"}`);
  }

  const book = Array.isArray(episode.books) ? episode.books[0] : episode.books;
  const sourceLanguage = book?.source_language;

  if (!sourceLanguage || !isLanguageCode(sourceLanguage)) {
    throw new Error(`book source language "${sourceLanguage}" is not supported`);
  }
  if (!isLanguageCode(job.target_language)) {
    throw new Error(`target language "${job.target_language}" is not supported`);
  }

  return { job, sourceLanguage, targetLanguage: job.target_language };
}

/**
 * Process one slice. Returns `claimed: 0` when the queue for this job is
 * drained, which is the loop's exit condition.
 */
export async function runJobSlice(
  db: SupabaseClient<Database>,
  translator: Translator,
  jobId: string,
  options: RunOptions = {},
): Promise<SliceResult> {
  const env = serverEnv();
  const workerId = options.workerId ?? `worker-${process.pid}`;
  const batchSize = options.batchSize ?? env.TRANSLATION_BATCH_SIZE;
  const concurrency = options.concurrency ?? env.TRANSLATION_CONCURRENCY;
  const maxAttempts = options.maxAttempts ?? env.TRANSLATION_MAX_ATTEMPTS;

  const empty: SliceResult = {
    claimed: 0,
    done: 0,
    failed: 0,
    requeued: 0,
    fromMemory: 0,
    providerCalls: 0,
    job: null,
  };

  const { job, sourceLanguage, targetLanguage } = await loadJobContext(db, jobId);

  const { data: claimed, error: claimError } = await db.rpc("claim_job_items", {
    p_job_id: jobId,
    p_limit: batchSize,
    p_worker: workerId,
  });

  if (claimError) throw new Error(`claim failed: ${claimError.message}`);
  if (!claimed || claimed.length === 0) return { ...empty, job };

  const attemptsByRow = new Map(claimed.map((c) => [c.script_row_id, c.attempts]));
  const segments: ScriptSegment[] = claimed.map((c) => ({
    id: c.script_row_id,
    characterName: c.character_name,
    sourceText: c.source_text,
  }));

  const memory = createSupabaseMemory(db, {
    orgId: job.org_id,
    sourceLanguage,
    targetLanguage,
  });

  let results;
  let stats;
  try {
    ({ results, stats } = await translator.translateBatch(segments, {
      orgId: job.org_id,
      sourceLanguage,
      targetLanguage,
      concurrency,
      memory,
    }));
  } catch (error) {
    // The whole slice blew up - an unsupported pair, a missing key, something
    // structural. Put the work back and fail the job loudly instead of
    // grinding through every row to reach the same conclusion.
    await db.rpc("mark_job_items", {
      p_job_id: jobId,
      p_row_ids: claimed.map((c) => c.script_row_id),
      p_status: "queued",
      p_error: null,
    });
    await db
      .from("translation_jobs")
      .update({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finished_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    throw error;
  }

  // ---- write translations in one statement ---------------------------------
  const payload = results.map((r) => ({
    script_row_id: r.id,
    translated_text: r.translatedText,
    status: r.outcome === "failed" ? "pending" : "machine",
    provider: r.provider ?? null,
    model: r.model ?? null,
    tm_hit: r.outcome === "memory",
    error: r.error ?? null,
  }));

  const { error: applyError } = await db.rpc("apply_translation_results", {
    p_org_id: job.org_id,
    p_target_language: targetLanguage,
    p_results: payload,
  });
  if (applyError) throw new Error(`writeback failed: ${applyError.message}`);

  // ---- settle the queue ----------------------------------------------------
  const doneIds: number[] = [];
  const retryIds: number[] = [];
  const deadIds: number[] = [];
  let lastError: string | null = null;

  for (const result of results) {
    if (result.outcome !== "failed") {
      doneIds.push(result.id);
      continue;
    }
    lastError = result.error ?? lastError;
    const attempts = attemptsByRow.get(result.id) ?? maxAttempts;
    if (attempts >= maxAttempts) deadIds.push(result.id);
    else retryIds.push(result.id);
  }

  let job$: TranslationJob | null = job;

  if (doneIds.length > 0) {
    const { data } = await db.rpc("mark_job_items", {
      p_job_id: jobId,
      p_row_ids: doneIds,
      p_status: "done",
      p_error: null,
    });
    if (data) job$ = data as unknown as TranslationJob;
  }

  // Under the attempt budget: back on the queue for another pass.
  if (retryIds.length > 0) {
    const { data } = await db.rpc("mark_job_items", {
      p_job_id: jobId,
      p_row_ids: retryIds,
      p_status: "queued",
      p_error: lastError,
    });
    if (data) job$ = data as unknown as TranslationJob;
  }

  // Budget exhausted: park as failed so a human sees it in the review queue.
  if (deadIds.length > 0) {
    await db.rpc("apply_translation_results", {
      p_org_id: job.org_id,
      p_target_language: targetLanguage,
      p_results: deadIds.map((id) => ({
        script_row_id: id,
        translated_text: null,
        status: "failed",
        provider: null,
        model: null,
        tm_hit: false,
        error: lastError,
      })),
    });
    const { data } = await db.rpc("mark_job_items", {
      p_job_id: jobId,
      p_row_ids: deadIds,
      p_status: "failed",
      p_error: lastError,
    });
    if (data) job$ = data as unknown as TranslationJob;
  }

  return {
    claimed: claimed.length,
    done: doneIds.length,
    failed: deadIds.length,
    requeued: retryIds.length,
    fromMemory: stats.fromMemory,
    providerCalls: stats.providerCalls,
    job: job$,
  };
}

/** Drain one job. `maxSlices` bounds a single HTTP-triggered tick. */
export async function runJob(
  db: SupabaseClient<Database>,
  translator: Translator,
  jobId: string,
  options: RunOptions & { maxSlices?: number } = {},
): Promise<SliceResult> {
  const maxSlices = options.maxSlices ?? Number.POSITIVE_INFINITY;
  const totals: SliceResult = {
    claimed: 0,
    done: 0,
    failed: 0,
    requeued: 0,
    fromMemory: 0,
    providerCalls: 0,
    job: null,
  };

  for (let slice = 0; slice < maxSlices; slice++) {
    if (options.signal?.aborted) break;

    const result = await runJobSlice(db, translator, jobId, options);
    totals.claimed += result.claimed;
    totals.done += result.done;
    totals.failed += result.failed;
    totals.requeued += result.requeued;
    totals.fromMemory += result.fromMemory;
    totals.providerCalls += result.providerCalls;
    totals.job = result.job ?? totals.job;

    if (result.claimed === 0) break;
    // Only requeues left and nothing progressed: stop spinning on rows that
    // keep failing; the next tick will pick them up.
    if (result.done === 0 && result.failed === 0 && result.requeued > 0) break;
  }

  return totals;
}

/**
 * One tick of the background worker: recover abandoned work, then drain the
 * oldest job with anything queued.
 */
export async function runWorkerTick(
  options: RunOptions & { maxSlices?: number } = {},
): Promise<{ jobId: string | null; requeuedStuck: number; result: SliceResult | null }> {
  const env = serverEnv();
  const db = createAdminClient();
  const translator = createTranslator({
    apiKey: env.SARVAM_API_KEY,
    baseUrl: env.SARVAM_API_BASE_URL,
    model: env.SARVAM_MODEL,
    engine: env.TRANSLATION_ENGINE,
    chatModel: env.SARVAM_CHAT_MODEL,
  });

  const { data: requeuedStuck } = await db.rpc("requeue_stuck_job_items", {
    p_older_than: "10 minutes",
    p_max_attempts: options.maxAttempts ?? env.TRANSLATION_MAX_ATTEMPTS,
  });

  const { data: jobId, error } = await db.rpc("next_runnable_job", {});
  if (error) throw new Error(`could not pick a job: ${error.message}`);
  if (!jobId) {
    return { jobId: null, requeuedStuck: requeuedStuck ?? 0, result: null };
  }

  const result = await runJob(db, translator, jobId, options);
  return { jobId, requeuedStuck: requeuedStuck ?? 0, result };
}

export { TranslationError };

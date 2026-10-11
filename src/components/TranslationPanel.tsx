"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { TranslationJob } from "@/lib/supabase/database.types";
import { LANGUAGES, languageLabel } from "@/services/translation/languages";

interface Props {
  episodeId: string;
  sourceLanguage: string;
  targetLanguage: string;
  canTranslate: boolean;
  initialJob: TranslationJob | null;
  pendingRows: number;
  totalRows: number;
}

/**
 * Translate control plus live progress.
 *
 * Progress arrives over Supabase Realtime rather than polling: the worker
 * updates translation_jobs once per settled slice, and every viewer of the
 * episode sees the same counters move. Polling a job table from a dozen
 * reviewers' browsers would cost far more than the translation itself.
 */
export function TranslationPanel({
  episodeId,
  sourceLanguage,
  targetLanguage,
  canTranslate,
  initialJob,
  pendingRows,
  totalRows,
}: Props) {
  const router = useRouter();
  const [job, setJob] = useState<TranslationJob | null>(initialJob);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => setJob(initialJob), [initialJob]);

  // Live job updates for this episode. Filtering server-side keeps the socket
  // quiet on a workspace running many jobs at once.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`job:${episodeId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "translation_jobs",
          filter: `episode_id=eq.${episodeId}`,
        },
        (payload) => {
          const next = payload.new as TranslationJob;
          if (!next?.id || next.target_language !== targetLanguage) return;
          setJob(next);
          // Rows have changed underneath us; pull the fresh page in.
          if (next.status === "completed" || next.status === "failed") {
            startTransition(() => router.refresh());
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [episodeId, targetLanguage, router]);

  const onTranslate = useCallback(
    async (retranslate: boolean) => {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ episodeId, targetLanguage, retranslate }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not queue the job.");
      setJob(payload.job ?? null);
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not queue the job.");
    } finally {
      setStarting(false);
    }
    },
    [episodeId, targetLanguage, router],
  );

  const settled = job ? job.completed_rows + job.failed_rows : 0;
  const percent = job && job.total_rows > 0 ? Math.round((settled / job.total_rows) * 100) : 0;
  const running = job?.status === "queued" || job?.status === "running";
  const sameLanguage = sourceLanguage === targetLanguage;

  // An episode with nothing left pending is finished, not broken. Without this
  // the button rendered as a dead "Translate 0 rows" and there was no way to
  // run the language again.
  const allDone = pendingRows === 0 && totalRows > 0;
  const blocked = !canTranslate || sameLanguage || totalRows === 0;

  return (
    <div className="card card-pad" style={{ marginBottom: 24 }}>
      <div className="row" style={{ gap: 14 }}>
        <div style={{ minWidth: 210 }}>
          <label htmlFor="lang">Target language</label>
          <select
            id="lang"
            value={targetLanguage}
            onChange={(event) => router.push(`/episodes/${episodeId}?lang=${event.target.value}`)}
          >
            {LANGUAGES.filter((l) => l.code !== sourceLanguage).map((lang) => (
              <option key={lang.code} value={lang.code}>
                {languageLabel(lang.code)}
              </option>
            ))}
          </select>
        </div>

        <div className="row" style={{ paddingTop: 21, gap: 8 }}>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onTranslate(allDone)}
            disabled={blocked || starting || running}
            title={
              !canTranslate
                ? "You need editor access to start a translation"
                : totalRows === 0
                  ? "This episode has no script rows yet - import some below"
                  : allDone
                    ? "Every row is already translated. This runs them again; cached lines cost nothing."
                    : undefined
            }
          >
            {starting
              ? "Queueing..."
              : running
                ? "Translating..."
                : totalRows === 0
                  ? "Nothing to translate"
                  : allDone
                    ? `Re-translate ${totalRows.toLocaleString()} row${totalRows === 1 ? "" : "s"}`
                    : `Translate ${pendingRows.toLocaleString()} row${pendingRows === 1 ? "" : "s"}`}
          </button>

          {allDone && !running ? (
            <span className="badge badge-ok" title="Nothing is pending for this language">
              All {totalRows.toLocaleString()} rows translated
            </span>
          ) : null}
        </div>

        <div className="spacer" />

        {job ? (
          <div style={{ minWidth: 240, paddingTop: 4 }}>
            <div className="row small" style={{ justifyContent: "space-between", marginBottom: 6 }}>
              <span className="muted">
                {settled.toLocaleString()} / {job.total_rows.toLocaleString()}
              </span>
              <span className="muted">
                {job.tm_hits > 0 ? `${job.tm_hits.toLocaleString()} from memory · ` : ""}
                {percent}%
              </span>
            </div>
            <div className="progress">
              <div
                className={`progress-bar${
                  job.status === "completed" ? " done" : job.status === "failed" ? " failed" : ""
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>
            {job.failed_rows > 0 ? (
              <p className="small error-text" style={{ margin: "6px 0 0" }}>
                {job.failed_rows.toLocaleString()} row(s) need manual attention.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {sameLanguage ? (
        <p className="small muted" style={{ margin: "12px 0 0" }}>
          Pick a target language different from the source.
        </p>
      ) : null}

      {job?.error ? (
        <p className="error-text" style={{ marginBottom: 0 }}>
          {job.error}
        </p>
      ) : null}
      {error ? (
        <p className="error-text" style={{ marginBottom: 0 }}>
          {error}
        </p>
      ) : null}

      {running ? (
        <p className="small faint" style={{ margin: "12px 0 0" }}>
          Work is done by the background worker. If nothing moves, check that{" "}
          <code>npm run worker</code> is running.
        </p>
      ) : null}
    </div>
  );
}

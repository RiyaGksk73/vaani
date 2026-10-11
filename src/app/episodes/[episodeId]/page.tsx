import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient, getCurrentOrg } from "@/lib/supabase/server";
import { isLanguageCode, languageLabel } from "@/services/translation";
import type { ScriptRowSearchResult, TranslationJob } from "@/lib/supabase/database.types";
import { TranslationPanel } from "@/components/TranslationPanel";
import { ScriptTable } from "@/components/ScriptTable";
import { ImportScriptForm } from "@/components/ImportScriptForm";
import { SearchBar } from "@/components/SearchBar";
import { ExportBar } from "@/components/ExportBar";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function EpisodePage({
  params,
  searchParams,
}: {
  params: Promise<{ episodeId: string }>;
  searchParams: Promise<{ lang?: string; q?: string; after?: string }>;
}) {
  const { episodeId } = await params;
  const { lang, q, after } = await searchParams;

  const org = await getCurrentOrg();
  if (!org) notFound();

  const supabase = await createClient();

  const { data: episode } = await supabase
    .from("episodes")
    .select("id, number, title, book_id, books(id, title, source_language)")
    .eq("id", episodeId)
    .maybeSingle();

  if (!episode) notFound();

  const book = Array.isArray(episode.books) ? episode.books[0] : episode.books;
  if (!book) notFound();

  const sourceLanguage = book.source_language;
  const targetLanguage =
    lang && isLanguageCode(lang) && lang !== sourceLanguage
      ? lang
      : sourceLanguage === "hi-IN"
        ? "en-IN"
        : "hi-IN";

  const cursor = Number(after ?? 0);

  const [{ data: rows }, { data: progressRows }, { data: jobs }] = await Promise.all([
    supabase.rpc("search_script_rows", {
      p_org_id: org.id,
      p_query: q ?? null,
      p_episode_id: episodeId,
      p_book_id: null,
      p_target_language: targetLanguage,
      p_limit: PAGE_SIZE,
      p_after: Number.isFinite(cursor) ? cursor : 0,
    }),
    supabase.rpc("episode_translation_progress", {
      p_episode_id: episodeId,
      p_target_language: targetLanguage,
    }),
    supabase
      .from("translation_jobs")
      .select("*")
      .eq("episode_id", episodeId)
      .eq("target_language", targetLanguage)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const scriptRows = (rows ?? []) as ScriptRowSearchResult[];
  const progress = progressRows?.[0] ?? {
    total: 0,
    pending: 0,
    machine: 0,
    edited: 0,
    approved: 0,
    failed: 0,
  };
  const job = (jobs?.[0] ?? null) as TranslationJob | null;
  const canEdit = org.role === "owner" || org.role === "editor" || org.role === "reviewer";
  const canTranslate = org.role === "owner" || org.role === "editor";

  const nextCursor = scriptRows.length === PAGE_SIZE ? scriptRows.at(-1)?.id : undefined;
  const query = new URLSearchParams({ lang: targetLanguage });
  if (q) query.set("q", q);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="breadcrumb">
            <Link href="/">Source books</Link> / <Link href={`/books/${book.id}`}>{book.title}</Link>
          </div>
          <h1>
            {episode.number}. {episode.title}
          </h1>
          <p className="muted small" style={{ margin: "6px 0 0" }}>
            {languageLabel(sourceLanguage)} → {languageLabel(targetLanguage)}
          </p>
        </div>

        <div className="spacer" />

        <div className="stat-row">
          <div>
            <div className="stat-label">Rows</div>
            <div className="stat-value">{Number(progress.total).toLocaleString()}</div>
          </div>
          <div>
            <div className="stat-label">Translated</div>
            <div className="stat-value">
              {(
                Number(progress.machine) +
                Number(progress.edited) +
                Number(progress.approved)
              ).toLocaleString()}
            </div>
          </div>
          <div>
            <div className="stat-label">Approved</div>
            <div className="stat-value">{Number(progress.approved).toLocaleString()}</div>
          </div>
          {Number(progress.failed) > 0 ? (
            <div>
              <div className="stat-label">Failed</div>
              <div className="stat-value" style={{ color: "var(--danger)" }}>
                {Number(progress.failed).toLocaleString()}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <TranslationPanel
        episodeId={episodeId}
        sourceLanguage={sourceLanguage}
        targetLanguage={targetLanguage}
        canTranslate={canTranslate}
        initialJob={job}
        pendingRows={Number(progress.pending) + Number(progress.failed)}
        totalRows={Number(progress.total)}
      />

      <ExportBar
        episodeId={episodeId}
        sourceLanguage={sourceLanguage}
        targetLanguage={targetLanguage}
        canApprove={canEdit}
        approvableRows={Number(progress.machine) + Number(progress.edited)}
        translatedRows={
          Number(progress.machine) + Number(progress.edited) + Number(progress.approved)
        }
      />

      <SearchBar episodeId={episodeId} targetLanguage={targetLanguage} initialQuery={q ?? ""} />

      <ScriptTable rows={scriptRows} targetLanguage={targetLanguage} canEdit={canEdit} />

      <div className="row" style={{ marginTop: 16, justifyContent: "space-between" }}>
        <span className="small faint">
          Showing {scriptRows.length.toLocaleString()} row
          {scriptRows.length === 1 ? "" : "s"}
          {cursor > 0 ? " (continued)" : ""}
        </span>
        <span className="row" style={{ gap: 8 }}>
          {cursor > 0 ? (
            <Link href={`/episodes/${episodeId}?${query}`} className="btn btn-sm">
              First page
            </Link>
          ) : null}
          {nextCursor ? (
            <Link
              href={`/episodes/${episodeId}?${query}&after=${nextCursor}`}
              className="btn btn-sm"
            >
              Next {PAGE_SIZE}
            </Link>
          ) : null}
        </span>
      </div>

      {canTranslate ? (
        <div style={{ marginTop: 32 }}>
          <ImportScriptForm episodeId={episodeId} />
        </div>
      ) : null}
    </>
  );
}

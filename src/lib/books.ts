import "server-only";

import { createClient } from "@/lib/supabase/server";
import {
  BOOK_CATEGORIES,
  categoryLabel,
  isBookCategory,
  type BookCategory,
} from "@/lib/book-categories";

export { BOOK_CATEGORIES, categoryLabel, isBookCategory, type BookCategory };

export type BookStatus = "translated" | "in_progress" | "pending";

export interface BookListItem {
  id: string;
  title: string;
  author: string | null;
  category: string | null;
  description: string | null;
  sourceLanguage: string;
  createdAt: string;
  chapters: number;
  /** Target languages with a finished or running job, most recent first. */
  targetLanguages: string[];
  status: BookStatus;
}

export interface BookListResult {
  books: BookListItem[];
  error: string | null;
  /** False until 0007_book_metadata.sql has been applied. */
  hasMetadata: boolean;
}

interface BookRow {
  id: string;
  title: string;
  author?: string | null;
  category?: string | null;
  description: string | null;
  source_language: string;
  created_at: string;
  episodes: { count: number }[] | null;
}

interface JobRow {
  episode_id: string;
  target_language: string;
  status: string;
  episodes: { book_id: string } | { book_id: string }[] | null;
}

const BASE_COLUMNS = "id, title, description, source_language, created_at, episodes(count)";

/** PostgREST `or` filters treat these as syntax, so they cannot appear in a value. */
function sanitizeSearch(q: string) {
  return q.replace(/[%,()*\\]/g, " ").trim();
}

function isMissingColumn(error: { code?: string; message?: string } | null) {
  return (
    !!error &&
    (error.code === "42703" ||
      error.code === "PGRST204" ||
      /column .*(author|category)/i.test(error.message ?? ""))
  );
}

/**
 * Books for the dashboards, with chapter counts and a translation status
 * derived from the job queue.
 *
 * Status: "in_progress" while any job for the book is queued or running;
 * "translated" once every chapter has at least one completed job; otherwise
 * "pending".
 */
export async function listBooks({
  orgId,
  q,
  category,
}: {
  orgId: string;
  q?: string;
  category?: BookCategory;
}): Promise<BookListResult> {
  const supabase = await createClient();
  const search = q ? sanitizeSearch(q) : "";

  const run = (withMetadata: boolean) => {
    let query = supabase
      .from("books")
      .select(withMetadata ? `${BASE_COLUMNS}, author, category` : BASE_COLUMNS)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (search) {
      query = withMetadata
        ? query.or(`title.ilike.%${search}%,author.ilike.%${search}%`)
        : query.ilike("title", `%${search}%`);
    }
    if (category && withMetadata) query = query.eq("category", category);
    return query;
  };

  let hasMetadata = true;
  let { data, error } = await run(true);

  if (isMissingColumn(error)) {
    hasMetadata = false;
    ({ data, error } = await run(false));
  }

  if (error) return { books: [], error: error.message, hasMetadata };

  // Without the category column no book can belong to a category.
  const rows = (category && !hasMetadata ? [] : (data ?? [])) as unknown as BookRow[];
  if (rows.length === 0) return { books: [], error: null, hasMetadata };

  const { data: jobData } = await supabase
    .from("translation_jobs")
    .select("episode_id, target_language, status, episodes!inner(book_id)")
    .eq("org_id", orgId)
    .in("status", ["queued", "running", "completed"])
    .in(
      "episodes.book_id",
      rows.map((r) => r.id),
    )
    .order("created_at", { ascending: false })
    .limit(5000);

  const jobsByBook = new Map<string, JobRow[]>();
  for (const job of (jobData ?? []) as unknown as JobRow[]) {
    const episode = Array.isArray(job.episodes) ? job.episodes[0] : job.episodes;
    if (!episode) continue;
    const list = jobsByBook.get(episode.book_id) ?? [];
    list.push(job);
    jobsByBook.set(episode.book_id, list);
  }

  const books = rows.map((row): BookListItem => {
    const chapters = Array.isArray(row.episodes) ? (row.episodes[0]?.count ?? 0) : 0;
    const jobs = jobsByBook.get(row.id) ?? [];

    const active = jobs.some((j) => j.status === "queued" || j.status === "running");
    const completedEpisodes = new Set(
      jobs.filter((j) => j.status === "completed").map((j) => j.episode_id),
    );

    let status: BookStatus = "pending";
    if (active) status = "in_progress";
    else if (chapters > 0 && completedEpisodes.size >= chapters) status = "translated";

    return {
      id: row.id,
      title: row.title,
      author: row.author ?? null,
      category: row.category ?? null,
      description: row.description,
      sourceLanguage: row.source_language,
      createdAt: row.created_at,
      chapters,
      targetLanguages: [...new Set(jobs.map((j) => j.target_language))],
      status,
    };
  });

  return { books, error: null, hasMetadata };
}

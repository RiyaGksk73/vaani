import Link from "next/link";
import { createClient, getCurrentOrg } from "@/lib/supabase/server";
import { Icon } from "@/components/Icon";
import { LanguagePill } from "@/components/BooksTable";

export const dynamic = "force-dynamic";

const STATUS_PILL: Record<string, string> = {
  queued: "pill pill-pending",
  running: "pill pill-info",
  completed: "pill pill-ok",
  failed: "pill pill-danger",
  cancelled: "pill",
};

const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

interface JobListRow {
  id: string;
  episode_id: string;
  target_language: string;
  status: string;
  total_rows: number;
  completed_rows: number;
  failed_rows: number;
  tm_hits: number;
  created_at: string;
  episodes: {
    number: number;
    title: string;
    books: { title: string } | { title: string }[] | null;
  } | null;
}

/** Recent translation jobs across the workspace, newest first. */
export default async function JobsPage() {
  const org = await getCurrentOrg();
  if (!org) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("translation_jobs")
    .select(
      "id, episode_id, target_language, status, total_rows, completed_rows, failed_rows, tm_hits, created_at, episodes(number, title, books(title))",
    )
    .eq("org_id", org.id)
    .order("created_at", { ascending: false })
    .limit(100);

  const jobs = (data ?? []) as unknown as JobListRow[];

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Jobs</h1>
          <p className="dash-sub">The 100 most recent translation jobs in your workspace.</p>
        </div>
      </div>

      {error ? (
        <div className="table-card empty-state">
          <h2>Could not load jobs</h2>
          <p className="error-text">{error.message}</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="table-card empty-state">
          <h2>No jobs yet</h2>
          <p className="small">Jobs appear here when you press Translate on an episode.</p>
        </div>
      ) : (
        <div className="table-card">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Book / Episode</th>
                  <th style={{ width: 150 }}>Language</th>
                  <th style={{ width: 220 }}>Progress</th>
                  <th style={{ width: 110 }}>Memory hits</th>
                  <th style={{ width: 170 }}>Started</th>
                  <th style={{ width: 130 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const episode = job.episodes;
                  const book = Array.isArray(episode?.books) ? episode.books[0] : episode?.books;
                  const pct = job.total_rows
                    ? Math.round((job.completed_rows / job.total_rows) * 100)
                    : 0;
                  return (
                    <tr key={job.id}>
                      <td>
                        <Link
                          href={`/episodes/${job.episode_id}?lang=${job.target_language}`}
                          className="cell-title"
                        >
                          {episode ? `${episode.number}. ${episode.title}` : "Deleted episode"}
                        </Link>
                        <div className="cell-sub">{book?.title ?? "—"}</div>
                      </td>
                      <td>
                        <LanguagePill code={job.target_language} />
                      </td>
                      <td>
                        <div className="progress" style={{ marginBottom: 4 }}>
                          <div
                            className={`progress-bar ${job.status === "completed" ? "done" : job.status === "failed" ? "failed" : ""}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="cell-sub">
                          {job.completed_rows.toLocaleString()} / {job.total_rows.toLocaleString()}
                          {job.failed_rows > 0 ? ` · ${job.failed_rows} failed` : ""}
                        </span>
                      </td>
                      <td className="cell-sub">{job.tm_hits.toLocaleString()}</td>
                      <td>
                        <span className="cell-meta">
                          <Icon name="calendar" size={15} />
                          {dateFormat.format(new Date(job.created_at))}
                        </span>
                      </td>
                      <td>
                        <span className={STATUS_PILL[job.status] ?? "pill"}>
                          {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

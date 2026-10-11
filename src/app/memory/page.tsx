import Link from "next/link";
import { createClient, getCurrentOrg } from "@/lib/supabase/server";
import { languageLabel } from "@/services/translation";

export const dynamic = "force-dynamic";

/**
 * Translation memory browser.
 *
 * Doubles as the cost dashboard: `use_count` is how many API calls each entry
 * has already saved, and the human/machine split shows how much of the cache
 * has been through review.
 */
export default async function MemoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const org = await getCurrentOrg();
  if (!org) return null;

  const supabase = await createClient();

  let query = supabase
    .from("translation_memory")
    .select("id, source_text, translated_text, source_language, target_language, origin, use_count")
    .eq("org_id", org.id)
    .order("use_count", { ascending: false })
    .limit(100);

  if (q) query = query.ilike("source_text", `%${q}%`);

  const [{ data: entries }, { count: total }, { count: humanCount }] = await Promise.all([
    query,
    supabase
      .from("translation_memory")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id),
    supabase
      .from("translation_memory")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org.id)
      .eq("origin", "human"),
  ]);

  const reuses = (entries ?? []).reduce((sum, entry) => sum + entry.use_count, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="breadcrumb">
            <Link href="/">Source books</Link>
          </div>
          <h1>Translation memory</h1>
          <p className="muted small" style={{ margin: "6px 0 0" }}>
            Every entry here is a call that never has to be paid for twice.
          </p>
        </div>

        <div className="spacer" />

        <div className="stat-row">
          <div>
            <div className="stat-label">Entries</div>
            <div className="stat-value">{(total ?? 0).toLocaleString()}</div>
          </div>
          <div>
            <div className="stat-label">Human-reviewed</div>
            <div className="stat-value">{(humanCount ?? 0).toLocaleString()}</div>
          </div>
          <div>
            <div className="stat-label">Reuses (top 100)</div>
            <div className="stat-value">{reuses.toLocaleString()}</div>
          </div>
        </div>
      </div>

      <form className="row" style={{ marginBottom: 16, gap: 8 }}>
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search source text..."
          style={{ flex: 1, minWidth: 220 }}
        />
        <button type="submit" className="btn-sm">
          Search
        </button>
      </form>

      {entries && entries.length > 0 ? (
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="script-table">
            <thead>
              <tr>
                <th style={{ position: "static" }}>Source</th>
                <th style={{ position: "static" }}>Translation</th>
                <th style={{ width: 150, position: "static" }}>Pair</th>
                <th style={{ width: 110, position: "static" }}>Origin</th>
                <th style={{ width: 80, position: "static" }}>Reuses</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="source-text">{entry.source_text}</td>
                  <td className="target-text">{entry.translated_text}</td>
                  <td className="small muted">
                    {languageLabel(entry.source_language).split(" ")[0]} →{" "}
                    {languageLabel(entry.target_language).split(" ")[0]}
                  </td>
                  <td>
                    <span
                      className={entry.origin === "human" ? "badge badge-ok" : "badge badge-accent"}
                    >
                      {entry.origin === "human" ? "Reviewed" : "Machine"}
                    </span>
                  </td>
                  <td className="small muted">{entry.use_count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card card-pad empty-state">
          <h2>Nothing cached yet</h2>
          <p className="small">
            Memory fills up as episodes are translated, and improves every time a reviewer
            corrects a line.
          </p>
        </div>
      )}
    </>
  );
}

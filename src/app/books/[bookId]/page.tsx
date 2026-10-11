import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { languageLabel } from "@/services/translation";
import { NewEpisodeForm } from "@/components/NewEpisodeForm";

export const dynamic = "force-dynamic";

export default async function BookPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  const supabase = await createClient();

  const { data: book } = await supabase
    .from("books")
    .select("id, title, description, source_language")
    .eq("id", bookId)
    .maybeSingle();

  if (!book) notFound();

  const { data: episodes } = await supabase
    .from("episodes")
    .select("id, number, title, created_at, script_rows(count)")
    .eq("book_id", bookId)
    .order("number", { ascending: true })
    .limit(500);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="breadcrumb">
            <Link href="/">Source books</Link>
          </div>
          <h1>{book.title}</h1>
          <p className="muted small" style={{ margin: "6px 0 0" }}>
            {book.description ? `${book.description} · ` : ""}
            Written in {languageLabel(book.source_language)}
          </p>
        </div>
      </div>

      {episodes && episodes.length > 0 ? (
        <div className="card" style={{ marginBottom: 32, overflow: "hidden" }}>
          <table className="script-table">
            <thead>
              <tr>
                <th style={{ width: 72, position: "static" }}>#</th>
                <th style={{ position: "static" }}>Episode</th>
                <th style={{ width: 120, position: "static" }}>Rows</th>
              </tr>
            </thead>
            <tbody>
              {episodes.map((episode) => {
                const rowCount = Array.isArray(episode.script_rows)
                  ? (episode.script_rows[0]?.count ?? 0)
                  : 0;
                return (
                  <tr key={episode.id}>
                    <td className="col-index">{episode.number}</td>
                    <td>
                      <Link href={`/episodes/${episode.id}`}>{episode.title}</Link>
                    </td>
                    <td className="small muted">{rowCount.toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card card-pad empty-state" style={{ marginBottom: 32 }}>
          <h2>No episodes yet</h2>
          <p className="small">Add one below, then paste or import its script.</p>
        </div>
      )}

      <NewEpisodeForm bookId={bookId} nextNumber={(episodes?.at(-1)?.number ?? 0) + 1} />
    </>
  );
}

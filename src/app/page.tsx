import Link from "next/link";
import { createClient, getCurrentOrg } from "@/lib/supabase/server";
import { languageLabel } from "@/services/translation";
import { NewBookForm } from "@/components/NewBookForm";

export const dynamic = "force-dynamic";

export default async function BooksPage() {
  const org = await getCurrentOrg();

  if (!org) {
    return (
      <div className="empty-state">
        <h2>Workspace not set up</h2>
        <p>Your account has no workspace yet. Sign out and sign in again.</p>
      </div>
    );
  }

  const supabase = await createClient();

  const { data: books } = await supabase
    .from("books")
    .select("id, title, source_language, description, created_at, episodes(count)")
    .eq("org_id", org.id)
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Source books</h1>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            {books?.length ?? 0} book{books?.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {books && books.length > 0 ? (
        <div className="grid" style={{ marginBottom: 32 }}>
          {books.map((book) => {
            const episodeCount = Array.isArray(book.episodes)
              ? (book.episodes[0]?.count ?? 0)
              : 0;
            return (
              <Link key={book.id} href={`/books/${book.id}`} className="tile">
                <h3>{book.title}</h3>
                <p className="small muted" style={{ margin: "2px 0 10px" }}>
                  {book.description || "No description"}
                </p>
                <div className="row" style={{ gap: 6 }}>
                  <span className="badge badge-accent">
                    {languageLabel(book.source_language)}
                  </span>
                  <span className="badge">
                    {episodeCount} episode{episodeCount === 1 ? "" : "s"}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="card card-pad empty-state" style={{ marginBottom: 32 }}>
          <h2>No books yet</h2>
          <p className="small">Add your first source book below to start localising.</p>
        </div>
      )}

      {org.role === "owner" || org.role === "editor" ? <NewBookForm /> : null}
    </>
  );
}

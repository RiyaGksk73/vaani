import Link from "next/link";
import { getCurrentOrg } from "@/lib/supabase/server";
import { isBookCategory, listBooks } from "@/lib/books";
import { BooksToolbar } from "@/components/BooksToolbar";
import { BooksTable } from "@/components/BooksTable";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";

export default async function TranslateDashboard({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string }>;
}) {
  const { q = "", tab } = await searchParams;
  const category = isBookCategory(tab) ? tab : undefined;

  const org = await getCurrentOrg();

  if (!org) {
    return (
      <div className="empty-state">
        <h2>Workspace not set up</h2>
        <p>Your account has no workspace yet. Sign out and sign in again.</p>
      </div>
    );
  }

  const { books, error, hasMetadata } = await listBooks({ orgId: org.id, q, category });
  const canCreate = org.role === "owner" || org.role === "editor";

  return (
    <>
      <div className="dash-head">
        <h1>Your Comics Translated Books</h1>
        {canCreate ? (
          <Link href="/source#new-book" className="btn btn-dark">
            <Icon name="plus" size={16} />
            Translate a Book
          </Link>
        ) : null}
      </div>

      <BooksToolbar basePath="/" q={q} tab={category} />

      {!hasMetadata ? (
        <p className="notice" style={{ marginBottom: 16 }}>
          Author search and categories need the <code>0007_book_metadata.sql</code> migration.
          Run <code>supabase db push</code> to enable them.
        </p>
      ) : null}

      {error ? (
        <div className="table-card empty-state">
          <h2>Could not load books</h2>
          <p className="error-text">{error}</p>
        </div>
      ) : books.length > 0 ? (
        <BooksTable books={books} variant="translate" />
      ) : (
        <div className="table-card empty-state">
          <h2>{q || category ? "No matching books" : "No books yet"}</h2>
          <p className="small">
            {q || category ? (
              "Try a different search or category."
            ) : (
              <>
                Add a source book under <Link href="/source">Source</Link>, import its script, then
                translate it from the episode page.
              </>
            )}
          </p>
        </div>
      )}
    </>
  );
}

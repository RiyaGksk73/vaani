import { getCurrentOrg } from "@/lib/supabase/server";
import { isBookCategory, listBooks } from "@/lib/books";
import { BooksToolbar } from "@/components/BooksToolbar";
import { BooksTable } from "@/components/BooksTable";
import { NewBookForm } from "@/components/NewBookForm";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";

export default async function SourceBooksPage({
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
        <div>
          <h1>Source books</h1>
          <p className="dash-sub">
            {books.length} book{books.length === 1 ? "" : "s"}
            {q || category ? " matching" : " in your workspace"}
          </p>
        </div>
        {canCreate ? (
          <a href="#new-book" className="btn btn-dark">
            <Icon name="plus" size={16} />
            New source book
          </a>
        ) : null}
      </div>

      <BooksToolbar basePath="/source" q={q} tab={category} />

      {error ? (
        <div className="table-card empty-state">
          <h2>Could not load books</h2>
          <p className="error-text">{error}</p>
        </div>
      ) : books.length > 0 ? (
        <BooksTable books={books} variant="source" />
      ) : (
        <div className="table-card empty-state">
          <h2>{q || category ? "No matching books" : "No books yet"}</h2>
          <p className="small">
            {q || category
              ? "Try a different search or category."
              : "Add your first source book below to start localising."}
          </p>
        </div>
      )}

      {canCreate ? (
        <section id="new-book" className="section">
          <NewBookForm hasMetadata={hasMetadata} />
        </section>
      ) : null}
    </>
  );
}

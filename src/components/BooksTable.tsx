import Link from "next/link";
import { getLanguage } from "@/services/translation/languages";
import { categoryLabel, type BookListItem, type BookStatus } from "@/lib/books";
import { Icon } from "@/components/Icon";

const STATUS: Record<BookStatus, { label: string; className: string }> = {
  translated: { label: "Translated", className: "pill pill-ok" },
  in_progress: { label: "In progress", className: "pill pill-info" },
  pending: { label: "Pending", className: "pill pill-pending" },
};

const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

/** Short, stable display id: the first block of the uuid. */
function bookCode(id: string) {
  return id.slice(0, 8).toUpperCase();
}

export function LanguagePill({ code }: { code: string }) {
  const lang = getLanguage(code);
  // A stable tint per language, so the same language reads the same everywhere.
  const tint = [...code].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 5;
  return (
    <span className={`pill lang-${tint}`} title={lang ? `${lang.name} (${code})` : code}>
      {lang?.name ?? code}
    </span>
  );
}

/**
 * The books table shared by the Translate dashboard and the Source page.
 * `translate` shows target languages and translation status; `source` shows
 * the source language and catalogue category.
 */
export function BooksTable({
  books,
  variant,
}: {
  books: BookListItem[];
  variant: "translate" | "source";
}) {
  return (
    <div className="table-card">
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 130 }}>Book ID</th>
              <th>Title / Author</th>
              <th style={{ width: 210 }}>{variant === "translate" ? "Language" : "Source language"}</th>
              <th style={{ width: 130 }}>Chapters</th>
              <th style={{ width: 160 }}>Date</th>
              <th style={{ width: 140 }}>{variant === "translate" ? "Status" : "Category"}</th>
            </tr>
          </thead>
          <tbody>
            {books.map((book) => {
              const status = STATUS[book.status];
              const extraLanguages = book.targetLanguages.length - 2;
              const category = categoryLabel(book.category);
              return (
                <tr key={book.id}>
                  <td className="cell-id">{bookCode(book.id)}</td>
                  <td className="cell-main">
                    <Link href={`/books/${book.id}`} className="cell-title">
                      {book.title}
                    </Link>
                    <div className="cell-sub">{book.author || "Unknown author"}</div>
                  </td>
                  <td>
                    {variant === "source" ? (
                      <LanguagePill code={book.sourceLanguage} />
                    ) : book.targetLanguages.length > 0 ? (
                      <span className="pill-row">
                        {book.targetLanguages.slice(0, 2).map((code) => (
                          <LanguagePill key={code} code={code} />
                        ))}
                        {extraLanguages > 0 ? (
                          <span className="pill" title={book.targetLanguages
                              .slice(2)
                              .map((code) => getLanguage(code)?.name ?? code)
                              .join(", ")}>
                            +{extraLanguages}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="cell-sub">Not started</span>
                    )}
                  </td>
                  <td>
                    <span className="cell-meta">
                      <Icon name="file" size={15} />
                      {book.chapters.toLocaleString()}
                    </span>
                  </td>
                  <td>
                    <span className="cell-meta">
                      <Icon name="calendar" size={15} />
                      {dateFormat.format(new Date(book.createdAt))}
                    </span>
                  </td>
                  <td>
                    {variant === "translate" ? (
                      <span className={status.className}>{status.label}</span>
                    ) : category ? (
                      <span className="pill">{category}</span>
                    ) : (
                      <span className="cell-sub">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

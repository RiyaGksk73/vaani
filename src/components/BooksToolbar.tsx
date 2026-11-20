import Link from "next/link";
import { BOOK_CATEGORIES, type BookCategory } from "@/lib/books";
import { BookSearch } from "@/components/BookSearch";
import { Icon } from "@/components/Icon";

/** Search box plus the My Books / category tabs, sharing one row. */
export function BooksToolbar({
  basePath,
  q,
  tab,
}: {
  basePath: string;
  q: string;
  tab?: BookCategory;
}) {
  const href = (value?: string) => {
    const params = new URLSearchParams();
    if (value) params.set("tab", value);
    if (q) params.set("q", q);
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <div className="toolbar">
      <BookSearch initialQuery={q} tab={tab} />

      <nav className="tabs" aria-label="Book categories">
        <Link href={href()} className={!tab ? "tab active" : "tab"} aria-current={!tab ? "page" : undefined}>
          <Icon name="eye" size={15} />
          My Books
        </Link>
        {BOOK_CATEGORIES.map((c) => (
          <Link
            key={c.value}
            href={href(c.value)}
            className={tab === c.value ? "tab active" : "tab"}
            aria-current={tab === c.value ? "page" : undefined}
          >
            {c.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

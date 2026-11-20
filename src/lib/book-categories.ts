/** Catalogue categories a book can be filed under. Mirrors books_category_check. */
export const BOOK_CATEGORIES = [
  { value: "literature", label: "Literature" },
  { value: "westland", label: "Westland" },
  { value: "comics", label: "Comics" },
] as const;

export type BookCategory = (typeof BOOK_CATEGORIES)[number]["value"];

export function isBookCategory(value: string | null | undefined): value is BookCategory {
  return BOOK_CATEGORIES.some((c) => c.value === value);
}

export function categoryLabel(value: string | null): string | null {
  return BOOK_CATEGORIES.find((c) => c.value === value)?.label ?? null;
}

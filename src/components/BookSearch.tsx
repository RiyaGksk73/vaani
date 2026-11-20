"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Icon } from "@/components/Icon";

/**
 * Filters the books table by title or author. Writes `?q=` into the URL so
 * the server component does the filtering and the result is linkable.
 */
export function BookSearch({ initialQuery, tab }: { initialQuery: string; tab?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState(initialQuery);
  const [pending, startTransition] = useTransition();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (tab) params.set("tab", tab);
      if (value.trim()) params.set("q", value.trim());
      const qs = params.toString();
      startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname));
    }, 250);
    return () => clearTimeout(timer);
  }, [value, tab, pathname, router]);

  return (
    <form
      role="search"
      className={pending ? "search-field busy" : "search-field"}
      onSubmit={(e) => e.preventDefault()}
    >
      <Icon name="search" size={16} />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search by author or title..."
        aria-label="Search by author or title"
      />
    </form>
  );
}

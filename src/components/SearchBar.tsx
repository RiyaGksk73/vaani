"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Search across source text, character names and translations.
 * Hits the trigram indexes via search_script_rows, so it stays fast on
 * episodes with tens of thousands of rows.
 */
export function SearchBar({
  episodeId,
  targetLanguage,
  initialQuery,
}: {
  episodeId: string;
  targetLanguage: string;
  initialQuery: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const params = new URLSearchParams({ lang: targetLanguage });
    if (value.trim()) params.set("q", value.trim());
    router.push(`/episodes/${episodeId}?${params}`);
  };

  return (
    <form onSubmit={submit} className="row" style={{ marginBottom: 16, gap: 8 }}>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search dialogue, characters or translations..."
        style={{ flex: 1, minWidth: 220 }}
      />
      <button type="submit" className="btn-sm">
        Search
      </button>
      {initialQuery ? (
        <button
          type="button"
          className="btn-sm"
          onClick={() => {
            setValue("");
            router.push(`/episodes/${episodeId}?lang=${targetLanguage}`);
          }}
        >
          Clear
        </button>
      ) : null}
    </form>
  );
}

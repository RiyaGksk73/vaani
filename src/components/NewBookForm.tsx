"use client";

import { useActionState } from "react";
import { createBook, type FormState } from "@/app/actions";
import { LANGUAGES, languageLabel } from "@/services/translation/languages";
import { BOOK_CATEGORIES } from "@/lib/book-categories";

const initial: FormState = {};

export function NewBookForm({ hasMetadata = true }: { hasMetadata?: boolean }) {
  const [state, action, pending] = useActionState(createBook, initial);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>New source book</h2>
        <p className="dash-sub">Create a book, then add episodes and import their scripts.</p>
      </div>
      <form action={action} className="panel-body">
        <div className="form-grid">
          <div className="field">
            <label htmlFor="title">Title</label>
            <input id="title" name="title" placeholder="Chhota Sher - Season 1" required />
          </div>

          {hasMetadata ? (
            <div className="field">
              <label htmlFor="author">Author</label>
              <input id="author" name="author" placeholder="Optional" />
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="sourceLanguage">Source language</label>
            <select id="sourceLanguage" name="sourceLanguage" defaultValue="en-IN">
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {languageLabel(lang.code)}
                </option>
              ))}
            </select>
          </div>

          {hasMetadata ? (
            <div className="field">
              <label htmlFor="category">Category</label>
              <select id="category" name="category" defaultValue="">
                <option value="">None</option>
                {BOOK_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="field field-wide">
            <label htmlFor="description">Description</label>
            <input id="description" name="description" placeholder="Optional" />
          </div>
        </div>

        {state.error ? <p className="error-text">{state.error}</p> : null}
        {state.message ? <p className="small muted">{state.message}</p> : null}

        <button type="submit" className="btn-dark" disabled={pending}>
          {pending ? "Creating..." : "Create book"}
        </button>
      </form>
    </div>
  );
}

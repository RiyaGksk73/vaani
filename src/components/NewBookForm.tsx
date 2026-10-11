"use client";

import { useActionState } from "react";
import { createBook, type FormState } from "@/app/actions";
import { LANGUAGES, languageLabel } from "@/services/translation/languages";

const initial: FormState = {};

export function NewBookForm() {
  const [state, action, pending] = useActionState(createBook, initial);

  return (
    <div className="card card-pad" style={{ maxWidth: 520 }}>
      <h2 style={{ marginBottom: 14 }}>New source book</h2>
      <form action={action}>
        <div className="field">
          <label htmlFor="title">Title</label>
          <input id="title" name="title" placeholder="Chhota Sher - Season 1" required />
        </div>

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

        <div className="field">
          <label htmlFor="description">Description</label>
          <input id="description" name="description" placeholder="Optional" />
        </div>

        {state.error ? <p className="error-text">{state.error}</p> : null}
        {state.message ? <p className="small muted">{state.message}</p> : null}

        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? "Creating..." : "Create book"}
        </button>
      </form>
    </div>
  );
}

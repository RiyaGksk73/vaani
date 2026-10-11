"use client";

import { useActionState } from "react";
import { createEpisode, type FormState } from "@/app/actions";

const initial: FormState = {};

export function NewEpisodeForm({
  bookId,
  nextNumber,
}: {
  bookId: string;
  nextNumber: number;
}) {
  const [state, action, pending] = useActionState(createEpisode, initial);

  return (
    <div className="card card-pad" style={{ maxWidth: 520 }}>
      <h2 style={{ marginBottom: 14 }}>New episode</h2>
      <form action={action}>
        <input type="hidden" name="bookId" value={bookId} />

        <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
          <div className="field" style={{ width: 96, marginBottom: 0 }}>
            <label htmlFor="number">Number</label>
            <input id="number" name="number" type="number" min={0} defaultValue={nextNumber} required />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
            <label htmlFor="title">Title</label>
            <input id="title" name="title" placeholder="The Missing Tiffin" required />
          </div>
        </div>

        {state.error ? (
          <p className="error-text" style={{ marginBottom: 0 }}>
            {state.error}
          </p>
        ) : null}
        {state.message ? <p className="small muted">{state.message}</p> : null}

        <button type="submit" className="btn-primary" disabled={pending} style={{ marginTop: 14 }}>
          {pending ? "Adding..." : "Add episode"}
        </button>
      </form>
    </div>
  );
}

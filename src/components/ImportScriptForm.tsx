"use client";

import { useActionState } from "react";
import { importScriptRows, type FormState } from "@/app/actions";

const initial: FormState = {};

export function ImportScriptForm({ episodeId }: { episodeId: string }) {
  const [state, action, pending] = useActionState(importScriptRows, initial);

  return (
    <div className="card card-pad">
      <h2 style={{ marginBottom: 6 }}>Import script</h2>
      <p className="small muted" style={{ marginTop: 0, marginBottom: 14 }}>
        One row per line. <code>CHARACTER: dialogue</code> splits the speaker out
        automatically so their name is never translated.
      </p>

      <form action={action}>
        <input type="hidden" name="episodeId" value={episodeId} />
        <div className="field">
          <textarea
            name="script"
            rows={8}
            placeholder={"Raju: Namaste sabhi ko.\nMeera: Aaj ka din khaas hai!\n[SFX: door creaks]"}
            required
          />
        </div>

        {state.error ? <p className="error-text">{state.error}</p> : null}
        {state.message ? <p className="small muted">{state.message}</p> : null}

        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? "Importing..." : "Import rows"}
        </button>
      </form>
    </div>
  );
}

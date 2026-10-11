"use client";

import { useActionState, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn, signUp, type AuthState } from "@/app/auth/actions";

const initial: AuthState = {};

export default function LoginPage() {
  const params = useSearchParams();
  const next = params.get("next") ?? "/";
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  const [signInState, signInAction, signingIn] = useActionState(signIn, initial);
  const [signUpState, signUpAction, signingUp] = useActionState(signUp, initial);

  const state = mode === "signin" ? signInState : signUpState;
  const pending = mode === "signin" ? signingIn : signingUp;

  return (
    <div style={{ maxWidth: 380, margin: "88px auto" }}>
      <h1 style={{ marginBottom: 6 }}>Vaani</h1>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 28 }}>
        Script localisation across English and 22 Indian languages.
      </p>

      <div className="card card-pad">
        <div className="row" style={{ marginBottom: 18, gap: 6 }}>
          <button
            type="button"
            className={mode === "signin" ? "btn-primary btn-sm" : "btn-sm"}
            onClick={() => setMode("signin")}
          >
            Sign in
          </button>
          <button
            type="button"
            className={mode === "signup" ? "btn-primary btn-sm" : "btn-sm"}
            onClick={() => setMode("signup")}
          >
            Create account
          </button>
        </div>

        <form action={mode === "signin" ? signInAction : signUpAction}>
          <input type="hidden" name="next" value={next} />

          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
            />
          </div>

          {state.error ? <p className="error-text">{state.error}</p> : null}
          {state.message ? <p className="small muted">{state.message}</p> : null}

          <button type="submit" className="btn-primary" disabled={pending} style={{ width: "100%" }}>
            {pending ? "Working..." : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}

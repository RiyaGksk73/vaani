import { createClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env";
import type { Database } from "./database.types";

/**
 * Server-side only. Not `import "server-only"` because the standalone worker
 * (scripts/worker.ts) runs outside Next and has to import this too; the check
 * below gives the same browser protection without the bundler condition.
 */
if (typeof window !== "undefined") {
  throw new Error("admin.ts must not be imported into client code");
}


let cached: ReturnType<typeof createClient<Database>> | null = null;

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Only the translation worker should use this: it processes rows on behalf of
 * many users at once and has no session to act under. Every RPC it calls does
 * its own scoping. Never reach for this to "fix" a permissions problem in a
 * user-facing path - that path should be using the session client.
 */
export function createAdminClient() {
  if (cached) return cached;

  const env = serverEnv();
  cached = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-application-name": "vaani-worker" } },
    },
  );

  return cached;
}

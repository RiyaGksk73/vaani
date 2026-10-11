"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";

let cached: ReturnType<typeof createBrowserClient<Database>> | null = null;

/**
 * Browser client. Uses the anon key, so everything it can reach is whatever
 * RLS allows the signed-in user to reach. Memoised because each instance opens
 * its own realtime socket.
 */
export function createClient() {
  cached ??= createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return cached;
}

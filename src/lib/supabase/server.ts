import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "./database.types";

/**
 * Request-scoped Supabase client carrying the signed-in user's session.
 * Every query through it is subject to RLS - this is the only client that
 * should ever touch user-initiated reads and writes.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot set cookies. The middleware refreshes
            // the session, so ignoring this is safe.
          }
        },
      },
    },
  );
}

/** The signed-in user, or null. */
export async function getUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * The org the user is acting in. Single-membership is the common case; when
 * someone belongs to several, the first by creation order wins until an org
 * switcher exists.
 */
export async function getCurrentOrg() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("org_members")
    .select("org_id, role, organizations(id, name, slug)")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data?.organizations) return null;

  const org = Array.isArray(data.organizations) ? data.organizations[0] : data.organizations;
  if (!org) return null;

  return { id: org.id, name: org.name, slug: org.slug, role: data.role };
}

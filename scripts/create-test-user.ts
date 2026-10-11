/**
 * Create a confirmed test user and their organization.
 *
 *   npm run create:testuser
 *   npm run create:testuser -- --email dev@vaani.test --password devpass123 --org "Test Studio"
 *
 * Uses the service-role key to create the auth user with the email already
 * confirmed, so it works even when the Supabase project requires email
 * confirmation. Safe to re-run: an existing user is reused.
 */

import { createAdminClient } from "../src/lib/supabase/admin";

function arg(flag: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const email = arg("--email") ?? "dev@vaani.test";
const password = arg("--password") ?? "devpass123";
const orgName = arg("--org") ?? "Test Studio";

async function main() {
  const db = createAdminClient();

  // ---- auth user ----------------------------------------------------------
  let userId: string | undefined;

  const created = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (created.error) {
    if (!/already/i.test(created.error.message)) throw created.error;
    // Already exists - find them and reset the password to the known value.
    const list = await db.auth.admin.listUsers();
    if (list.error) throw list.error;
    const existing = list.data.users.find((u) => u.email === email);
    if (!existing) throw new Error(`user ${email} reported as existing but not found`);
    userId = existing.id;
    const updated = await db.auth.admin.updateUserById(userId, {
      password,
      email_confirm: true,
    });
    if (updated.error) throw updated.error;
    console.log(`Reused existing user ${email}, password reset.`);
  } else {
    userId = created.data.user.id;
    console.log(`Created user ${email}.`);
  }

  if (!userId) throw new Error("no user id");

  // The handle_new_user trigger creates the profile row; give it a moment.
  await new Promise((r) => setTimeout(r, 500));

  // ---- organization + membership ----------------------------------------
  const membership = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .limit(1);

  if (membership.data?.[0]?.org_id) {
    console.log(`Already a member of org ${membership.data[0].org_id}.`);
  } else {
    const slug = `${orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "team"}-${Date.now().toString(36)}`;
    const org = await db
      .from("organizations")
      .insert({ name: orgName, slug })
      .select("id")
      .single();
    if (org.error || !org.data) throw new Error(`could not create org: ${org.error?.message}`);

    const member = await db
      .from("org_members")
      .insert({ org_id: org.data.id, user_id: userId, role: "owner" });
    if (member.error) throw new Error(`could not add member: ${member.error.message}`);

    console.log(`Created org "${orgName}" (${org.data.id}), added ${email} as owner.`);
  }

  console.log("\n  Sign in at http://localhost:3000/login");
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
}

main().catch((e) => {
  console.error("\nFailed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

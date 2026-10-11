/**
 * Seed a workspace with a realistic script.
 *
 *   npm run seed -- --email you@example.com
 *   npm run seed -- --email you@example.com --rows 50000
 *
 * The --rows flag is there to make the scale claims testable: generate a
 * 50,000-row episode and watch search, pagination and the queue behave. Rows
 * are deliberately repetitive (recurring catchphrases and SFX) so translation
 * memory has something real to deduplicate.
 */

import { createAdminClient } from "../src/lib/supabase/admin";

interface Args {
  email: string;
  rows: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const email = get("--email") ?? process.env.SEED_USER_EMAIL;
  if (!email) {
    console.error("Usage: npm run seed -- --email you@example.com [--rows 500]");
    process.exit(1);
  }

  return { email, rows: Number(get("--rows") ?? 500) };
}

const CHARACTERS = ["Raju", "Meera", "Dadi", "Inspector Rao", "Chintu"];

const LINES = [
  "Namaste sabhi ko.",
  "Aaj ka din khaas hai!",
  "Chalo, der ho rahi hai.",
  "Yeh kaise ho sakta hai?",
  "Main tumhare saath hoon.",
  "Kya tumne {item} dekha hai?",
  "[SFX: door creaks]",
  "Ruko! Wahan mat jao.",
  "Sab theek ho jayega.",
  "...",
];

async function main() {
  const { email, rows } = parseArgs();
  const db = createAdminClient();

  // ---- find the user -------------------------------------------------------
  const { data: profiles, error: profileError } = await db
    .from("profiles")
    .select("id, email")
    .eq("email", email)
    .limit(1);

  if (profileError) throw new Error(`could not read profiles: ${profileError.message}`);

  const profile = profiles?.[0];
  if (!profile) {
    console.error(`No user with email ${email}. Sign up in the app first, then re-run.`);
    process.exit(1);
  }

  // ---- org -----------------------------------------------------------------
  const { data: membership } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", profile.id)
    .limit(1);

  let orgId = membership?.[0]?.org_id;

  if (!orgId) {
    const { data: org, error } = await db
      .from("organizations")
      .insert({ name: "Demo Studio", slug: `demo-${Date.now().toString(36)}` })
      .select("id")
      .single();
    if (error || !org) throw new Error(`could not create org: ${error?.message}`);

    orgId = org.id;
    const { error: memberError } = await db
      .from("org_members")
      .insert({ org_id: orgId, user_id: profile.id, role: "owner" });
    if (memberError) throw new Error(`could not add member: ${memberError.message}`);
  }

  console.log(`Using org ${orgId}`);

  // ---- book + episode ------------------------------------------------------
  const { data: book, error: bookError } = await db
    .from("books")
    .insert({
      org_id: orgId,
      title: "Chhota Sher - Season 1",
      source_language: "hi-IN",
      description: "Seeded demo book",
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (bookError || !book) throw new Error(`could not create book: ${bookError?.message}`);

  const { data: episode, error: episodeError } = await db
    .from("episodes")
    .insert({ book_id: book.id, org_id: orgId, number: 1, title: "The Missing Tiffin" })
    .select("id")
    .single();
  if (episodeError || !episode) throw new Error(`could not create episode: ${episodeError?.message}`);

  // ---- script rows ---------------------------------------------------------
  const CHUNK = 1000;
  let written = 0;

  for (let start = 0; start < rows; start += CHUNK) {
    const batch = Array.from({ length: Math.min(CHUNK, rows - start) }, (_, offset) => {
      const index = start + offset;
      return {
        episode_id: episode.id,
        org_id: orgId,
        row_index: index,
        character_name: CHARACTERS[index % CHARACTERS.length]!,
        source_text: LINES[index % LINES.length]!,
      };
    });

    const { error } = await db.from("script_rows").insert(batch);
    if (error) throw new Error(`insert failed at row ${start}: ${error.message}`);

    written += batch.length;
    process.stdout.write(`\rInserted ${written.toLocaleString()} / ${rows.toLocaleString()} rows`);
  }

  const unique = new Set(Array.from({ length: rows }, (_, i) => LINES[i % LINES.length])).size;

  console.log(`\n\nSeeded episode ${episode.id}`);
  console.log(`  ${rows.toLocaleString()} rows, ${unique} unique source lines`);
  console.log(`  Translation memory should collapse those to ${unique} paid calls.`);
  console.log(`\nOpen /episodes/${episode.id} and press Translate.`);
}

main().catch((error) => {
  console.error("\nSeed failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});

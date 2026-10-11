-- ===========================================================================
-- Vaani - core schema
--
-- Sizing targets this schema is built for:
--   100+       books
--   10,000+    episodes
--   1,000,000+ script rows
--   n target languages per row  ->  translations is the largest table
--
-- Everything is scoped by org_id. It is denormalised onto every table (rather
-- than joined through book -> episode) so RLS predicates stay a single index
-- lookup instead of a two-level join on the hot path.
-- ===========================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type org_role as enum ('owner', 'editor', 'reviewer', 'viewer');

create type translation_status as enum (
  'pending',   -- row exists, nothing translated yet
  'machine',   -- machine output, untouched by a human
  'edited',    -- a human changed the machine output
  'approved',  -- a reviewer signed it off
  'failed'     -- exhausted retries; needs manual attention
);

create type translation_origin as enum ('machine', 'human');

create type job_status as enum (
  'queued', 'running', 'completed', 'failed', 'cancelled'
);

create type job_item_status as enum (
  'queued', 'running', 'done', 'failed', 'skipped'
);

-- ---------------------------------------------------------------------------
-- Identity and tenancy
-- ---------------------------------------------------------------------------
create table profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text not null,
  display_name text,
  created_at   timestamptz not null default now()
);

create table organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  created_at timestamptz not null default now()
);

create table org_members (
  org_id     uuid not null references organizations (id) on delete cascade,
  user_id    uuid not null references profiles (id) on delete cascade,
  role       org_role not null default 'editor',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index org_members_user_idx on org_members (user_id);

-- ---------------------------------------------------------------------------
-- Content: books -> episodes -> script rows
-- ---------------------------------------------------------------------------
create table books (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete cascade,
  title           text not null,
  source_language text not null,          -- Sarvam code, e.g. en-IN
  description     text,
  created_by      uuid references profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index books_org_idx on books (org_id, created_at desc);
create index books_title_trgm_idx on books using gin (title gin_trgm_ops);

create table episodes (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid not null references books (id) on delete cascade,
  org_id     uuid not null references organizations (id) on delete cascade,
  number     integer not null,
  title      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (book_id, number)
);

create index episodes_org_idx on episodes (org_id, created_at desc);
create index episodes_book_idx on episodes (book_id, number);

-- The big one. bigint identity rather than uuid: rows are always read in
-- row_index order within an episode, and a narrow sequential key keeps the
-- (episode_id, row_index) btree and every FK from translations compact.
create table script_rows (
  id             bigint generated always as identity primary key,
  episode_id     uuid not null references episodes (id) on delete cascade,
  org_id         uuid not null references organizations (id) on delete cascade,
  row_index      integer not null,
  character_name text,                    -- kept verbatim, never translated
  source_text    text not null,
  notes          text,                    -- direction for the localiser
  created_at     timestamptz not null default now(),
  unique (episode_id, row_index)
);

create index script_rows_org_idx on script_rows (org_id);
-- Substring search across a million rows without a sequential scan.
create index script_rows_text_trgm_idx
  on script_rows using gin (source_text gin_trgm_ops);
create index script_rows_character_idx
  on script_rows (org_id, character_name)
  where character_name is not null;

-- ---------------------------------------------------------------------------
-- Translations: one row per (script row, target language)
-- ---------------------------------------------------------------------------
create table translations (
  id              bigint generated always as identity primary key,
  script_row_id   bigint not null references script_rows (id) on delete cascade,
  org_id          uuid not null references organizations (id) on delete cascade,
  target_language text not null,
  translated_text text,
  status          translation_status not null default 'pending',
  origin          translation_origin not null default 'machine',
  provider        text,                   -- sarvam
  model           text,                   -- sarvam-translate:v1
  tm_hit          boolean not null default false,
  attempts        smallint not null default 0,
  error           text,
  translated_at   timestamptz,
  edited_by       uuid references profiles (id) on delete set null,
  updated_at      timestamptz not null default now(),
  unique (script_row_id, target_language)
);

create index translations_org_lang_status_idx
  on translations (org_id, target_language, status);
-- Drives the review queue: everything still needing a human.
create index translations_needs_review_idx
  on translations (org_id, target_language)
  where status in ('machine', 'failed');
create index translations_text_trgm_idx
  on translations using gin (translated_text gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Translation memory
-- ---------------------------------------------------------------------------
-- source_hash is sha256 of the normalised source text, computed in the
-- application (src/services/translation/memory.ts) so normalisation has
-- exactly one implementation. Do not write this table by raw SQL without
-- computing the hash the same way.
create table translation_memory (
  id              bigint generated always as identity primary key,
  org_id          uuid not null references organizations (id) on delete cascade,
  source_hash     text not null,
  source_text     text not null,
  source_language text not null,
  target_language text not null,
  translated_text text not null,
  origin          translation_origin not null default 'machine',
  use_count       integer not null default 0,
  created_by      uuid references profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (org_id, source_hash, source_language, target_language)
);

create index translation_memory_lookup_idx
  on translation_memory (org_id, source_language, target_language, source_hash);
create index translation_memory_text_trgm_idx
  on translation_memory using gin (source_text gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Job queue
-- ---------------------------------------------------------------------------
create table translation_jobs (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete cascade,
  episode_id      uuid not null references episodes (id) on delete cascade,
  target_language text not null,
  status          job_status not null default 'queued',
  total_rows      integer not null default 0,
  completed_rows  integer not null default 0,
  failed_rows     integer not null default 0,
  tm_hits         integer not null default 0,
  error           text,
  created_by      uuid references profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);

create index translation_jobs_org_idx on translation_jobs (org_id, created_at desc);
create index translation_jobs_episode_idx on translation_jobs (episode_id, created_at desc);
-- Only one live job per (episode, language); a second Translate click resumes
-- the existing job instead of double-spending on the API.
create unique index translation_jobs_active_idx
  on translation_jobs (episode_id, target_language)
  where status in ('queued', 'running');

create table translation_job_items (
  id            bigint generated always as identity primary key,
  job_id        uuid not null references translation_jobs (id) on delete cascade,
  script_row_id bigint not null references script_rows (id) on delete cascade,
  status        job_item_status not null default 'queued',
  attempts      smallint not null default 0,
  last_error    text,
  locked_at     timestamptz,
  locked_by     text,
  unique (job_id, script_row_id)
);

-- Partial index: the claim query only ever looks at queued work, so the index
-- stays small even when millions of finished items sit in the table.
create index translation_job_items_claimable_idx
  on translation_job_items (job_id, id)
  where status = 'queued';
create index translation_job_items_stuck_idx
  on translation_job_items (locked_at)
  where status = 'running';

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

create trigger books_touch before update on books
  for each row execute function touch_updated_at();
create trigger episodes_touch before update on episodes
  for each row execute function touch_updated_at();
create trigger translations_touch before update on translations
  for each row execute function touch_updated_at();
create trigger translation_memory_touch before update on translation_memory
  for each row execute function touch_updated_at();

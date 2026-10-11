-- ===========================================================================
-- Vaani - complete schema, in one file.
--
-- Paste this into the Supabase SQL Editor and run it once, on a fresh project:
--   https://supabase.com/dashboard/project/fhuyvpvcyhijfmclesny/sql/new
--
-- This is a convenience concatenation of supabase/migrations/*.sql, in order.
-- It lives outside migrations/ on purpose so the Supabase CLI does not try to
-- apply it a second time if you later switch to `supabase db push`.
--
-- Run it once. It creates types and tables without IF NOT EXISTS, so a second
-- run will error on the first `create type` - that is expected, not a problem.
-- ===========================================================================



-- ###########################################################################
-- # 0001_schema.sql
-- ###########################################################################

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


-- ###########################################################################
-- # 0002_rls.sql
-- ###########################################################################

-- ===========================================================================
-- Vaani - row level security
--
-- Every table is org-scoped. Reads require membership; content writes require
-- owner/editor; translation edits additionally allow reviewer, since reviewing
-- is exactly the job of correcting machine output.
--
-- The worker runs under the service role, which bypasses RLS entirely. These
-- policies exist to make the anon key safe in the browser.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Membership helpers
--
-- SECURITY DEFINER so the policy on org_members does not have to consult
-- org_members through RLS and recurse into itself.
-- ---------------------------------------------------------------------------
create or replace function is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from org_members m
    where m.org_id = p_org
      and m.user_id = auth.uid()
  );
$fn$;

create or replace function has_org_role(p_org uuid, p_roles org_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from org_members m
    where m.org_id = p_org
      and m.user_id = auth.uid()
      and m.role = any (p_roles)
  );
$fn$;

-- ---------------------------------------------------------------------------
-- Enable RLS
-- ---------------------------------------------------------------------------
alter table profiles             enable row level security;
alter table organizations        enable row level security;
alter table org_members          enable row level security;
alter table books                enable row level security;
alter table episodes             enable row level security;
alter table script_rows          enable row level security;
alter table translations         enable row level security;
alter table translation_memory   enable row level security;
alter table translation_jobs     enable row level security;
alter table translation_job_items enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create policy profiles_select_self_or_teammate on profiles
  for select using (
    id = auth.uid()
    or exists (
      select 1
      from org_members mine
      join org_members theirs on theirs.org_id = mine.org_id
      where mine.user_id = auth.uid()
        and theirs.user_id = profiles.id
    )
  );

create policy profiles_insert_self on profiles
  for insert with check (id = auth.uid());

create policy profiles_update_self on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- organizations / membership
-- ---------------------------------------------------------------------------
create policy organizations_select_member on organizations
  for select using (is_org_member(id));

create policy organizations_insert_authenticated on organizations
  for insert with check (auth.uid() is not null);

create policy organizations_update_owner on organizations
  for update using (has_org_role(id, array['owner']::org_role[]));

create policy org_members_select_member on org_members
  for select using (is_org_member(org_id));

create policy org_members_write_owner on org_members
  for all
  using (has_org_role(org_id, array['owner']::org_role[]))
  with check (has_org_role(org_id, array['owner']::org_role[]));

-- ---------------------------------------------------------------------------
-- Content tables: read = member, write = owner/editor
-- ---------------------------------------------------------------------------
create policy books_select on books
  for select using (is_org_member(org_id));
create policy books_write on books
  for all
  using (has_org_role(org_id, array['owner', 'editor']::org_role[]))
  with check (has_org_role(org_id, array['owner', 'editor']::org_role[]));

create policy episodes_select on episodes
  for select using (is_org_member(org_id));
create policy episodes_write on episodes
  for all
  using (has_org_role(org_id, array['owner', 'editor']::org_role[]))
  with check (has_org_role(org_id, array['owner', 'editor']::org_role[]));

create policy script_rows_select on script_rows
  for select using (is_org_member(org_id));
create policy script_rows_write on script_rows
  for all
  using (has_org_role(org_id, array['owner', 'editor']::org_role[]))
  with check (has_org_role(org_id, array['owner', 'editor']::org_role[]));

-- ---------------------------------------------------------------------------
-- translations: reviewers may correct, but not create or delete
-- ---------------------------------------------------------------------------
create policy translations_select on translations
  for select using (is_org_member(org_id));

create policy translations_insert on translations
  for insert
  with check (has_org_role(org_id, array['owner', 'editor']::org_role[]));

create policy translations_update on translations
  for update
  using (has_org_role(org_id, array['owner', 'editor', 'reviewer']::org_role[]))
  with check (has_org_role(org_id, array['owner', 'editor', 'reviewer']::org_role[]));

create policy translations_delete on translations
  for delete using (has_org_role(org_id, array['owner', 'editor']::org_role[]));

-- ---------------------------------------------------------------------------
-- translation_memory: anyone in the org may read and contribute corrections
-- ---------------------------------------------------------------------------
create policy translation_memory_select on translation_memory
  for select using (is_org_member(org_id));
create policy translation_memory_write on translation_memory
  for all
  using (has_org_role(org_id, array['owner', 'editor', 'reviewer']::org_role[]))
  with check (has_org_role(org_id, array['owner', 'editor', 'reviewer']::org_role[]));

-- ---------------------------------------------------------------------------
-- Jobs: members watch progress, editors start work.
-- Job items are written only by the worker (service role), so they are
-- read-only here.
-- ---------------------------------------------------------------------------
create policy translation_jobs_select on translation_jobs
  for select using (is_org_member(org_id));
create policy translation_jobs_write on translation_jobs
  for all
  using (has_org_role(org_id, array['owner', 'editor']::org_role[]))
  with check (has_org_role(org_id, array['owner', 'editor']::org_role[]));

create policy translation_job_items_select on translation_job_items
  for select using (
    exists (
      select 1
      from translation_jobs j
      where j.id = translation_job_items.job_id
        and is_org_member(j.org_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Bootstrapping: profile on signup, owner membership on org creation
-- ---------------------------------------------------------------------------
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$fn$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

create or replace function handle_new_organization()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is not null then
    insert into org_members (org_id, user_id, role)
    values (new.id, auth.uid(), 'owner')
    on conflict do nothing;
  end if;
  return new;
end;
$fn$;

create trigger on_organization_created
  after insert on organizations
  for each row execute function handle_new_organization();

-- ---------------------------------------------------------------------------
-- Realtime: the UI subscribes to job rows for live progress.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table translation_jobs;


-- ###########################################################################
-- # 0003_functions.sql
-- ###########################################################################

-- ===========================================================================
-- Vaani - queue, progress and search RPCs
--
-- The queue lives in Postgres rather than an external broker: it is already
-- the source of truth, it gives us SKIP LOCKED for free, and job progress
-- rides Supabase Realtime to the browser without a second moving part.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- enqueue_translation_job
--
-- Idempotent. Clicking Translate twice on the same episode/language resumes
-- the live job instead of queueing a duplicate - the partial unique index on
-- translation_jobs enforces that, and this function returns the existing id.
--
-- Only rows that actually need work are enqueued: anything already approved
-- or edited by a human is left alone unless p_retranslate is set.
-- ---------------------------------------------------------------------------
create or replace function enqueue_translation_job(
  p_episode_id      uuid,
  p_target_language text,
  p_retranslate     boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_org_id  uuid;
  v_job_id  uuid;
  v_total   integer;
begin
  select org_id into v_org_id from episodes where id = p_episode_id;
  if v_org_id is null then
    raise exception 'episode % not found', p_episode_id using errcode = 'no_data_found';
  end if;

  if not has_org_role(v_org_id, array['owner', 'editor']::org_role[]) then
    raise exception 'not authorised to translate in this organisation'
      using errcode = 'insufficient_privilege';
  end if;

  -- Resume a job that is already live for this pair.
  select id into v_job_id
  from translation_jobs
  where episode_id = p_episode_id
    and target_language = p_target_language
    and status in ('queued', 'running');

  if v_job_id is not null then
    return v_job_id;
  end if;

  -- Make sure every script row has a translation slot for this language.
  insert into translations (script_row_id, org_id, target_language, status)
  select sr.id, sr.org_id, p_target_language, 'pending'
  from script_rows sr
  where sr.episode_id = p_episode_id
  on conflict (script_row_id, target_language) do nothing;

  insert into translation_jobs (org_id, episode_id, target_language, status, created_by)
  values (v_org_id, p_episode_id, p_target_language, 'queued', auth.uid())
  returning id into v_job_id;

  insert into translation_job_items (job_id, script_row_id)
  select v_job_id, sr.id
  from script_rows sr
  join translations t
    on t.script_row_id = sr.id
   and t.target_language = p_target_language
  where sr.episode_id = p_episode_id
    and (
      p_retranslate
      or t.status in ('pending', 'failed')
    );

  get diagnostics v_total = row_count;

  update translation_jobs
  set total_rows = v_total,
      status = case when v_total = 0 then 'completed'::job_status
                    else 'queued'::job_status end,
      finished_at = case when v_total = 0 then now() else null end
  where id = v_job_id;

  return v_job_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- claim_job_items
--
-- SKIP LOCKED is what makes this safe to run from several workers at once:
-- each transaction takes a disjoint slice of the queue and never blocks on
-- another worker's rows.
-- ---------------------------------------------------------------------------
create or replace function claim_job_items(
  p_job_id uuid,
  p_limit  integer,
  p_worker text
)
returns table (
  script_row_id  bigint,
  row_index      integer,
  character_name text,
  source_text    text,
  notes          text,
  attempts       smallint
)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update translation_jobs
  set status = 'running',
      started_at = coalesce(started_at, now())
  where id = p_job_id
    and status = 'queued';

  return query
  with claimed as (
    select i.id
    from translation_job_items i
    where i.job_id = p_job_id
      and i.status = 'queued'
    order by i.id
    limit p_limit
    for update skip locked
  ),
  locked as (
    update translation_job_items i
    set status = 'running',
        attempts = i.attempts + 1,
        locked_at = now(),
        locked_by = p_worker
    from claimed c
    where i.id = c.id
    returning i.script_row_id, i.attempts
  )
  select sr.id, sr.row_index, sr.character_name, sr.source_text, sr.notes, l.attempts
  from locked l
  join script_rows sr on sr.id = l.script_row_id
  order by sr.row_index;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- mark_job_items
--
-- Settles a slice of work and rolls the counters up in the same transaction,
-- so the single UPDATE on translation_jobs that Realtime broadcasts always
-- carries a consistent progress snapshot. Finalises the job when the queue
-- drains.
-- ---------------------------------------------------------------------------
create or replace function mark_job_items(
  p_job_id   uuid,
  p_row_ids  bigint[],
  p_status   job_item_status,
  p_error    text default null
)
returns translation_jobs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_job       translation_jobs;
  v_remaining integer;
begin
  update translation_job_items
  set status = p_status,
      last_error = p_error,
      locked_at = null,
      locked_by = null
  where job_id = p_job_id
    and script_row_id = any (p_row_ids);

  update translation_jobs j
  set completed_rows = agg.done,
      failed_rows    = agg.failed,
      tm_hits        = agg.tm_hits
  from (
    select
      count(*) filter (where i.status in ('done', 'skipped'))              as done,
      count(*) filter (where i.status = 'failed')                          as failed,
      count(*) filter (where i.status in ('done', 'skipped') and t.tm_hit) as tm_hits
    from translation_job_items i
    left join translations t
      on t.script_row_id = i.script_row_id
     and t.target_language = (select target_language from translation_jobs where id = p_job_id)
    where i.job_id = p_job_id
  ) agg
  where j.id = p_job_id;

  select count(*) into v_remaining
  from translation_job_items
  where job_id = p_job_id
    and status in ('queued', 'running');

  if v_remaining = 0 then
    update translation_jobs
    set status = case
          when failed_rows > 0 and completed_rows = 0 then 'failed'::job_status
          else 'completed'::job_status
        end,
        finished_at = now()
    where id = p_job_id
      and status = 'running';
  end if;

  select * into v_job from translation_jobs where id = p_job_id;
  return v_job;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- requeue_stuck_job_items
--
-- A worker that dies mid-slice leaves items in `running` forever. Anything
-- locked longer than p_older_than goes back on the queue, unless it has burnt
-- through its attempt budget, in which case it is parked as failed.
-- ---------------------------------------------------------------------------
create or replace function requeue_stuck_job_items(
  p_older_than   interval default '10 minutes',
  p_max_attempts integer  default 3
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_count integer;
begin
  with reset as (
    update translation_job_items
    set status = case
          when attempts >= p_max_attempts then 'failed'::job_item_status
          else 'queued'::job_item_status
        end,
        last_error = case
          when attempts >= p_max_attempts then 'abandoned by worker'
          else last_error
        end,
        locked_at = null,
        locked_by = null
    where status = 'running'
      and locked_at < now() - p_older_than
    returning 1
  )
  select count(*) into v_count from reset;

  return v_count;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- next_runnable_job
--
-- Oldest job with queued work. The worker loop calls this instead of scanning
-- the jobs table itself.
-- ---------------------------------------------------------------------------
create or replace function next_runnable_job()
returns uuid
language sql
security definer
set search_path = public
as $fn$
  select j.id
  from translation_jobs j
  where j.status in ('queued', 'running')
    and exists (
      select 1 from translation_job_items i
      where i.job_id = j.id and i.status = 'queued'
    )
  order by j.created_at
  limit 1;
$fn$;

-- ---------------------------------------------------------------------------
-- search_script_rows
--
-- Keyset pagination (id > p_after) rather than OFFSET: at a million rows
-- OFFSET has to walk everything it skips. ILIKE rides the trigram GIN index,
-- so substring search stays sub-second without a tsvector column.
-- ---------------------------------------------------------------------------
create or replace function search_script_rows(
  p_org_id          uuid,
  p_query           text default null,
  p_episode_id      uuid default null,
  p_book_id         uuid default null,
  p_target_language text default null,
  p_limit           integer default 50,
  p_after           bigint default 0
)
returns table (
  id              bigint,
  episode_id      uuid,
  row_index       integer,
  character_name  text,
  source_text     text,
  translation_id  bigint,
  translated_text text,
  status          translation_status,
  error           text
)
language sql
stable
security invoker
set search_path = public
as $fn$
  select
    sr.id,
    sr.episode_id,
    sr.row_index,
    sr.character_name,
    sr.source_text,
    t.id,
    t.translated_text,
    coalesce(t.status, 'pending'::translation_status),
    t.error
  from script_rows sr
  left join episodes e on e.id = sr.episode_id
  left join translations t
    on t.script_row_id = sr.id
   and t.target_language = p_target_language
  where sr.org_id = p_org_id
    and sr.id > p_after
    and (p_episode_id is null or sr.episode_id = p_episode_id)
    and (p_book_id is null or e.book_id = p_book_id)
    and (
      p_query is null
      or p_query = ''
      or sr.source_text ilike '%' || p_query || '%'
      or sr.character_name ilike '%' || p_query || '%'
      or t.translated_text ilike '%' || p_query || '%'
    )
  order by sr.id
  limit least(p_limit, 200);
$fn$;

-- ---------------------------------------------------------------------------
-- episode_translation_progress
--
-- Status breakdown for one episode/language, for the progress bar and the
-- review queue counts.
-- ---------------------------------------------------------------------------
create or replace function episode_translation_progress(
  p_episode_id      uuid,
  p_target_language text
)
returns table (
  total     bigint,
  pending   bigint,
  machine   bigint,
  edited    bigint,
  approved  bigint,
  failed    bigint
)
language sql
stable
security invoker
set search_path = public
as $fn$
  select
    count(*)                                        as total,
    count(*) filter (where t.status is null
                        or t.status = 'pending')     as pending,
    count(*) filter (where t.status = 'machine')     as machine,
    count(*) filter (where t.status = 'edited')      as edited,
    count(*) filter (where t.status = 'approved')    as approved,
    count(*) filter (where t.status = 'failed')      as failed
  from script_rows sr
  left join translations t
    on t.script_row_id = sr.id
   and t.target_language = p_target_language
  where sr.episode_id = p_episode_id;
$fn$;

-- ---------------------------------------------------------------------------
-- save_translation_correction
--
-- The whole point of the review loop: a human edit both updates the row and
-- writes back into translation memory with origin = 'human', so the next
-- occurrence of that source line reuses the corrected wording rather than
-- re-asking the model. Human entries overwrite machine ones; machine entries
-- never overwrite human ones (see upsert_translation_memory).
--
-- SECURITY INVOKER on purpose - RLS decides whether this user may edit.
-- ---------------------------------------------------------------------------
create or replace function save_translation_correction(
  p_translation_id bigint,
  p_text           text,
  p_source_hash    text,
  p_approve        boolean default false
)
returns translations
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v_row        translations;
  v_source     text;
  v_source_lang text;
begin
  update translations
  set translated_text = p_text,
      status = case when p_approve then 'approved'::translation_status
                    else 'edited'::translation_status end,
      origin = 'human',
      error = null,
      edited_by = auth.uid(),
      translated_at = coalesce(translated_at, now())
  where id = p_translation_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'translation % not found', p_translation_id
      using errcode = 'no_data_found';
  end if;

  select sr.source_text, b.source_language
  into v_source, v_source_lang
  from script_rows sr
  join episodes e on e.id = sr.episode_id
  join books b on b.id = e.book_id
  where sr.id = v_row.script_row_id;

  insert into translation_memory (
    org_id, source_hash, source_text, source_language,
    target_language, translated_text, origin, created_by
  )
  values (
    v_row.org_id, p_source_hash, v_source, v_source_lang,
    v_row.target_language, p_text, 'human', auth.uid()
  )
  on conflict (org_id, source_hash, source_language, target_language)
  do update set
    translated_text = excluded.translated_text,
    origin = 'human',
    created_by = excluded.created_by,
    updated_at = now();

  return v_row;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- upsert_translation_memory
--
-- Used by the worker for machine output. A machine translation must never
-- clobber a human correction, so the DO UPDATE is guarded on the existing
-- row's origin.
-- ---------------------------------------------------------------------------
create or replace function upsert_translation_memory(
  p_org_id          uuid,
  p_source_hash     text,
  p_source_text     text,
  p_source_language text,
  p_target_language text,
  p_translated_text text,
  p_origin          translation_origin default 'machine'
)
returns void
language sql
security definer
set search_path = public
as $fn$
  insert into translation_memory (
    org_id, source_hash, source_text, source_language,
    target_language, translated_text, origin
  )
  values (
    p_org_id, p_source_hash, p_source_text, p_source_language,
    p_target_language, p_translated_text, p_origin
  )
  on conflict (org_id, source_hash, source_language, target_language)
  do update set
    translated_text = excluded.translated_text,
    updated_at = now()
  where translation_memory.origin = 'machine'
     or excluded.origin = 'human';
$fn$;

-- ---------------------------------------------------------------------------
-- bump_translation_memory_usage
--
-- Cheap counter so the cost dashboard can show what the cache actually saved.
-- ---------------------------------------------------------------------------
create or replace function bump_translation_memory_usage(p_ids bigint[])
returns void
language sql
security definer
set search_path = public
as $fn$
  update translation_memory
  set use_count = use_count + 1
  where id = any (p_ids);
$fn$;


-- ###########################################################################
-- # 0004_apply_results.sql
-- ###########################################################################

-- ===========================================================================
-- Vaani - bulk result writeback
--
-- The worker settles a whole slice at once. Doing that as one UPDATE ... FROM
-- jsonb_to_recordset instead of N single-row updates is the difference between
-- one round trip and a hundred, which at a million rows is the difference
-- between minutes and hours.
--
-- The status guard is the important part: a reviewer may have edited or
-- approved a row while the job was in flight, and machine output must never
-- overwrite a human decision.
-- ===========================================================================

create or replace function apply_translation_results(
  p_org_id          uuid,
  p_target_language text,
  p_results         jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_updated integer;
begin
  with incoming as (
    select *
    from jsonb_to_recordset(p_results) as x(
      script_row_id   bigint,
      translated_text text,
      status          text,
      provider        text,
      model           text,
      tm_hit          boolean,
      error           text
    )
  ),
  applied as (
    update translations t
    set translated_text = coalesce(i.translated_text, t.translated_text),
        status          = i.status::translation_status,
        origin          = 'machine',
        provider        = i.provider,
        model           = i.model,
        tm_hit          = coalesce(i.tm_hit, false),
        attempts        = t.attempts + 1,
        error           = i.error,
        translated_at   = case
                            when i.translated_text is not null then now()
                            else t.translated_at
                          end
    from incoming i
    where t.script_row_id = i.script_row_id
      and t.target_language = p_target_language
      and t.org_id = p_org_id
      -- Never clobber a human: 'edited' and 'approved' are excluded.
      and t.status in ('pending', 'failed', 'machine')
    returning 1
  )
  select count(*) into v_updated from applied;

  return v_updated;
end;
$fn$;


-- ###########################################################################
-- # 0005_realtime_replica_identity.sql
-- ###########################################################################

-- ===========================================================================
-- Vaani - make Realtime progress reliable
--
-- translation_jobs is broadcast over Realtime and is RLS-protected, which is a
-- combination Postgres needs help with.
--
-- With the default replica identity, an UPDATE only writes the primary key of
-- the OLD row into the WAL. Realtime needs the rest of that row for two things:
--
--   1. evaluating the RLS policy for each subscriber, and
--   2. matching subscription filters on non-key columns - the UI subscribes
--      with `episode_id=eq.<id>`, which is not the primary key.
--
-- Without REPLICA IDENTITY FULL both can silently fail: the worker updates the
-- counters, no event reaches the browser, and the progress bar sits at 0%
-- while the job actually finishes. Nothing errors, which is what makes it
-- confusing to diagnose.
--
-- The cost is a slightly larger WAL record per update. translation_jobs sees
-- one update per settled slice, not per row, so this is negligible.
-- ===========================================================================

alter table translation_jobs replica identity full;

-- Idempotent re-assert: harmless if 0002 already added it.
do $fn$
begin
  alter publication supabase_realtime add table translation_jobs;
exception
  when duplicate_object then null;
end;
$fn$;



-- ###########################################################################
-- # 0006_personal_workspaces.sql
-- ###########################################################################

-- ===========================================================================
-- Vaani - personal workspaces
--
-- Teams are switched off for now: every account works on its own. Signup used
-- to ask for a team name and create the organization from the app, which only
-- happened when signUp returned a session - with email confirmation on, the
-- user ended up with no org at all and an empty app.
--
-- The org is now created here, in the same trigger that creates the profile,
-- so every account gets exactly one private workspace regardless of how it
-- was created. The org tables stay in place so teams can come back later
-- without a data migration.
--
-- Safe to run more than once.
-- ===========================================================================

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_org_id uuid;
begin
  insert into profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;

  if not exists (select 1 from org_members where user_id = new.id) then
    insert into organizations (name, slug)
    values ('Personal workspace', 'personal-' || replace(new.id::text, '-', ''))
    returning id into v_org_id;

    insert into org_members (org_id, user_id, role)
    values (v_org_id, new.id, 'owner')
    on conflict do nothing;
  end if;

  return new;
end;
$fn$;

-- Backfill: anyone who signed up before this ran and has no workspace.
do $fn$
declare
  v_profile record;
  v_org_id  uuid;
begin
  for v_profile in
    select p.id
    from profiles p
    where not exists (select 1 from org_members m where m.user_id = p.id)
  loop
    insert into organizations (name, slug)
    values ('Personal workspace', 'personal-' || replace(v_profile.id::text, '-', ''))
    on conflict (slug) do update set name = excluded.name
    returning id into v_org_id;

    insert into org_members (org_id, user_id, role)
    values (v_org_id, v_profile.id, 'owner')
    on conflict do nothing;
  end loop;
end;
$fn$;

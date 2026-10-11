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

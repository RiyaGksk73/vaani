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

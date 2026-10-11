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

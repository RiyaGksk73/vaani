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

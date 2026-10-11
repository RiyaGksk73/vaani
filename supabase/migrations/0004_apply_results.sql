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

-- =====================================================================
-- Tracey Recovery — telling the person who signed up
-- Run this once in the Supabase SQL Editor, after migration-cancel.
--
-- Three gaps, all the same shape: the system knew something had changed
-- and did not pass it on.
--
--   * A round trip or a repeating event that Tracey moved never told
--     the volunteer, because only single events reported that they had
--     changed under a claim.
--   * A cancellation told nobody at all.
--
-- The fix in every case is for the database to say which claimed needs
-- were affected, so the calendar function can pass that on.
-- =====================================================================

-- ---------- round trips ----------

create or replace function ingest_pair(
  p_token        text,
  p_base_uid     text,
  p_sequence     int,
  p_title        text,
  p_category     text,
  p_location     text,
  p_instructions text,
  p_ics          text,
  p_date         date,
  p_start        text,
  p_end          text
) returns json
language plpgsql security definer set search_path = public as $$
declare
  clean_title text := coalesce(nullif(trim(p_title), ''), 'Appointment');
  n_created int := 0;
  touched uuid[] := '{}';
  before_out needs%rowtype;
  before_back needs%rowtype;
  was_single needs%rowtype;
  carried boolean := false;
begin
  if not exists (select 1 from settings
                 where key = 'ingest_token' and value = p_token) then
    raise exception 'bad token';
  end if;

  select * into before_out  from needs where ics_uid = p_base_uid || '::out';
  select * into before_back from needs where ics_uid = p_base_uid || '::back';

  -- This event may have arrived as a plain one first, and been changed
  -- to a round trip afterwards. There is then a need stored under the
  -- bare uid which nothing else will ever touch again.
  --
  -- If somebody had claimed it, that promise moves to the outbound leg:
  -- they agreed to drive her to this appointment, and that is still the
  -- outbound journey. The orphan is then removed rather than left
  -- sitting on the page as a third entry nobody understands.
  select * into was_single from needs where ics_uid = p_base_uid;

  -- Outbound, at the appointment's start time.
  if before_out.id is null then
    insert into needs (title, category, date, start_time, end_time,
                       location, instructions, status, ics_uid, ics_sequence,
                       ics_raw, pair_key, leg,
                       volunteer_email, volunteer_name, claimed_at, invited,
                       last_synced_at)
    values ('Ride to ' || clean_title, 'rides', p_date, p_start, p_start,
            coalesce(p_location,''), coalesce(p_instructions,''),
            case when was_single.status = 'FILLED' then 'FILLED' else 'OPEN' end,
            p_base_uid || '::out', p_sequence, p_ics, p_base_uid, 'out',
            was_single.volunteer_email, was_single.volunteer_name,
            was_single.claimed_at, coalesce(was_single.invited, false),
            now());
    n_created := n_created + 1;
    if was_single.status = 'FILLED' then
      carried := true;
    end if;
  elsif p_sequence >= before_out.ics_sequence then
    -- Something a volunteer would notice: the day, the time, the place.
    if before_out.status = 'FILLED'
       and (before_out.date is distinct from p_date
            or before_out.start_time is distinct from p_start
            or before_out.location is distinct from coalesce(p_location, before_out.location))
    then
      touched := touched || before_out.id;
    end if;

    update needs
       set title = 'Ride to ' || clean_title,
           date = p_date, start_time = p_start, end_time = p_start,
           location = coalesce(p_location, location),
           instructions = coalesce(p_instructions, instructions),
           status = case when status = 'CANCELLED' then 'OPEN' else status end,
           ics_sequence = p_sequence, ics_raw = coalesce(p_ics, ics_raw),
           pair_key = p_base_uid, leg = 'out', last_synced_at = now()
     where ics_uid = p_base_uid || '::out';
  end if;

  -- Return, at the appointment's end time.
  if before_back.id is null then
    insert into needs (title, category, date, start_time, end_time,
                       location, instructions, status, ics_uid, ics_sequence,
                       ics_raw, pair_key, leg, last_synced_at)
    values ('Ride home from ' || clean_title, 'rides', p_date,
            coalesce(nullif(p_end,''), p_start), coalesce(nullif(p_end,''), p_start),
            coalesce(p_location,''), coalesce(p_instructions,''), 'OPEN',
            p_base_uid || '::back', p_sequence, p_ics, p_base_uid, 'back', now());
    n_created := n_created + 1;
  elsif p_sequence >= before_back.ics_sequence then
    if before_back.status = 'FILLED'
       and (before_back.date is distinct from p_date
            or before_back.start_time is distinct from coalesce(nullif(p_end,''), p_start)
            or before_back.location is distinct from coalesce(p_location, before_back.location))
    then
      touched := touched || before_back.id;
    end if;

    update needs
       set title = 'Ride home from ' || clean_title,
           date = p_date,
           start_time = coalesce(nullif(p_end,''), p_start),
           end_time = coalesce(nullif(p_end,''), p_start),
           location = coalesce(p_location, location),
           instructions = coalesce(p_instructions, instructions),
           status = case when status = 'CANCELLED' then 'OPEN' else status end,
           ics_sequence = p_sequence, ics_raw = coalesce(p_ics, ics_raw),
           pair_key = p_base_uid, leg = 'back', last_synced_at = now()
     where ics_uid = p_base_uid || '::back';
  end if;

  -- The orphan goes once its claim, if any, has been carried across.
  if was_single.id is not null then
    delete from needs where id = was_single.id;
  end if;

  -- Somebody who signed up for a plain ride now holds the outbound leg
  -- of a round trip. Worth telling them, because the title they see has
  -- changed and there is now a return journey they may also be able to
  -- do.
  if carried then
    select array_agg(id) into touched
      from needs where ics_uid = p_base_uid || '::out';
  end if;

  -- The ids are what matters here: whoever holds these needs to be sent
  -- the new invitation.
  return json_build_object('action', 'pair', 'created', n_created,
                           'carried_a_claim', carried,
                           'changed_while_claimed', to_json(coalesce(touched, '{}')));
end;
$$;

grant execute on function ingest_pair(text, text, int, text, text, text,
                                      text, text, date, text, text) to anon;

-- ---------- repeating events ----------

create or replace function ingest_series(
  p_token        text,
  p_base_uid     text,
  p_sequence     int,
  p_title        text,
  p_category     text,
  p_location     text,
  p_instructions text,
  p_ics          text,
  p_occurrences  json
) returns json
language plpgsql security definer set search_path = public as $$
declare
  occ json;
  occ_uid text;
  occ_date date;
  safe_category text;
  n_created int := 0;
  seen text[] := '{}';
  touched uuid[] := '{}';
  existing needs%rowtype;
begin
  if not exists (select 1 from settings
                 where key = 'ingest_token' and value = p_token) then
    raise exception 'bad token';
  end if;

  safe_category := lower(coalesce(p_category, 'other'));
  if safe_category not in ('rides','walks','izzy','errands','other') then
    safe_category := 'other';
  end if;

  for occ in select * from json_array_elements(p_occurrences)
  loop
    occ_date := (occ ->> 'date')::date;
    occ_uid  := p_base_uid || '::' || to_char(occ_date, 'YYYYMMDD');
    seen := seen || occ_uid;

    select * into existing from needs where ics_uid = occ_uid;

    if existing.id is null then
      insert into needs (title, category, date, start_time, end_time,
                         location, instructions, status,
                         ics_uid, ics_sequence, ics_raw, series_key, last_synced_at)
      values (coalesce(nullif(trim(p_title),''),'Help needed'), safe_category,
              occ_date, occ ->> 'start', occ ->> 'end',
              coalesce(p_location,''), coalesce(p_instructions,''), 'OPEN',
              occ_uid, p_sequence, p_ics, p_base_uid, now());
      n_created := n_created + 1;

    elsif p_sequence >= existing.ics_sequence then
      if existing.status = 'FILLED'
         and (existing.start_time is distinct from (occ ->> 'start')
              or existing.location is distinct from coalesce(p_location, existing.location))
      then
        touched := touched || existing.id;
      end if;

      update needs
         set title        = coalesce(nullif(trim(p_title),''), title),
             category     = safe_category,
             start_time   = occ ->> 'start',
             end_time     = occ ->> 'end',
             location     = coalesce(p_location, location),
             instructions = coalesce(p_instructions, instructions),
             status       = case when status = 'CANCELLED' then 'OPEN' else status end,
             ics_sequence = p_sequence,
             ics_raw      = coalesce(p_ics, ics_raw),
             series_key   = p_base_uid,
             last_synced_at = now()
       where ics_uid = occ_uid;
    end if;
  end loop;

  delete from needs
   where ics_uid like p_base_uid || '::%'
     and not (ics_uid = any(seen))
     and date >= current_date
     and volunteer_email is null;

  return json_build_object('action', 'series', 'created', n_created,
                           'changed_while_claimed', to_json(touched));
end;
$$;

grant execute on function ingest_series(text, text, int, text, text, text,
                                        text, text, json) to anon;

-- ---------- cancellation ----------

-- Same as before, but returning the ids as well as the names, so the
-- calendar function can hand each one to the notification that already
-- knows how to write a cancellation email.
create or replace function cancel_anything(p_token text, p_uid text)
returns json
language plpgsql security definer set search_path = public as $$
declare
  hit int;
  ids uuid[];
begin
  if not exists (select 1 from settings
                 where key = 'ingest_token' and value = p_token) then
    raise exception 'bad token';
  end if;

  select array_agg(id) into ids
    from needs
   where (ics_uid = p_uid
          or ics_uid like p_uid || '::%'
          or pair_key = p_uid
          or series_key = p_uid)
     and status = 'FILLED'
     and (date is null or date >= current_date);

  update needs
     set status = 'CANCELLED', last_synced_at = now()
   where (ics_uid = p_uid
          or ics_uid like p_uid || '::%'
          or pair_key = p_uid
          or series_key = p_uid)
     -- Past occurrences are left as they were. They happened.
     and (date is null or date >= current_date);
  get diagnostics hit = row_count;

  return json_build_object(
    'action', case when hit > 0 then 'cancelled' else 'nothing_matched' end,
    'count', hit,
    'tell', to_json(coalesce(ids, '{}')));
end;
$$;

grant execute on function cancel_anything(text, text) to anon;

-- ---------- a round trip changed back into a plain event ----------
--
-- The mirror of the case above. The two legs are still there under
-- <uid>::out and <uid>::back, and nothing will touch them again.
--
-- Called after the plain need has been stored, so the claim has
-- somewhere to move to. Whoever agreed to drive her there keeps that
-- commitment; the return leg was never theirs to keep.
create or replace function collapse_pair(p_token text, p_uid text)
returns json
language plpgsql security definer set search_path = public as $$
declare
  out_leg needs%rowtype;
  back_leg needs%rowtype;
  moved boolean := false;
  stranded text := null;
begin
  if not exists (select 1 from settings
                 where key = 'ingest_token' and value = p_token) then
    raise exception 'bad token';
  end if;

  select * into out_leg  from needs where ics_uid = p_uid || '::out';
  select * into back_leg from needs where ics_uid = p_uid || '::back';

  if out_leg.id is null and back_leg.id is null then
    return json_build_object('action', 'nothing_to_collapse');
  end if;

  -- The outbound claim moves onto the plain need.
  if out_leg.status = 'FILLED' then
    update needs
       set status = 'FILLED',
           volunteer_email = out_leg.volunteer_email,
           volunteer_name = out_leg.volunteer_name,
           claimed_at = out_leg.claimed_at,
           invited = false
     where ics_uid = p_uid
       and status = 'OPEN';
    moved := found;
  end if;

  -- Somebody had the return journey, and there is no longer one. They
  -- are named so the coordinator can tell them rather than leaving them
  -- to discover it.
  if back_leg.status = 'FILLED' then
    stranded := coalesce(back_leg.volunteer_name, back_leg.volunteer_email);
  end if;

  delete from needs where ics_uid in (p_uid || '::out', p_uid || '::back');

  return json_build_object('action', 'collapsed',
                           'carried_a_claim', moved,
                           'return_leg_was_held_by', stranded);
end;
$$;

grant execute on function collapse_pair(text, text) to anon;

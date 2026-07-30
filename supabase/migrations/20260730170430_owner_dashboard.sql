create or replace function private.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'is_anonymous')::boolean, true) = false
    and exists (
      select 1
      from public.profiles
      where id = (select auth.uid())
        and role = 'owner'
    );
$$;

revoke all on function private.is_owner() from public, anon;
grant execute on function private.is_owner() to authenticated;

create or replace function public.owner_dashboard(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  window_days integer := case when p_days in (7, 30, 90) then p_days else 30 end;
  window_start timestamptz;
  result jsonb;
begin
  if not (select private.is_owner()) then
    raise exception 'Owner access required' using errcode = '42501';
  end if;

  window_start := date_trunc('day', now()) - make_interval(days => window_days - 1);

  with
  lobby_totals as (
    select
      count(*)::integer as created,
      count(*) filter (where status = 'waiting')::integer as waiting,
      count(*) filter (where status = 'started')::integer as started,
      count(*) filter (where status = 'cancelled')::integer as cancelled
    from public.lobbies
    where created_at >= window_start
  ),
  match_totals as (
    select
      count(*)::integer as started,
      count(*) filter (where status = 'active')::integer as active,
      count(*) filter (where status = 'complete')::integer as completed,
      coalesce(round(avg(extract(epoch from (completed_at - created_at)) / 60)
        filter (where completed_at is not null))::integer, 0) as average_minutes
    from public.matches
    where created_at >= window_start
  ),
  player_totals as (
    select
      count(*)::integer as human_seats,
      count(distinct user_id)::integer as anonymous_identities
    from public.match_seats
    where is_human
      and user_id is not null
      and match_id in (select id from public.matches where created_at >= window_start)
  ),
  days as (
    select generate_series(
      date_trunc('day', window_start),
      date_trunc('day', now()),
      interval '1 day'
    )::date as day
  ),
  daily as (
    select jsonb_agg(jsonb_build_object(
      'date', days.day,
      'lobbies', (select count(*) from public.lobbies where created_at::date = days.day),
      'matches', (select count(*) from public.matches where created_at::date = days.day),
      'completed', (select count(*) from public.matches where completed_at::date = days.day)
    ) order by days.day) as rows
    from days
  ),
  recent as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', item.id,
      'status', item.status,
      'createdAt', item.created_at,
      'completedAt', item.completed_at,
      'durationMinutes', case
        when item.completed_at is null then null
        else round(extract(epoch from (item.completed_at - item.created_at)) / 60)::integer
      end,
      'humanSeats', item.human_seats
    ) order by item.created_at desc), '[]'::jsonb) as rows
    from (
      select matches.*, count(match_seats.user_id) filter (where match_seats.is_human)::integer as human_seats
      from public.matches
      left join public.match_seats on match_seats.match_id = matches.id
      group by matches.id
      order by matches.created_at desc
      limit 10
    ) item
  )
  select jsonb_build_object(
    'windowDays', window_days,
    'generatedAt', now(),
    'lobbies', to_jsonb(lobby_totals),
    'matches', to_jsonb(match_totals),
    'players', to_jsonb(player_totals),
    'daily', daily.rows,
    'recentMatches', recent.rows
  )
  into result
  from lobby_totals, match_totals, player_totals, daily, recent;

  return result;
end;
$$;

revoke all on function public.owner_dashboard(integer) from public, anon;
grant execute on function public.owner_dashboard(integer) to authenticated;

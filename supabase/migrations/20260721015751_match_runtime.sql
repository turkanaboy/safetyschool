alter table public.lobbies drop constraint lobbies_status_check;
alter table public.lobbies add constraint lobbies_status_check check (status in ('waiting', 'started', 'cancelled'));

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  lobby_id uuid unique references public.lobbies(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'complete')),
  version bigint not null default 0 check (version >= 0),
  winner_player_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.match_seats (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid,
  player_id text not null,
  seat_index smallint not null check (seat_index between 0 and 3),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  is_human boolean not null,
  primary key (match_id, player_id),
  unique (match_id, seat_index),
  check ((is_human and user_id is not null) or (not is_human and user_id is null))
);

create table public.match_snapshots (
  match_id uuid primary key references public.matches(id) on delete cascade,
  version bigint not null check (version >= 0),
  state jsonb not null,
  meta jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.match_views (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  version bigint not null check (version >= 0),
  view jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

create table public.match_actions (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.matches(id) on delete cascade,
  request_id uuid not null,
  actor_user_id uuid,
  version_before bigint not null,
  version_after bigint not null,
  command jsonb not null,
  events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (match_id, request_id)
);

create table public.match_submissions (
  match_id uuid not null references public.matches(id) on delete cascade,
  version bigint not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid not null,
  actions jsonb not null check (jsonb_typeof(actions) = 'array'),
  created_at timestamptz not null default now(),
  primary key (match_id, version, user_id),
  unique (match_id, request_id)
);

create index match_seats_user_id_idx on public.match_seats(user_id) where user_id is not null;
create unique index match_seats_human_user_idx on public.match_seats(match_id, user_id) where user_id is not null;
create index match_actions_match_id_idx on public.match_actions(match_id, id);
create index match_submissions_lookup_idx on public.match_submissions(match_id, version);

create or replace function private.is_match_member(target_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.match_seats
    where match_id = target_match_id
      and user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_match_member(uuid) from public, anon;
grant execute on function private.is_match_member(uuid) to authenticated;

alter table public.matches enable row level security;
alter table public.match_seats enable row level security;
alter table public.match_snapshots enable row level security;
alter table public.match_views enable row level security;
alter table public.match_actions enable row level security;
alter table public.match_submissions enable row level security;

revoke all on public.matches, public.match_seats, public.match_snapshots,
  public.match_views, public.match_actions, public.match_submissions from anon, authenticated;
grant select on public.matches, public.match_seats, public.match_views to authenticated;
grant all on public.matches, public.match_seats, public.match_snapshots,
  public.match_views, public.match_actions, public.match_submissions to service_role;
grant usage, select on sequence public.match_actions_id_seq to service_role;

create policy matches_select_members
on public.matches for select to authenticated
using ((select private.is_match_member(id)));

create policy match_seats_select_members
on public.match_seats for select to authenticated
using ((select private.is_match_member(match_id)));

create policy match_views_select_self
on public.match_views for select to authenticated
using (user_id = (select auth.uid()));

create or replace function public.commit_match_start(
  p_lobby_id uuid,
  p_host_user_id uuid,
  p_seed bigint,
  p_state jsonb,
  p_meta jsonb,
  p_seats jsonb,
  p_views jsonb
)
returns setof public.matches
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_lobby public.lobbies;
  created_match public.matches;
  human_count integer;
  ready_count integer;
begin
  select * into target_lobby
  from public.lobbies
  where id = p_lobby_id
  for update;
  if not found then
    raise exception 'Lobby not found' using errcode = 'P0002';
  end if;

  select * into created_match from public.matches where lobby_id = p_lobby_id;
  if found then
    return next created_match;
    return;
  end if;

  if target_lobby.status <> 'waiting' or target_lobby.host_user_id <> p_host_user_id then
    raise exception 'Only the waiting lobby host can start this match' using errcode = '42501';
  end if;

  select count(*), count(*) filter (where is_ready)
  into human_count, ready_count
  from public.lobby_members
  where lobby_id = p_lobby_id;

  if human_count < 2 or human_count > 4 then
    raise exception 'A match requires two through four human players' using errcode = '23514';
  end if;
  if ready_count <> human_count then
    raise exception 'Every human player must be ready' using errcode = '23514';
  end if;
  if jsonb_typeof(p_state) <> 'object' or jsonb_typeof(p_meta) <> 'object'
    or jsonb_typeof(p_seats) <> 'array' or jsonb_array_length(p_seats) <> 4
    or jsonb_typeof(p_views) <> 'object' then
    raise exception 'Invalid match payload' using errcode = '22023';
  end if;

  insert into public.matches (lobby_id)
  values (p_lobby_id)
  returning * into created_match;

  insert into public.match_snapshots (match_id, version, state, meta)
  values (created_match.id, 0, p_state, p_meta);

  insert into public.match_seats (match_id, user_id, player_id, seat_index, display_name, is_human)
  select
    created_match.id,
    nullif(value ->> 'userId', '')::uuid,
    value ->> 'playerId',
    (value ->> 'seat')::smallint,
    value ->> 'name',
    (value ->> 'isHuman')::boolean
  from jsonb_array_elements(p_seats);

  if (select count(*) from public.match_seats where match_id = created_match.id and is_human) <> human_count
    or exists (
      select 1
      from public.match_seats seat
      where seat.match_id = created_match.id and seat.is_human
        and not exists (
          select 1 from public.lobby_members member
          where member.lobby_id = p_lobby_id
            and member.user_id = seat.user_id
            and member.seat_index = seat.seat_index
        )
    ) then
    raise exception 'Match seats do not match lobby membership' using errcode = '22023';
  end if;

  insert into public.match_views (match_id, user_id, version, view)
  select created_match.id, key::uuid, 0, value
  from jsonb_each(p_views);

  if (select count(*) from public.match_views where match_id = created_match.id) <> human_count then
    raise exception 'Each human requires one private view' using errcode = '22023';
  end if;

  insert into public.match_actions (
    match_id, request_id, actor_user_id, version_before, version_after, command, events
  ) values (
    created_match.id, gen_random_uuid(), p_host_user_id, 0, 0,
    jsonb_build_object('type', 'matchStarted', 'seed', p_seed), '[]'::jsonb
  );

  update public.lobbies
  set status = 'started', updated_at = now()
  where id = p_lobby_id;

  return next created_match;
end;
$$;

create or replace function public.store_match_submission(
  p_match_id uuid,
  p_expected_version bigint,
  p_user_id uuid,
  p_request_id uuid,
  p_actions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_match public.matches;
  existing_actions jsonb;
  submissions jsonb;
begin
  select * into target_match from public.matches where id = p_match_id for update;
  if not found or target_match.status <> 'active' then
    raise exception 'Match is not active' using errcode = '23514';
  end if;

  select command -> 'actions' into existing_actions
  from public.match_actions
  where match_id = p_match_id and request_id = p_request_id;
  if found then
    select coalesce(jsonb_agg(jsonb_build_object('userId', user_id, 'actions', actions)), '[]'::jsonb)
    into submissions from public.match_submissions
    where match_id = p_match_id and version = target_match.version;
    return jsonb_build_object('version', target_match.version, 'submissions', submissions, 'idempotent', true);
  end if;

  if target_match.version <> p_expected_version then
    raise exception 'Match version changed' using errcode = '40001';
  end if;
  if jsonb_typeof(p_actions) <> 'array' or not exists (
    select 1 from public.match_seats
    where match_id = p_match_id and user_id = p_user_id and is_human
  ) then
    raise exception 'Invalid match submission' using errcode = '42501';
  end if;

  select actions into existing_actions
  from public.match_submissions
  where match_id = p_match_id and version = p_expected_version and user_id = p_user_id;
  if found then
    if existing_actions <> p_actions then
      raise exception 'Allocation already submitted for this term' using errcode = '23505';
    end if;
  else
    insert into public.match_submissions (match_id, version, user_id, request_id, actions)
    values (p_match_id, p_expected_version, p_user_id, p_request_id, p_actions);

    insert into public.match_actions (
      match_id, request_id, actor_user_id, version_before, version_after, command
    ) values (
      p_match_id, p_request_id, p_user_id, p_expected_version, p_expected_version,
      jsonb_build_object('type', 'submitAllocation', 'actions', p_actions)
    );
  end if;

  update public.matches set updated_at = now() where id = p_match_id;
  select coalesce(jsonb_agg(jsonb_build_object('userId', user_id, 'actions', actions)), '[]'::jsonb)
  into submissions from public.match_submissions
  where match_id = p_match_id and version = p_expected_version;
  return jsonb_build_object('version', p_expected_version, 'submissions', submissions, 'idempotent', false);
end;
$$;

create or replace function public.update_match_views(
  p_match_id uuid,
  p_expected_version bigint,
  p_views jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.matches
    where id = p_match_id and version = p_expected_version and status = 'active'
    for update
  ) then
    return false;
  end if;

  insert into public.match_views (match_id, user_id, version, view, updated_at)
  select p_match_id, key::uuid, p_expected_version, value, now()
  from jsonb_each(p_views)
  on conflict (match_id, user_id) do update
  set version = excluded.version, view = excluded.view, updated_at = now();
  return true;
end;
$$;

create or replace function public.commit_match_transition(
  p_match_id uuid,
  p_expected_version bigint,
  p_request_id uuid,
  p_actor_user_id uuid,
  p_command jsonb,
  p_state jsonb,
  p_meta jsonb,
  p_events jsonb,
  p_views jsonb,
  p_status text,
  p_winner_player_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_match public.matches;
  next_version bigint := p_expected_version + 1;
begin
  select * into target_match from public.matches where id = p_match_id for update;
  if not found then
    raise exception 'Match not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.match_actions
    where match_id = p_match_id and request_id = p_request_id
  ) then
    return jsonb_build_object('applied', false, 'idempotent', true, 'version', target_match.version);
  end if;
  if target_match.status <> 'active' or target_match.version <> p_expected_version then
    return jsonb_build_object('applied', false, 'idempotent', false, 'version', target_match.version);
  end if;
  if p_status not in ('active', 'complete') or jsonb_typeof(p_state) <> 'object'
    or jsonb_typeof(p_meta) <> 'object' or jsonb_typeof(p_events) <> 'array'
    or jsonb_typeof(p_views) <> 'object' then
    raise exception 'Invalid match transition payload' using errcode = '22023';
  end if;

  update public.match_snapshots
  set version = next_version, state = p_state, meta = p_meta, updated_at = now()
  where match_id = p_match_id and version = p_expected_version;
  if not found then
    raise exception 'Snapshot version mismatch' using errcode = '40001';
  end if;

  insert into public.match_views (match_id, user_id, version, view, updated_at)
  select p_match_id, key::uuid, next_version, value, now()
  from jsonb_each(p_views)
  on conflict (match_id, user_id) do update
  set version = excluded.version, view = excluded.view, updated_at = now();

  insert into public.match_actions (
    match_id, request_id, actor_user_id, version_before, version_after, command, events
  ) values (
    p_match_id, p_request_id, p_actor_user_id, p_expected_version, next_version, p_command, p_events
  );

  delete from public.match_submissions
  where match_id = p_match_id and version = p_expected_version;

  update public.matches
  set version = next_version,
      status = p_status,
      winner_player_id = p_winner_player_id,
      updated_at = now(),
      completed_at = case when p_status = 'complete' then now() else null end
  where id = p_match_id;

  return jsonb_build_object('applied', true, 'idempotent', false, 'version', next_version);
end;
$$;

revoke all on function public.commit_match_start(uuid, uuid, bigint, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.store_match_submission(uuid, bigint, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.update_match_views(uuid, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.commit_match_transition(uuid, bigint, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.commit_match_start(uuid, uuid, bigint, jsonb, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.store_match_submission(uuid, bigint, uuid, uuid, jsonb) to service_role;
grant execute on function public.update_match_views(uuid, bigint, jsonb) to service_role;
grant execute on function public.commit_match_transition(uuid, bigint, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb, text, text) to service_role;

alter publication supabase_realtime add table public.match_views;

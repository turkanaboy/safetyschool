alter table public.lobbies
add column updated_at timestamptz not null default now();

create or replace function private.shares_waiting_lobby(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.lobby_members viewer
    join public.lobby_members subject on subject.lobby_id = viewer.lobby_id
    join public.lobbies lobby on lobby.id = viewer.lobby_id
    where viewer.user_id = (select auth.uid())
      and subject.user_id = target_user_id
      and lobby.status = 'waiting'
  );
$$;

revoke all on function private.shares_waiting_lobby(uuid) from public, anon;
grant execute on function private.shares_waiting_lobby(uuid) to authenticated;

drop policy profiles_select_shared_lobby on public.profiles;
create policy profiles_select_shared_lobby
on public.profiles
for select
to authenticated
using (
  id = (select auth.uid())
  or (select private.shares_waiting_lobby(id))
);

create or replace function public.join_lobby(p_invite_code text)
returns setof public.lobbies
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  requested_code text := upper(btrim(coalesce(p_invite_code, '')));
  joined_lobby public.lobbies;
  available_seat smallint;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if requested_code !~ '^[A-F0-9]{8}$' then
    raise exception 'Enter an eight-character lobby code' using errcode = '22023';
  end if;

  select *
  into joined_lobby
  from public.lobbies
  where invite_code = requested_code
    and status = 'waiting'
  for update;

  if not found then
    raise exception 'Lobby not found' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.lobby_members
    where lobby_id = joined_lobby.id and user_id = current_user_id
  ) then
    return next joined_lobby;
    return;
  end if;

  select seat
  into available_seat
  from generate_series(0, 3) as seats(seat)
  where not exists (
    select 1 from public.lobby_members
    where lobby_id = joined_lobby.id and seat_index = seats.seat
  )
  order by seat
  limit 1;

  if available_seat is null then
    raise exception 'Lobby is full' using errcode = '23514';
  end if;

  insert into public.lobby_members (lobby_id, user_id, seat_index)
  values (joined_lobby.id, current_user_id, available_seat);

  update public.lobbies
  set updated_at = now()
  where id = joined_lobby.id
  returning * into joined_lobby;

  return next joined_lobby;
end;
$$;

create or replace function public.set_lobby_ready(p_lobby_id uuid, p_ready boolean)
returns setof public.lobby_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  updated_member public.lobby_members;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  update public.lobby_members
  set is_ready = coalesce(p_ready, false)
  where lobby_id = p_lobby_id
    and user_id = current_user_id
  returning * into updated_member;

  if not found then
    raise exception 'You are not a member of that lobby' using errcode = '42501';
  end if;

  update public.lobbies
  set updated_at = now()
  where id = p_lobby_id and status = 'waiting';

  if not found then
    raise exception 'That lobby is no longer waiting' using errcode = '23514';
  end if;

  return next updated_member;
end;
$$;

create or replace function public.leave_lobby(p_lobby_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  lobby_host_id uuid;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select host_user_id
  into lobby_host_id
  from public.lobbies
  where id = p_lobby_id and status = 'waiting'
  for update;

  if not found or not exists (
    select 1 from public.lobby_members
    where lobby_id = p_lobby_id and user_id = current_user_id
  ) then
    raise exception 'You are not a member of that lobby' using errcode = '42501';
  end if;

  if lobby_host_id = current_user_id then
    update public.lobbies
    set status = 'cancelled', updated_at = now()
    where id = p_lobby_id;
  else
    delete from public.lobby_members
    where lobby_id = p_lobby_id and user_id = current_user_id;

    update public.lobbies
    set updated_at = now()
    where id = p_lobby_id;
  end if;
end;
$$;

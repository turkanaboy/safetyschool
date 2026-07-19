create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  role text not null default 'player' check (role in ('player', 'owner')),
  created_at timestamptz not null default now()
);

create table public.lobbies (
  id uuid primary key default gen_random_uuid(),
  invite_code text not null unique check (invite_code ~ '^[A-F0-9]{6}$'),
  host_user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'waiting' check (status in ('waiting', 'cancelled')),
  created_at timestamptz not null default now()
);

create table public.lobby_members (
  lobby_id uuid not null references public.lobbies(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  seat_index smallint not null check (seat_index between 0 and 3),
  is_ready boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (lobby_id, user_id),
  unique (lobby_id, seat_index)
);

create index lobby_members_user_id_idx on public.lobby_members(user_id);

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_name text;
begin
  profile_name := left(
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'President'
    ),
    40
  );

  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    profile_name,
    case when lower(coalesce(new.email, '')) = 'tylermlowell@gmail.com' then 'owner' else 'player' end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();

insert into public.profiles (id, display_name, role, created_at)
select
  id,
  left(
    coalesce(
      nullif(btrim(raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(email, ''), '@', 1), ''),
      'President'
    ),
    40
  ),
  case when lower(coalesce(email, '')) = 'tylermlowell@gmail.com' then 'owner' else 'player' end,
  created_at
from auth.users
on conflict (id) do nothing;

create or replace function private.is_lobby_member(target_lobby_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.lobby_members
    where lobby_id = target_lobby_id
      and user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_lobby_member(uuid) from public, anon;
grant execute on function private.is_lobby_member(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.lobbies enable row level security;
alter table public.lobby_members enable row level security;

revoke all on public.profiles, public.lobbies, public.lobby_members from anon, authenticated;
grant select on public.profiles, public.lobbies, public.lobby_members to authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy profiles_select_shared_lobby
on public.profiles
for select
to authenticated
using (
  id = (select auth.uid())
  or exists (
    select 1
    from public.lobby_members viewer
    join public.lobby_members subject on subject.lobby_id = viewer.lobby_id
    where viewer.user_id = (select auth.uid())
      and subject.user_id = profiles.id
  )
);

create policy profiles_update_self
on public.profiles
for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy lobbies_select_members
on public.lobbies
for select
to authenticated
using ((select private.is_lobby_member(id)));

create policy lobby_members_select_shared
on public.lobby_members
for select
to authenticated
using ((select private.is_lobby_member(lobby_id)));

create or replace function public.create_lobby()
returns setof public.lobbies
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  created_lobby public.lobbies;
  generated_code text;
  attempt integer;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  for attempt in 1..10 loop
    generated_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    begin
      insert into public.lobbies (invite_code, host_user_id)
      values (generated_code, current_user_id)
      returning * into created_lobby;

      insert into public.lobby_members (lobby_id, user_id, seat_index)
      values (created_lobby.id, current_user_id, 0);

      return next created_lobby;
      return;
    exception
      when unique_violation then
        null;
    end;
  end loop;

  raise exception 'Could not create a unique lobby code' using errcode = '23505';
end;
$$;

revoke all on function public.create_lobby() from public, anon;
grant execute on function public.create_lobby() to authenticated;

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
  if requested_code !~ '^[A-F0-9]{6}$' then
    raise exception 'Enter a six-character lobby code' using errcode = '22023';
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

  return next joined_lobby;
end;
$$;

revoke all on function public.join_lobby(text) from public, anon;
grant execute on function public.join_lobby(text) to authenticated;

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

  return next updated_member;
end;
$$;

revoke all on function public.set_lobby_ready(uuid, boolean) from public, anon;
grant execute on function public.set_lobby_ready(uuid, boolean) to authenticated;

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
    update public.lobbies set status = 'cancelled' where id = p_lobby_id;
    delete from public.lobby_members where lobby_id = p_lobby_id;
  else
    delete from public.lobby_members
    where lobby_id = p_lobby_id and user_id = current_user_id;
  end if;
end;
$$;

revoke all on function public.leave_lobby(uuid) from public, anon;
grant execute on function public.leave_lobby(uuid) to authenticated;

alter publication supabase_realtime add table public.lobbies, public.lobby_members;

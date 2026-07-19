alter table public.lobbies drop constraint lobbies_invite_code_check;
alter table public.lobbies add constraint lobbies_invite_code_check check (
  invite_code ~ '^([2-9A-HJ-NP-Z]{6}|[A-F0-9]{8})$'
);

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
  code_alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  code_bytes bytea;
  code_position integer;
  attempt integer;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  for attempt in 1..10 loop
    code_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    generated_code := '';
    for code_position in 0..5 loop
      generated_code := generated_code || substr(
        code_alphabet,
        (get_byte(code_bytes, code_position) % 32) + 1,
        1
      );
    end loop;

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
  if requested_code !~ '^([2-9A-HJ-NP-Z]{6}|[A-F0-9]{8})$' then
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

  update public.lobbies
  set updated_at = now()
  where id = joined_lobby.id
  returning * into joined_lobby;

  return next joined_lobby;
end;
$$;

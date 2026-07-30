create or replace function private.valid_lobby_setup(candidate jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when candidate is null or jsonb_typeof(candidate) <> 'object' then false
    else
      candidate ?& array['schoolName', 'mascot', 'color', 'upgrades']
      and candidate - array['schoolName', 'mascot', 'color', 'upgrades'] = '{}'::jsonb
      and jsonb_typeof(candidate -> 'schoolName') = 'string'
      and char_length(btrim(candidate ->> 'schoolName')) between 1 and 42
      and candidate ->> 'mascot' = any (array['owl', 'fox', 'bison'])
      and candidate ->> 'color' = any (array['pine', 'brick', 'lake'])
      and case
        when jsonb_typeof(candidate -> 'upgrades') <> 'object' then false
        else
          (candidate -> 'upgrades') - array[
            'academics',
            'studentAffairs',
            'athletics',
            'admissions',
            'marketing',
            'administration'
          ] = '{}'::jsonb
          and not exists (
            select 1
            from jsonb_each(candidate -> 'upgrades') as upgrade
            where jsonb_typeof(upgrade.value) <> 'number'
              or upgrade.value::text !~ '^[0-2]$'
          )
          and coalesce((
            select sum((upgrade.value #>> '{}')::integer)
            from jsonb_each(candidate -> 'upgrades') as upgrade
          ), 0) = 3
      end
  end;
$$;

revoke all on function private.valid_lobby_setup(jsonb) from public, anon, authenticated;

alter table public.lobby_members
add column setup jsonb,
add constraint lobby_members_setup_valid check (
  setup is null or private.valid_lobby_setup(setup)
);

create or replace function public.set_lobby_setup(p_lobby_id uuid, p_setup jsonb)
returns setof public.lobby_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  updated_member public.lobby_members;
  normalized_setup jsonb;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if not private.valid_lobby_setup(p_setup) then
    raise exception 'Choose a school name, mascot, colors, and exactly three founding levels' using errcode = '22023';
  end if;

  normalized_setup := jsonb_build_object(
    'schoolName', btrim(p_setup ->> 'schoolName'),
    'mascot', p_setup ->> 'mascot',
    'color', p_setup ->> 'color',
    'upgrades', p_setup -> 'upgrades'
  );

  update public.lobby_members
  set setup = normalized_setup,
      is_ready = false
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

revoke all on function public.set_lobby_setup(uuid, jsonb) from public, anon;
grant execute on function public.set_lobby_setup(uuid, jsonb) to authenticated;

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
  if coalesce(p_ready, false) and not exists (
    select 1
    from public.lobby_members
    where lobby_id = p_lobby_id
      and user_id = current_user_id
      and setup is not null
  ) then
    raise exception 'Save your founding plan before marking ready' using errcode = '22023';
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

revoke all on function public.set_lobby_ready(uuid, boolean) from public, anon;
grant execute on function public.set_lobby_ready(uuid, boolean) to authenticated;

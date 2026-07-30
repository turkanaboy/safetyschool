alter table public.matches
add column content_set_id uuid references public.card_sets(id);

create index matches_content_set_id_idx on public.matches(content_set_id);

create or replace function public.commit_match_start(
  p_lobby_id uuid,
  p_host_user_id uuid,
  p_seed bigint,
  p_state jsonb,
  p_meta jsonb,
  p_seats jsonb,
  p_views jsonb,
  p_content_set_id uuid
)
returns setof public.matches
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_match public.matches;
begin
  if not exists (
    select 1 from public.card_sets
    where id = p_content_set_id and status = 'published'
  ) then
    raise exception 'Published card set not found' using errcode = 'P0002';
  end if;

  select * into created_match
  from public.commit_match_start(
    p_lobby_id,
    p_host_user_id,
    p_seed,
    p_state,
    p_meta,
    p_seats,
    p_views
  );

  if created_match.content_set_id is not null
    and created_match.content_set_id <> p_content_set_id then
    raise exception 'Match already uses another card set' using errcode = '23514';
  end if;

  update public.matches
  set content_set_id = p_content_set_id
  where id = created_match.id
  returning * into created_match;

  return next created_match;
end;
$$;

create or replace function public.get_match_card_set(p_match_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not (select private.is_match_member(p_match_id)) then
    raise exception 'Match membership required' using errcode = '42501';
  end if;

  select case
    when matches.content_set_id is null then jsonb_build_object('cardSetId', null)
    else jsonb_build_object(
      'cardSetId', card_sets.id,
      'version', card_sets.version,
      'contentHash', card_sets.content_hash,
      'deck', card_sets.deck
    )
  end
  into result
  from public.matches
  left join public.card_sets on card_sets.id = matches.content_set_id
  where matches.id = p_match_id;

  if result is null then
    raise exception 'Match not found' using errcode = 'P0002';
  end if;
  return result;
end;
$$;

revoke all on function public.commit_match_start(uuid, uuid, bigint, jsonb, jsonb, jsonb, jsonb, uuid)
from public, anon, authenticated;
grant execute on function public.commit_match_start(uuid, uuid, bigint, jsonb, jsonb, jsonb, jsonb, uuid)
to service_role;

revoke all on function public.get_match_card_set(uuid) from public, anon;
grant execute on function public.get_match_card_set(uuid) to authenticated;

create table public.card_sets (
  id uuid primary key default gen_random_uuid(),
  version bigint generated always as identity unique,
  status text not null default 'draft' check (status in ('draft', 'published')),
  deck jsonb not null check (jsonb_typeof(deck) = 'object'),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  validation jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

create unique index card_sets_published_hash_idx
on public.card_sets(content_hash)
where status = 'published';

create table public.active_card_set (
  singleton boolean primary key default true check (singleton),
  card_set_id uuid not null references public.card_sets(id),
  activated_at timestamptz not null default now()
);

create or replace function private.protect_published_card_set()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'published' then
    raise exception 'Published card sets are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_published_card_set() from public, anon, authenticated;

create trigger protect_published_card_set
before update or delete on public.card_sets
for each row execute function private.protect_published_card_set();

create or replace function public.ensure_active_card_set(
  p_deck jsonb,
  p_content_hash text,
  p_validation jsonb
)
returns setof public.card_sets
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.card_sets;
begin
  perform pg_advisory_xact_lock(hashtext('safety_school_active_card_set'));

  select card_sets.* into target
  from public.active_card_set
  join public.card_sets on card_sets.id = active_card_set.card_set_id
  where active_card_set.singleton;

  if not found then
    select * into target
    from public.card_sets
    where status = 'published' and content_hash = p_content_hash;

    if not found then
      insert into public.card_sets (
        status, deck, content_hash, validation, published_at
      ) values (
        'published', p_deck, p_content_hash, p_validation, now()
      )
      returning * into target;
    end if;

    insert into public.active_card_set (singleton, card_set_id, activated_at)
    values (true, target.id, now())
    on conflict (singleton) do nothing;

    select card_sets.* into target
    from public.active_card_set
    join public.card_sets on card_sets.id = active_card_set.card_set_id
    where active_card_set.singleton;
  end if;

  return next target;
end;
$$;

create or replace function public.publish_card_set(p_set_id uuid, p_validation jsonb)
returns setof public.card_sets
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.card_sets;
begin
  select * into target
  from public.card_sets
  where id = p_set_id
  for update;

  if not found then
    raise exception 'Card set not found' using errcode = 'P0002';
  end if;

  if target.status = 'draft' then
    update public.card_sets
    set status = 'published',
        validation = p_validation,
        published_at = now(),
        updated_at = now()
    where id = p_set_id
    returning * into target;
  end if;

  insert into public.active_card_set (singleton, card_set_id, activated_at)
  values (true, target.id, now())
  on conflict (singleton) do update
  set card_set_id = excluded.card_set_id,
      activated_at = excluded.activated_at;

  return next target;
end;
$$;

create or replace function public.activate_card_set(p_set_id uuid)
returns setof public.card_sets
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.card_sets;
begin
  select * into target
  from public.card_sets
  where id = p_set_id and status = 'published';
  if not found then
    raise exception 'Published card set not found' using errcode = 'P0002';
  end if;

  insert into public.active_card_set (singleton, card_set_id, activated_at)
  values (true, target.id, now())
  on conflict (singleton) do update
  set card_set_id = excluded.card_set_id,
      activated_at = excluded.activated_at;

  return next target;
end;
$$;

alter table public.card_sets enable row level security;
alter table public.active_card_set enable row level security;

revoke all on public.card_sets, public.active_card_set from public, anon, authenticated;
grant all on public.card_sets, public.active_card_set to service_role;
grant usage, select on sequence public.card_sets_version_seq to service_role;

revoke all on function public.publish_card_set(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.activate_card_set(uuid) from public, anon, authenticated;
revoke all on function public.ensure_active_card_set(jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.publish_card_set(uuid, jsonb) to service_role;
grant execute on function public.activate_card_set(uuid) to service_role;
grant execute on function public.ensure_active_card_set(jsonb, text, jsonb) to service_role;

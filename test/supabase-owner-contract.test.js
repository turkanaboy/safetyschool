import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20260730170430_owner_dashboard.sql', import.meta.url), 'utf8');
const contentMigration = await readFile(new URL('../supabase/migrations/20260730170937_versioned_card_sets.sql', import.meta.url), 'utf8');
const ownerFunction = await readFile(new URL('../supabase/functions/owner-content/index.ts', import.meta.url), 'utf8');
const matchMigration = await readFile(new URL('../supabase/migrations/20260730172047_match_content_identity.sql', import.meta.url), 'utf8');
const matchFunction = await readFile(new URL('../supabase/functions/match-command/index.ts', import.meta.url), 'utf8');

test('owner metrics require a permanent owner and return aggregates only', () => {
  assert.match(migration, /auth\.jwt\(\) ->> 'is_anonymous'/);
  assert.match(migration, /role = 'owner'/);
  assert.match(migration, /if not \(select private\.is_owner\(\)\)/);
  assert.match(migration, /revoke all on function public\.owner_dashboard\(integer\) from public, anon/);
  assert.match(migration, /grant execute on function public\.owner_dashboard\(integer\) to authenticated/);
  assert.doesNotMatch(migration, /match_snapshots|match_views|auth\.users/);
});

test('owner metrics expose bounded windows and anonymous identity labels', () => {
  assert.match(migration, /p_days in \(7, 30, 90\)/);
  assert.match(migration, /as anonymous_identities/);
  assert.match(migration, /'recentMatches'/);
});

test('card drafts are private and published sets are immutable', () => {
  assert.match(contentMigration, /alter table public\.card_sets enable row level security/);
  assert.match(contentMigration, /revoke all on public\.card_sets, public\.active_card_set from public, anon, authenticated/);
  assert.match(contentMigration, /Published card sets are immutable/);
  assert.match(contentMigration, /create unique index card_sets_published_hash_idx/);
  assert.match(contentMigration, /on conflict \(singleton\) do update/);
});

test('owner content verifies the caller before using service-role access', () => {
  assert.match(ownerFunction, /userClient\.auth\.getUser\(token\)/);
  assert.match(ownerFunction, /profile\.role !== 'owner' \|\| user\.is_anonymous/);
  assert.match(ownerFunction, /npm:@supabase\/supabase-js@2\.110\.7/);
  assert.doesNotMatch(ownerFunction, /sb_secret_|service_role_[A-Za-z0-9]/);
});

test('matches pin one published card set and expose it only to members', () => {
  assert.match(matchMigration, /add column content_set_id uuid references public\.card_sets/);
  assert.match(matchMigration, /p_content_set_id uuid/);
  assert.match(matchMigration, /private\.is_match_member\(p_match_id\)/);
  assert.match(matchMigration, /grant execute on function public\.get_match_card_set\(uuid\) to authenticated/);
  assert.match(matchFunction, /p_content_set_id: contentSetId/);
  assert.match(matchFunction, /Pinned card set hash is inconsistent/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20260730170430_owner_dashboard.sql', import.meta.url), 'utf8');

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

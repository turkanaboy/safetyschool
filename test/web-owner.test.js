import assert from 'node:assert/strict';
import test from 'node:test';

import { completionRate, createOwnerService } from '../web/owner.js';

test('owner service keeps account creation disabled and requests aggregate metrics', async () => {
  const calls = [];
  const client = {
    auth: {
      async getSession() {
        calls.push(['getSession']);
        return { data: { session: { user: { id: 'owner-1' } } }, error: null };
      },
      async signInWithOtp(payload) {
        calls.push(['signInWithOtp', payload]);
        return { data: {}, error: null };
      },
      async signOut() {
        calls.push(['signOut']);
        return { data: {}, error: null };
      },
    },
    async rpc(name, payload) {
      calls.push(['rpc', name, payload]);
      return { data: { windowDays: 30 }, error: null };
    },
  };
  const owner = createOwnerService(client);

  assert.equal((await owner.session()).user.id, 'owner-1');
  await owner.signIn(' owner@example.com ', 'https://safetyschoolgame.com/owner.html');
  assert.deepEqual(await owner.dashboard(30), { windowDays: 30 });
  await owner.signOut();

  assert.deepEqual(calls, [
    ['getSession'],
    ['signInWithOtp', {
      email: 'owner@example.com',
      options: {
        shouldCreateUser: false,
        emailRedirectTo: 'https://safetyschoolgame.com/owner.html',
      },
    }],
    ['rpc', 'owner_dashboard', { p_days: 30 }],
    ['signOut'],
  ]);
});

test('owner dashboard completion rate handles empty and active windows', () => {
  assert.equal(completionRate({ started: 0, completed: 0 }), 0);
  assert.equal(completionRate({ started: 8, completed: 6 }), 75);
});

test('owner service surfaces authorization failures', async () => {
  const owner = createOwnerService({
    async rpc() {
      return { data: null, error: { message: 'Owner access required' } };
    },
  });

  await assert.rejects(owner.dashboard(), /Owner access required/);
});


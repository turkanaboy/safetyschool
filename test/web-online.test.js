import assert from 'node:assert/strict';
import test from 'node:test';

import { createOnlineService, normalizeLobbyCode } from '../web/online.js';

test('online service validates lobby codes and sends scoped auth and RPC requests', async () => {
  const calls = [];
  const client = {
    auth: {
      async getSession() {
        calls.push(['getSession']);
        return { data: { session: { user: { id: 'user-1' } } }, error: null };
      },
      async signInWithOtp(payload) {
        calls.push(['signInWithOtp', payload]);
        return { error: null };
      },
      async signOut() {
        calls.push(['signOut']);
        return { error: null };
      },
    },
    async rpc(name, payload) {
      calls.push(['rpc', name, payload]);
      return { data: [{ id: 'lobby-1', invite_code: 'ABC123EF' }], error: null };
    },
  };
  const online = createOnlineService(client, { redirectOrigin: 'https://safetyschool.com' });

  assert.equal(normalizeLobbyCode(' abc123ef '), 'ABC123EF');
  assert.throws(() => normalizeLobbyCode('not-a-code'), /eight-character/i);
  assert.equal((await online.session()).user.id, 'user-1');
  await online.signIn(' president@example.com ', ' Founders Green ', 'abc123ef');
  await assert.rejects(online.joinLobby('bad'), /eight-character/i);
  const lobby = await online.joinLobby('abc123ef');
  await online.createLobby();
  await online.setReady('lobby-1', 1);
  await online.leaveLobby('lobby-1');
  await online.signOut();

  assert.equal(lobby.id, 'lobby-1');
  assert.deepEqual(calls, [
    ['getSession'],
    ['signInWithOtp', {
      email: 'president@example.com',
      options: {
        data: { display_name: 'Founders Green' },
        emailRedirectTo: 'https://safetyschool.com/online.html?join=ABC123EF',
      },
    }],
    ['rpc', 'join_lobby', { p_invite_code: 'ABC123EF' }],
    ['rpc', 'create_lobby', undefined],
    ['rpc', 'set_lobby_ready', { p_lobby_id: 'lobby-1', p_ready: true }],
    ['rpc', 'leave_lobby', { p_lobby_id: 'lobby-1' }],
    ['signOut'],
  ]);
});

test('online service surfaces Supabase failures', async () => {
  const online = createOnlineService({
    async rpc() {
      return { data: null, error: { message: 'Database unavailable' } };
    },
  }, { redirectOrigin: 'https://safetyschool.com' });

  await assert.rejects(online.createLobby(), /Database unavailable/);
});

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

test('online service scopes profile, lobby, and realtime observations', async () => {
  const calls = [];
  const profile = { id: 'user-1', display_name: 'Founders Green', role: 'player' };
  let realtimeChannel;
  const client = {
    from(table) {
      calls.push(['from', table]);
      return {
        select(columns) {
          calls.push(['select', table, columns]);
          return this;
        },
        eq(column, value) {
          calls.push(['eq', table, column, value]);
          return this;
        },
        order(column, options) {
          calls.push(['order', table, column, options]);
          return this;
        },
        async single() {
          calls.push(['single', table]);
          return { data: profile, error: null };
        },
        then(resolve, reject) {
          calls.push(['execute', table]);
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
    },
    channel(name) {
      calls.push(['channel', name]);
      realtimeChannel = {
        on(type, config, handler) {
          calls.push(['on', type, config, handler]);
          return this;
        },
        subscribe() {
          calls.push(['subscribe']);
          return this;
        },
      };
      return realtimeChannel;
    },
    removeChannel(channel) {
      calls.push(['removeChannel', channel]);
    },
  };
  const online = createOnlineService(client, { redirectOrigin: 'https://safetyschool.com' });
  const onChange = () => {};

  assert.equal(await online.profile('user-1'), profile);
  assert.deepEqual(await online.lobbies(), []);
  const stop = online.subscribe('lobby-1', onChange);
  stop();

  assert.deepEqual(calls.slice(0, 9), [
    ['from', 'profiles'],
    ['select', 'profiles', 'id,display_name,role'],
    ['eq', 'profiles', 'id', 'user-1'],
    ['single', 'profiles'],
    ['from', 'lobbies'],
    ['select', 'lobbies', 'id,invite_code,host_user_id,status,created_at,lobby_members(user_id,seat_index,is_ready,profiles(display_name,role))'],
    ['eq', 'lobbies', 'status', 'waiting'],
    ['order', 'lobbies', 'created_at', { ascending: false }],
    ['execute', 'lobbies'],
  ]);
  assert.equal(calls[9][0], 'channel');
  assert.equal(calls[9][1], 'lobby:lobby-1');
  assert.deepEqual(calls[10], [
    'on',
    'postgres_changes',
    { event: '*', schema: 'public', table: 'lobbies', filter: 'id=eq.lobby-1' },
    onChange,
  ]);
  assert.deepEqual(calls[11], [
    'on',
    'postgres_changes',
    { event: '*', schema: 'public', table: 'lobby_members', filter: 'lobby_id=eq.lobby-1' },
    onChange,
  ]);
  assert.deepEqual(calls.slice(12).map(([name]) => name), ['subscribe', 'removeChannel']);
  assert.equal(calls[13][1], realtimeChannel);
});

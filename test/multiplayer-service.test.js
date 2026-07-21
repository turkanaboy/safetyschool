import assert from 'node:assert/strict';
import test from 'node:test';

import { loadContent } from '../engine/content-node.js';
import { createMatchRuntime, startMatchRound } from '../multiplayer/runtime.js';
import { createMatchService } from '../multiplayer/service.js';

const content = loadContent();
const lobby = {
  id: '11111111-1111-4111-8111-111111111111',
  host_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  status: 'waiting',
  lobby_members: [
    { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', seat_index: 0, is_ready: true, profiles: { display_name: 'Founders Green' } },
    { user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', seat_index: 1, is_ready: true, profiles: { display_name: 'Safety State' } },
  ],
};

test('match service starts only a ready host lobby and stores private views', async () => {
  let started = null;
  const store = {
    async getLobby() { return lobby; },
    async startMatch(payload) {
      started = payload;
      return { id: '22222222-2222-4222-8222-222222222222', version: 0, status: 'active' };
    },
    async getView(matchId, userId) { return { matchId, userId, version: 0, view: started.views[userId] }; },
  };
  const service = createMatchService({ content, store, randomSeed: () => 42 });

  await assert.rejects(
    service.handle('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { action: 'start', lobbyId: lobby.id }),
    /host/i,
  );
  const response = await service.handle(lobby.host_user_id, { action: 'start', lobbyId: lobby.id });

  assert.equal(response.matchId, '22222222-2222-4222-8222-222222222222');
  assert.equal(started.seats.length, 4);
  assert.deepEqual(Object.keys(started.views).sort(), lobby.lobby_members.map(({ user_id }) => user_id).sort());
  assert.equal('treasury' in started.views[lobby.host_user_id].opponents[0], false);
});

test('match service rejects malformed command identifiers before persistence', async () => {
  const service = createMatchService({ content, store: {} });
  await assert.rejects(service.handle(lobby.host_user_id, { action: 'beginTerm', matchId: 'bad' }), /matchId/i);
});

test('match service returns the current view for an already-applied request', async () => {
  const matchId = '22222222-2222-4222-8222-222222222222';
  const requestId = '33333333-3333-4333-8333-333333333333';
  const expected = { matchId, version: 2, view: { phase: 'ready' } };
  const store = {
    async getRequest() { return { actor_user_id: lobby.host_user_id }; },
    async getView() { return expected; },
    async getRuntime() { throw new Error('an idempotent retry must not rerun the engine'); },
  };
  const service = createMatchService({ content, store });

  assert.equal(await service.handle(lobby.host_user_id, {
    action: 'beginTerm',
    matchId,
    requestId,
  }), expected);
});

test('match service treats a raced begin-term command as already advanced', async () => {
  const matchId = '22222222-2222-4222-8222-222222222222';
  const expected = { matchId, version: 1, view: { phase: 'allocation' } };
  const created = createMatchRuntime({
    seed: 42,
    members: lobby.lobby_members.map((member) => ({
      userId: member.user_id,
      name: member.profiles.display_name,
      seat: member.seat_index,
    })),
  }, content);
  const started = startMatchRound(created.state, created.meta, lobby.host_user_id, content);
  const store = {
    async getRequest() { return null; },
    async getRuntime() {
      return {
        match: { id: matchId, status: 'active', version: 1 },
        snapshot: { state: started.state, meta: created.meta },
      };
    },
    async getView() { return expected; },
    async commitTransition() { throw new Error('a raced begin must not advance the engine twice'); },
  };
  const service = createMatchService({ content, store });

  assert.equal(await service.handle(lobby.host_user_id, {
    action: 'beginTerm',
    matchId,
    requestId: '33333333-3333-4333-8333-333333333333',
  }), expected);
});

test('match service resumes a stored allocation retry before its transition commits', async () => {
  const matchId = '22222222-2222-4222-8222-222222222222';
  const requestId = '33333333-3333-4333-8333-333333333333';
  const created = createMatchRuntime({
    seed: 42,
    members: lobby.lobby_members.map((member) => ({
      userId: member.user_id,
      name: member.profiles.display_name,
      seat: member.seat_index,
    })),
  }, content);
  const started = startMatchRound(created.state, created.meta, lobby.host_user_id, content);
  let storedActions;
  const store = {
    async getRequest() {
      return {
        actor_user_id: lobby.host_user_id,
        version_before: 1,
        command: { type: 'submitAllocation', actions: [] },
      };
    },
    async getRuntime() {
      return {
        match: { id: matchId, status: 'active', version: 1 },
        snapshot: { state: started.state, meta: created.meta },
      };
    },
    async storeSubmission(payload) {
      storedActions = payload.actions;
      return { submissions: [{ userId: lobby.host_user_id, actions: [] }] };
    },
    async updateViews() {},
    async getView() { return { matchId, version: 1, view: { phase: 'allocation' } }; },
  };
  const service = createMatchService({ content, store });

  await service.handle(lobby.host_user_id, {
    action: 'submitAllocation',
    matchId,
    requestId,
    actions: [{ type: 'upgrade', department: 'marketing' }],
  });

  assert.deepEqual(storedActions, []);
});

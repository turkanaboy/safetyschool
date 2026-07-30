import assert from 'node:assert/strict';
import test from 'node:test';

import { loadContent } from '../engine/content-node.js';
import {
  appendMatchHistory,
  createMatchRuntime,
  matchViews,
  resolveMatchAllocation,
  startMatchRound,
  validateHumanAllocation,
} from '../multiplayer/runtime.js';

const content = loadContent();
const members = [
  { userId: 'human-1', name: 'Founders Green', seat: 0 },
  { userId: 'human-2', name: 'Safety State', seat: 1 },
];

test('multiplayer runtime creates four fair seats and player-filtered views', () => {
  const created = createMatchRuntime({ seed: 42, members }, content);

  assert.equal(created.state.players.length, 4);
  assert.deepEqual(created.state.players.slice(0, 2).map(({ id, seat }) => ({ id, seat })), [
    { id: 'human-1', seat: 0 },
    { id: 'human-2', seat: 1 },
  ]);
  assert.equal(created.meta.rivals.length, 2);

  created.state.players[1].treasury = 123.45;
  const views = matchViews(created.state, created.meta, content, { events: created.events });
  assert.equal(views['human-1'].own.id, 'human-1');
  assert.equal(views['human-1'].roundsPerYear, content.config.gameLength.roundsPerYear);
  assert.equal(views['human-1'].history.length, 1);
  assert.equal(views['human-1'].lineup.length, 3);
  assert.ok(Array.isArray(views['human-1'].standings));
  assert.equal('treasury' in views['human-1'].opponents.find(({ id }) => id === 'human-2'), false);
  assert.equal(JSON.stringify(views['human-1']).includes(`\"treasury\":${created.state.players[1].treasury}`), false);

  const nextMeta = appendMatchHistory(created.meta, created.state, [{
    type: 'incomeResolved',
    players: {
      'human-1': { tuition: 10, upkeep: 8, treasury: 52 },
      'human-2': { tuition: 9, upkeep: 7, treasury: 123.45 },
    },
  }]);
  const nextView = matchViews(created.state, nextMeta, content)['human-1'];
  assert.equal(JSON.stringify(nextView).includes('123.45'), false);
  assert.deepEqual(nextView.history.at(-1).events[0].players, {
    'human-1': { tuition: 10, upkeep: 8, treasury: 52 },
  });

  assert.equal('finalScores' in nextView, false);
  created.state.finished = true;
  created.state.phase = 'complete';
  created.state.winnerId = 'human-1';
  const finalView = matchViews(created.state, created.meta, content)['human-1'];
  assert.deepEqual(Object.keys(finalView.finalScores).sort(), created.state.players.map(({ id }) => id).sort());
  assert.ok(Object.values(finalView.finalScores).every(Number.isFinite));
});

test('a term waits for every active human allocation before resolving', () => {
  const created = createMatchRuntime({ seed: 42, members }, content);
  const started = startMatchRound(created.state, created.meta, 'human-1', content);

  const first = validateHumanAllocation(started.state, created.meta, 'human-1', [], content);
  assert.deepEqual(first, []);
  assert.throws(() => resolveMatchAllocation(started.state, created.meta, new Map([
    ['human-1', first],
  ]), content), /waiting for Safety State/i);

  const resolved = resolveMatchAllocation(started.state, created.meta, new Map([
    ['human-1', first],
    ['human-2', validateHumanAllocation(started.state, created.meta, 'human-2', [], content)],
  ]), content);
  assert.ok(['ready', 'pending'].includes(resolved.state.phase));
  assert.ok(resolved.events.some(({ type }) => type === 'actionsResolved'));
});

test('multiplayer commands reject outsiders and duplicate action types', () => {
  const created = createMatchRuntime({ seed: 42, members }, content);
  assert.throws(() => startMatchRound(created.state, created.meta, 'outsider', content), /match member/i);

  const started = startMatchRound(created.state, created.meta, 'human-1', content);
  const choices = matchViews(started.state, created.meta, content)['human-1'].legal.actions
    .filter(({ action }) => action.type === 'upgrade').slice(0, 2).map(({ action }) => action);
  assert.throws(
    () => validateHumanAllocation(started.state, created.meta, 'human-1', choices, content),
    /one upgrade action/i,
  );
});

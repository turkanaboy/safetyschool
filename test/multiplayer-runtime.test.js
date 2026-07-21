import assert from 'node:assert/strict';
import test from 'node:test';

import { loadContent } from '../engine/content-node.js';
import {
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
  assert.equal('treasury' in views['human-1'].opponents.find(({ id }) => id === 'human-2'), false);
  assert.equal(JSON.stringify(views['human-1']).includes(`\"treasury\":${created.state.players[1].treasury}`), false);
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

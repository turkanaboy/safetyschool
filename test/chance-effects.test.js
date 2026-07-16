import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalStringify, loadContent } from '../engine/content.js';
import { advanceGame, createGame } from '../engine/index.js';
import { nextRng } from '../engine/rng.js';

const content = loadContent();
const setup = (count) => Array.from({ length: count }, (_, seat) => ({
  id: `p${seat + 1}`,
  name: `University ${seat + 1}`,
  upgrades: { admissions: 2, studentAffairs: 1 },
}));
const allocations = (count, first = []) => Object.fromEntries(Array.from({ length: count }, (_, seat) => [`p${seat + 1}`, seat === 0 ? first : []]));

function game({ seed = 31, count = 2, programsEnabled = true } = {}) {
  const result = createGame({ seed, players: setup(count), programsEnabled }, content);
  force(result.state, 'headline', 'H06');
  return result.state;
}

function force(state, deck, ...ids) {
  state.decks[deck].draw = [...ids, ...state.decks[deck].draw.filter((id) => !ids.includes(id))];
}

function play(state, firstActions = []) {
  return advanceGame(state, { type: 'round', allocations: allocations(state.players.length, firstActions) }, content);
}

function resolveAll(result, chooser = (pending) => pending.type === 'adminCrisis'
  ? { choice: 'keep' }
  : { department: pending.choices[0] }) {
  let current = result;
  let guard = 0;
  while (current.pendingDecision) {
    guard += 1;
    assert.ok(guard < 30, 'decision loop did not terminate');
    const pending = current.pendingDecision;
    current = advanceGame(current.state, {
      type: 'decision',
      decision: pending.type,
      playerId: pending.playerId,
      ...chooser(pending),
    }, content);
  }
  return current;
}

test('Admin Crisis decisions pause after the draw and resume without repeating RNG or effects', () => {
  const state = game();
  state.players[0].departments.administration = 5;
  force(state, 'fortune', 'F03');
  force(state, 'crisis', 'C01');
  const pending = play(state);

  assert.equal(pending.pendingDecision.type, 'adminCrisis');
  assert.equal(pending.pendingDecision.playerId, 'p1');
  assert.equal(pending.pendingDecision.cardId, 'C01');
  assert.equal(pending.pendingDecision.effectiveSeverity, 2);
  assert.equal(pending.state.rng.cursor - state.rng.cursor, 2);
  assert.ok(pending.events.findIndex((event) => event.type === 'cardResolved' && event.cardId === 'F03')
    < pending.events.findIndex((event) => event.type === 'cardAwaitingDecision' && event.cardId === 'C01'));

  const bytes = canonicalStringify(pending.state);
  assert.throws(() => advanceGame(pending.state, {
    type: 'decision', decision: 'forcedSale', playerId: 'p1', department: 'admissions',
  }, content), /expected adminCrisis/);
  assert.equal(canonicalStringify(pending.state), bytes);

  const cursor = pending.state.rng.cursor;
  const kept = advanceGame(pending.state, {
    type: 'decision', decision: 'adminCrisis', playerId: 'p1', choice: 'keep',
  }, content);
  assert.equal(kept.state.rng.cursor >= cursor, true);
  assert.ok(kept.events.some((event) => event.type === 'cardResolved' && event.cardId === 'C01'));

  const cancelState = game();
  cancelState.players[0].departments.administration = 5;
  force(cancelState, 'fortune', 'F03');
  force(cancelState, 'crisis', 'C01');
  const cancelPending = play(cancelState);
  const cancelled = advanceGame(cancelPending.state, {
    type: 'decision', decision: 'adminCrisis', playerId: 'p1', choice: 'cancel',
  }, content);
  assert.ok(cancelled.events.some((event) => event.type === 'cardCancelled' && event.cardId === 'C01'));
  assert.equal(cancelled.state.players[0].adminCancelsUsed, 1);
});

test('fixed and random cards each consume one target value and expose weighted Crisis mapping', () => {
  const fixed = game({ seed: 44 });
  force(fixed, 'fortune', 'F01');
  force(fixed, 'crisis', 'C31');
  const fixedResult = resolveAll(play(fixed));
  const fixedFortune = fixedResult.events.find((event) => event.type === 'cardResolved' && event.kind === 'fortune' && event.playerId === 'p1');
  const crisis = fixedResult.events.find((event) => event.type === 'cardResolved' && event.kind === 'crisis' && event.playerId === 'p1');
  assert.equal(fixedFortune.target, 'admissions');
  assert.equal(fixedFortune.targetRngConsumed, 1);
  assert.equal(crisis.targetRngConsumed, 1);
  assert.deepEqual(crisis.targetWeights, [1, 1, 1, 1, 1, 1]);

  const arts = game({ seed: 44 });
  arts.players[0].programs = ['artsAndSciences'];
  force(arts, 'fortune', 'F01');
  force(arts, 'crisis', 'C31');
  const artsResult = resolveAll(play(arts));
  const weighted = artsResult.events.find((event) => event.type === 'cardResolved' && event.kind === 'crisis' && event.playerId === 'p1');
  const other = artsResult.events.find((event) => event.type === 'cardResolved' && event.kind === 'crisis' && event.playerId === 'p2');
  assert.deepEqual(weighted.targetWeights, [1, 1, 2, 1, 1, 1]);
  assert.deepEqual(other.targetWeights, [1, 1, 1, 1, 1, 1]);
});

test('Athletics Great, Good, and Losing outcomes follow the configured odds', () => {
  const states = [];
  for (const wanted of [0.05, 0.2, 0.8]) {
    const state = game();
    state.round = 2;
    state.year = 1;
    state.roundOfYear = 2;
    let candidate = 0;
    while (Math.abs(nextRng({ state: candidate, cursor: state.rng.cursor }).value - wanted) > 0.002) candidate += 1;
    state.rng.state = candidate;
    force(state, 'fortune', 'F03');
    force(state, 'crisis', 'C05');
    states.push(resolveAll(play(state)));
  }
  assert.deepEqual(states.map((result) => result.events.find((event) => event.type === 'athleticsSeason' && event.playerId === 'p1').outcome), ['great', 'good', 'losing']);
  const losingCrises = states[2].events.filter((event) => event.type === 'cardResolved' && event.playerId === 'p1' && event.kind === 'crisis');
  assert.equal(losingCrises.length, 2);
  assert.equal(losingCrises[1].target, 'athletics');
});

test('same-round Fortune conversions occur before strain and enrollment elimination', () => {
  const state = game();
  state.players[0].students = 1490;
  state.players[0].departments.academics = 1;
  force(state, 'fortune', 'F01');
  force(state, 'crisis', 'C05');
  const result = resolveAll(play(state));
  const player = result.state.players[0];
  assert.ok(player.students > 1500);
  assert.equal(player.strainedRounds, 1);
  assert.equal(player.active, true);
  assert.ok(result.events.some((event) => event.type === 'strainApplied' && event.playerId === 'p1'));
});

test('all 72 player cards resolve through the closed effect dispatcher', () => {
  for (const card of content.cards.fortuneCards) {
    const state = game({ seed: 100 + Number(card.id.slice(1)) });
    force(state, 'fortune', card.id);
    force(state, 'crisis', 'C05');
    const result = resolveAll(play(state));
    assert.ok(result.events.some((event) => event.type === 'cardResolved' && event.cardId === card.id), card.id);
  }
  for (const card of content.cards.crisisCards) {
    const state = game({ seed: 200 + Number(card.id.slice(1)) });
    force(state, 'fortune', 'F03');
    force(state, 'crisis', card.id);
    const result = resolveAll(play(state));
    assert.ok(result.events.some((event) => event.type === 'cardResolved' && event.cardId === card.id), card.id);
  }
});

test('forced sales repeat through explicit matching decisions until solvent or eliminated', () => {
  const state = game();
  state.players[0].treasury = -100;
  force(state, 'fortune', 'F03');
  force(state, 'crisis', 'C05');
  let result = play(state);
  assert.equal(result.pendingDecision.type, 'forcedSale');
  const first = result.pendingDecision;
  const bytes = canonicalStringify(result.state);
  assert.throws(() => advanceGame(result.state, {
    type: 'decision', decision: 'forcedSale', playerId: 'p2', department: first.choices[0],
  }, content), /playerId/);
  assert.equal(canonicalStringify(result.state), bytes);
  result = resolveAll(result);
  assert.equal(result.state.players[0].active, false);
  assert.ok(Object.values(result.state.players[0].departments).every((level) => level === 1));
  assert.ok(result.events.some((event) => event.type === 'playersEliminated' && event.playerIds.includes('p1')));
});

test('voluntary sales affect later card scaling and a race reward has one priority winner', () => {
  const sold = game();
  force(sold, 'fortune', 'F01');
  force(sold, 'crisis', 'C05');
  const soldResult = resolveAll(play(sold, [{ type: 'sell', department: 'admissions' }]));
  const soldCard = soldResult.events.find((event) => event.type === 'cardResolved' && event.cardId === 'F01' && event.playerId === 'p1');
  assert.equal(soldCard.targetLevel, 2);

  const race = game();
  race.disruptions.active = 'D07';
  race.players.forEach((player) => { player.reputation = 65; });
  const before = race.players.map((player) => player.students);
  const raceResult = resolveAll(play(race));
  assert.ok(raceResult.events.some((event) => event.type === 'raceReward' && event.playerId === 'p1'));
  assert.ok(raceResult.state.players[0].students - before[0] >= 600);
  assert.equal(raceResult.state.disruptions.claimedRaceRewards.length, 1);
});

test('program riders are deterministic no-ops when programs are disabled', () => {
  const state = game({ programsEnabled: false });
  state.players[0].programs = ['education'];
  force(state, 'fortune', 'F05');
  force(state, 'crisis', 'C05');
  const result = resolveAll(play(state));
  const card = result.events.find((event) => event.type === 'cardResolved' && event.cardId === 'F05' && event.playerId === 'p1');
  assert.ok(card.skippedEffects.includes('programRider'));
});

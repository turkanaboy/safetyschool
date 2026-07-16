import assert from 'node:assert/strict';
import test from 'node:test';

import { loadContent } from '../engine/content.js';
import { advanceGame, createGame, healthScore } from '../engine/index.js';

const content = loadContent();
const setup = (count) => Array.from({ length: count }, (_, seat) => ({
  id: `p${seat + 1}`,
  name: `University ${seat + 1}`,
  upgrades: { admissions: 2, studentAffairs: 1 },
}));

function force(state, deck, ...ids) {
  state.decks[deck].draw = [...ids, ...state.decks[deck].draw.filter((id) => !ids.includes(id))];
}

function game(count = 2, seed = 500) {
  const { state } = createGame({ seed, players: setup(count), programsEnabled: true }, content);
  force(state, 'headline', 'H06');
  force(state, 'fortune', 'F06', 'F07', 'F10', 'F29', 'F30');
  force(state, 'crisis', 'C05', 'C06', 'C07', 'C15', 'C26');
  return state;
}

function play(state) {
  let result = advanceGame(state, {
    type: 'round',
    allocations: Object.fromEntries(state.players.filter((player) => player.active).map((player) => [player.id, []])),
  }, content);
  const events = [...result.events];
  let guard = 0;
  while (result.pendingDecision) {
    guard += 1;
    assert.ok(guard < 30);
    const pending = result.pendingDecision;
    result = advanceGame(result.state, {
      type: 'decision',
      decision: pending.type,
      playerId: pending.playerId,
      ...(pending.type === 'adminCrisis' ? { choice: 'keep' } : { department: pending.choices[0] }),
    }, content);
    events.push(...result.events);
  }
  return { ...result, events };
}

function prepareYearEnd(state, year = 1) {
  state.round = year * content.config.gameLength.roundsPerYear - 1;
  state.year = year;
  state.roundOfYear = content.config.gameLength.yearEndRound - 1;
  state.players.forEach((player) => { player.treasury = 200; });
  return state;
}

test('graduation and attrition use floor boundaries and cap retention before strain', () => {
  const state = prepareYearEnd(game());
  const player = state.players[0];
  player.students = 4000;
  player.reputation = 0;
  player.departments.academics = 3;
  player.departments.studentAffairs = 2;
  player.effects.retentionDeltaThisYear = 0.2;
  player.strainedRounds = 2;
  const result = play(state);
  const graduation = result.events.find((event) => event.type === 'graduationResolved' && event.playerId === 'p1');
  const attrition = result.events.find((event) => event.type === 'attritionResolved' && event.playerId === 'p1');
  assert.equal(graduation.seniors, Math.floor(graduation.studentsBefore * 0.25));
  assert.equal(graduation.graduates, Math.floor(graduation.seniors * (0.35 + 0.08 * 3)));
  assert.equal(attrition.retention, 0.92 - 2 * 0.006);
  assert.equal(attrition.studentsAfter, Math.floor(attrition.studentsBefore * attrition.retention));
});

test('donations include Academics and Engineering while grants stay outside multipliers', () => {
  const state = prepareYearEnd(game());
  const player = state.players[0];
  player.alumni = 10000;
  player.departments.academics = 3;
  player.departments.administration = 4;
  player.programs = ['engineering', 'publicAffairs'];
  player.effects.donationMultiplierThisYearEnd = 1.5;
  state.disruptions.active = 'D12';
  const result = play(state);
  const donation = result.events.find((event) => event.type === 'donationsResolved' && event.playerId === 'p1');
  const expectedDonation = donation.alumni * (0.001 * 3 + 0.0005) * 1.5 * 2;
  assert.equal(donation.donations, expectedDonation);
  assert.equal(donation.grants, 0.5 * 4);
  assert.equal(donation.total, expectedDonation + donation.grants);
});

test('disruption public and Admin-private reveals advance without repeats or RNG', () => {
  const state = prepareYearEnd(game());
  state.players[0].departments.administration = 3;
  const year2Card = state.disruptions.revealedByYear['2'];
  const cursor = state.rng.cursor;
  const year1 = play(state);
  const year3Card = year1.state.disruptions.revealedByYear['3'];
  assert.equal(year1.state.disruptions.active, year2Card);
  assert.notEqual(year3Card, year2Card);
  assert.ok(year1.events.some((event) => event.type === 'disruptionRevealed' && event.visibility === 'public' && event.year === 2));
  assert.ok(year1.events.some((event) => event.type === 'disruptionRevealed' && event.visibility === 'private' && event.year === 3 && event.playerIds.includes('p1')));
  const chanceDraws = 4;
  assert.equal(year1.state.lastSnapshot.cursor - cursor, chanceDraws);

  const year2State = prepareYearEnd(year1.state, 2);
  year2State.players.forEach((player) => { player.treasury = 200; });
  force(year2State, 'headline', 'H06');
  const year2 = play(year2State);
  const ids = Object.values(year2.state.disruptions.revealedByYear);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(year2.events.some((event) => event.type === 'disruptionRevealed' && event.visibility === 'public' && event.year === 3));
});

test('the lowest eligible treasury receives the safety net once with priority tie-breaking', () => {
  const state = prepareYearEnd(game());
  state.players.forEach((player) => {
    player.treasury = 0;
    player.departments = Object.fromEntries(Object.keys(player.departments).map((department) => [department, 1]));
  });
  const first = play(state);
  const appropriation = first.events.find((event) => event.type === 'safetyNetAwarded');
  assert.equal(appropriation.playerId, 'p2');
  assert.equal(first.state.players[1].usedSafetyNet, true);

  const next = prepareYearEnd(first.state, 2);
  next.players.forEach((player) => { player.treasury = 0; });
  force(next, 'headline', 'H06');
  const second = play(next);
  assert.equal(second.events.find((event) => event.type === 'safetyNetAwarded').playerId, 'p1');
});

test('simultaneous casualties never inherit and survivors receive floored reputation shares', () => {
  const state = game(3);
  state.players[0].students = 900;
  state.players[1].students = 900;
  state.players[0].reputation = 0;
  state.players[1].reputation = 0;
  state.players[2].students = 5000;
  state.players[2].reputation = 60;
  const result = play(state);
  const elimination = result.events.find((event) => event.type === 'playersEliminated');
  assert.deepEqual(elimination.playerIds, ['p1', 'p2']);
  assert.equal(elimination.inheritancePool, 900);
  assert.equal(elimination.inheritances.p3, 900);
  assert.equal(result.state.players[2].students >= 5900, true);
  assert.equal(result.state.winnerId, 'p3');
  assert.equal(result.state.finished, true);
});

test('zero survivors use casualty Health Scores and post-year-end drops are eliminated', () => {
  const zero = game();
  zero.players.forEach((player) => {
    player.students = 900;
    player.reputation = 0;
  });
  zero.players[0].treasury = 100;
  zero.players[1].treasury = 10;
  const zeroResult = play(zero);
  assert.equal(zeroResult.state.finished, true);
  assert.equal(zeroResult.state.winnerId, 'p1');
  assert.equal(zeroResult.state.endReason, 'simultaneousElimination');

  const yearEnd = prepareYearEnd(game());
  yearEnd.players[0].students = 1100;
  yearEnd.players[0].reputation = 0;
  yearEnd.players[0].departments.studentAffairs = 1;
  const yearEndResult = play(yearEnd);
  assert.ok(yearEndResult.events.some((event) => event.type === 'playersEliminated' && event.stage === 'postYearEnd' && event.playerIds.includes('p1')));
});

test('standings precede year-end and the persisted snapshot contains the complete transaction', () => {
  const result = play(prepareYearEnd(game()));
  const standingsIndex = result.events.findIndex((event) => event.type === 'standingsPublished');
  const graduationIndex = result.events.findIndex((event) => event.type === 'graduationResolved');
  const snapshotIndex = result.events.findIndex((event) => event.type === 'roundSnapshot');
  assert.ok(standingsIndex >= 0 && standingsIndex < graduationIndex && graduationIndex < snapshotIndex);
  const snapshot = result.events[snapshotIndex];
  assert.equal(snapshot.bytes, result.state.lastSnapshot.bytes);
  assert.equal(snapshot.cursor, result.state.rng.cursor);
  const payload = JSON.parse(snapshot.bytes);
  assert.equal(payload.round, 5);
  assert.equal(payload.players[0].strainedRounds, 0);
  assert.equal(payload.lastSnapshot, undefined);
});

test('Year 6 scores survivors, counts programs, and never permits round 31', () => {
  const state = prepareYearEnd(game(), 6);
  state.players[0].programs = ['nursing'];
  state.players.forEach((player) => {
    player.treasury = 200;
    player.students = 5000;
    player.reputation = 50;
    player.alumni = 2000;
  });
  const result = play(state);
  assert.equal(result.state.round, 30);
  assert.equal(result.state.finished, true);
  assert.equal(result.state.winnerId, 'p1');
  assert.equal(result.state.endReason, 'year6HealthScore');
  assert.ok(healthScore(result.state.players[0], content.config) > healthScore(result.state.players[1], content.config));
  assert.throws(() => play(result.state), /game is already complete/);
});

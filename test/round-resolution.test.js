import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { canonicalStringify, validateContent } from '../engine/content.js';
import { loadContent } from '../engine/content-node.js';
import { advanceGame, createGame } from '../engine/index.js';

const content = loadContent();
const rawConfig = JSON.parse(readFileSync(new URL('../balance-config.json', import.meta.url)));
const rawCards = JSON.parse(readFileSync(new URL('../cards.json', import.meta.url)));
const setup = (count, upgrades = { admissions: 2, studentAffairs: 1 }) => Array.from({ length: count }, (_, seat) => ({
  id: `p${seat + 1}`,
  name: `University ${seat + 1}`,
  upgrades: structuredClone(upgrades),
}));

function game(count = 2, options = {}) {
  const loaded = options.content ?? content;
  const created = createGame({
    seed: options.seed ?? 7,
    players: setup(count, options.upgrades),
    programsEnabled: options.programsEnabled ?? true,
  }, loaded);
  created.state.decks.headline.draw = ['H06', ...created.state.decks.headline.draw.filter((id) => id !== 'H06')];
  return { state: created.state, content: loaded };
}

const allocations = (...entries) => Object.fromEntries(entries.map((actions, index) => [`p${index + 1}`, actions]));
const round = (state, contentForGame, playerActions) => advanceGame(state, { type: 'round', allocations: playerActions }, contentForGame);

test('invalid allocation commands reject without mutating the prior state', () => {
  const cases = [
    allocations([{ type: 'bank' }, { type: 'campaign', spend: 1 }, { type: 'upgrade', department: 'marketing' }], []),
    allocations([{ type: 'campaign', spend: 1 }, { type: 'campaign', spend: 1 }], []),
    allocations([{ type: 'upgrade', department: 'admissions' }], []),
  ];

  for (const playerActions of cases) {
    const { state } = game();
    const before = canonicalStringify(state);
    assert.throws(() => round(state, content, playerActions), /allocations\.p1/);
    assert.equal(canonicalStringify(state), before);
  }

  const { state: maxed } = game();
  maxed.players[0].departments.marketing = 5;
  const before = canonicalStringify(maxed);
  assert.throws(() => round(maxed, content, allocations([{ type: 'upgrade', department: 'marketing' }], [])), /maximum level/);
  assert.equal(canonicalStringify(maxed), before);
});

test('zero actions bank and sale proceeds cannot fund committed spend', () => {
  const { state } = game();
  state.players[0].treasury = 0;
  state.players[0].students = 0;
  const before = canonicalStringify(state);
  assert.throws(() => round(state, content, allocations([
    { type: 'sell', department: 'admissions' },
    { type: 'upgrade', department: 'marketing' },
  ], [])), /committed spend/);
  assert.equal(canonicalStringify(state), before);

  state.players[0].treasury = 20;
  const result = round(state, content, allocations([{ type: 'sell', department: 'admissions' }], []));
  const actionEvent = result.events.find((event) => event.type === 'actionsResolved');
  assert.ok(actionEvent.actions.some((action) => action.playerId === 'p1' && action.type === 'sell'));
  assert.ok(actionEvent.actions.some((action) => action.playerId === 'p2' && action.type === 'bank'));
  assert.equal(result.state.players[0].departments.admissions, 2);
});

test('austerity honors a configured department floor above level one', () => {
  const config = structuredClone(rawConfig);
  config._meta.version = 'test-floor-2';
  config.startingState.allDepartmentsLevel = 2;
  const floorContent = validateContent(config, rawCards);
  const { state } = game(2, { content: floorContent });
  state.players[0].treasury = -100;
  state.players[0].departments = Object.fromEntries(
    Object.keys(state.players[0].departments).map((department) => [department, 2]),
  );

  const result = round(state, floorContent, allocations([], []));
  assert.equal(result.pendingDecision, null);
  assert.equal(result.state.players[0].active, false);
  assert.ok(Object.values(result.state.players[0].departments).every((level) => level === 2));
});

test('program slots use commit-time Academics while valid openings recruit immediately', () => {
  const { state } = game(2, { upgrades: { academics: 1, admissions: 2 } });
  state.players[0].programs = ['education'];
  assert.throws(() => round(state, content, allocations([
    { type: 'upgrade', department: 'academics' },
    { type: 'openProgram', program: 'nursing' },
  ], [])), /program slot/);

  state.players[0].programs = [];
  const result = round(state, content, allocations([{ type: 'openProgram', program: 'nursing' }], []));
  const recruiting = result.events.find((event) => event.type === 'recruitingResolved');
  assert.ok(result.state.players[0].programs.includes('nursing'));
  assert.ok(recruiting.players.p1.classes.nursing.conversions > 0);
});

test('poaches resolve independently against an eligible target', () => {
  const { state } = game(3);
  state.players[2].yearLosses = 400;
  const result = round(state, content, allocations(
    [{ type: 'poach', targetPlayerId: 'p3' }],
    [{ type: 'poach', targetPlayerId: 'p3' }],
    [],
  ));
  const actions = result.events.find((event) => event.type === 'actionsResolved').actions;
  assert.equal(actions.filter((action) => action.type === 'poach' && action.students === 20).length, 2);

  const { state: ineligible } = game(3);
  assert.throws(() => round(ineligible, content, allocations([{ type: 'poach', targetPlayerId: 'p3' }], [], [])), /target is not eligible/);
});

test('shared recruiting pool scales proportionally and guards zero pull', () => {
  const { state } = game(5);
  state.players.forEach((player) => {
    player.reputation = 100;
    player.departments.admissions = 5;
  });
  const result = round(state, content, allocations([], [], [], [], []));
  const event = result.events.find((entry) => entry.type === 'recruitingResolved');
  assert.ok(event.scale < 1);
  assert.equal(event.players.p1.scale, event.players.p2.scale);

  const { state: zero } = game();
  zero.players.forEach((player) => { player.reputation = 0; });
  const zeroResult = round(zero, content, allocations([], []));
  const zeroEvent = zeroResult.events.find((entry) => entry.type === 'recruitingResolved');
  assert.equal(zeroEvent.scalablePull, 0);
  assert.equal(zeroEvent.scale, 1);
});

test('Nursing reserves pull off the top even when it exhausts the allotment', () => {
  const config = structuredClone(rawConfig);
  config.programs.catalog.nursing.pullPerRound = 7000;
  const nursingContent = validateContent(config, rawCards);
  const { state } = game(2, { content: nursingContent });
  state.players[0].programs = ['nursing'];
  const result = round(state, nursingContent, allocations([], []));
  const event = result.events.find((entry) => entry.type === 'recruitingResolved');
  assert.equal(event.remainingAllotment, 0);
  assert.equal(event.players.p1.classes.nursing.conversions, 7000);
  assert.equal(event.players.p2.totalConversions, 0);
});

test('campaigns alone consume yield RNG and use the Admissions floor', () => {
  const { state } = game(3, { seed: 99 });
  state.players[0].departments.admissions = 5;
  const before = state.rng.cursor;
  const result = round(state, content, allocations([{ type: 'campaign', spend: 1 }], [], []));
  const event = result.events.find((entry) => entry.type === 'recruitingResolved');
  assert.equal(event.cursorAfter - before, 1);
  assert.ok(event.players.p1.classes.campaign.yield >= 0.65);
  assert.equal(event.players.p2.classes.campaign, undefined);
});

test('headlines are current-round only and programs-disabled rejects openings', () => {
  const { state } = game();
  state.decks.headline.draw = ['H01', 'H06', ...state.decks.headline.draw.filter((id) => !['H01', 'H06'].includes(id))];
  const first = round(state, content, allocations([], []));
  const second = round(first.state, content, allocations([], []));
  assert.equal(first.events.find((event) => event.type === 'headlineRevealed').cardId, 'H01');
  assert.equal(second.events.find((event) => event.type === 'headlineRevealed').cardId, 'H06');
  assert.equal(second.state.headline, 'H06');

  const disabled = game(2, { programsEnabled: false });
  assert.throws(() => round(disabled.state, disabled.content, allocations([{ type: 'openProgram', program: 'nursing' }], [])), /programs are disabled/);
});

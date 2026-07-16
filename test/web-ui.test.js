import assert from 'node:assert/strict';
import test from 'node:test';

import { loadContent } from '../engine/content-node.js';
import {
  allocationSummary,
  buildingManagement,
  createSoloController,
  createSoloSession,
  dumpRankings,
  programManagement,
  rivalProfile,
} from '../web/game.js';

const content = loadContent();
const human = {
  id: 'human',
  name: 'Founders Green',
  mascot: 'owl',
  color: 'pine',
  upgrades: { academics: 2, admissions: 1 },
};

function controller(seed = 211) {
  return createSoloController({
    session: createSoloSession({
      seed,
      human,
      rivalIds: ['northbridge', 'saint-cadmus', 'westlake'],
    }, content),
    content,
  });
}

test('building management derives costs, upkeep, legal choices, and unavailable reasons', () => {
  const game = controller();
  game.startRound();
  const view = game.getView();

  const academics = buildingManagement(view, 'academics', content);
  assert.equal(academics.level, 3);
  assert.equal(academics.nextLevel, 4);
  assert.equal(academics.upgrade.cost, 14);
  assert.equal(academics.baseUpkeepChange, 3);
  assert.equal(academics.upgradeReason, null);

  const admissions = buildingManagement(view, 'admissions', content);
  assert.equal(admissions.upgrade, null);
  assert.match(admissions.upgradeReason, /Term 5/);

  const maxedSession = createSoloSession({
    seed: 212,
    human,
    rivalIds: ['northbridge', 'saint-cadmus', 'westlake'],
  }, content);
  maxedSession.state.players[0].departments.academics = 5;
  const maxed = buildingManagement(createSoloController({ session: maxedSession, content }).getView(), 'academics', content);
  assert.equal(maxed.nextLevel, null);
  assert.match(maxed.upgradeReason, /fully developed/i);
});

test('allocation summary keeps staged actions provisional and separates spend from sale recovery', () => {
  const game = controller(213);
  game.startRound();
  const initial = game.getView();
  const upgrade = initial.legal.actions.find((option) => option.action.type === 'upgrade' && option.action.department === 'academics');
  const program = initial.legal.actions.find((option) => option.action.type === 'openProgram');
  game.stageAction(0, upgrade.action);
  game.stageAction(1, program.action);

  const view = game.getView();
  const summary = allocationSummary(view, content);
  assert.equal(summary.maxActions, 2);
  assert.equal(summary.bonusSlots, 0);
  assert.equal(summary.committedSpend, upgrade.cost + program.cost);
  assert.equal(summary.saleRecovery, 0);
  assert.equal(summary.projectedTreasury, view.own.treasury - summary.committedSpend);
  assert.equal(summary.slots[0].action.type, 'upgrade');
  assert.equal(summary.slots[1].action.type, 'openProgram');
});

test('Programs uses committed Academics slots, not a same-term staged upgrade', () => {
  const game = controller(214);
  game.startRound();
  const before = programManagement(game.getView(), content);
  const upgrade = game.getView().legal.actions.find((option) => option.action.type === 'upgrade' && option.action.department === 'academics');
  game.stageAction(0, upgrade.action);
  const after = programManagement(game.getView(), content);

  assert.equal(before.slotCount, 2);
  assert.equal(after.slotCount, before.slotCount);
  assert.equal(after.openSlots, before.openSlots);
  assert.ok(after.available.every((option) => option.action.type === 'openProgram'));
});

test('rival profiles contain public development and history without raw treasury or policy seed', () => {
  const game = controller(215);
  game.startRound();
  game.confirmAllocation();
  const view = game.getView();
  const profile = rivalProfile(view, 'northbridge');
  const text = JSON.stringify(profile);

  assert.equal(profile.id, 'northbridge');
  assert.ok(profile.departments.academics >= 1);
  assert.equal(typeof profile.treasuryBand, 'string');
  assert.equal(Object.hasOwn(profile, 'treasury'), false);
  assert.equal(text.includes('agentSeed'), false);
  assert.equal(text.includes('roundSnapshot'), false);
});

test('DUMP ranks only published public factors, shares exact ties, and ignores treasury', () => {
  const standings = [
    { playerId: 'human', active: true, students: 8000, reputation: 50, treasuryBand: 'Stable', treasury: 999, departments: { academics: 2, administration: 2, admissions: 2, athletics: 2, marketing: 2, studentAffairs: 2 }, programs: [], alumni: 10000 },
    { playerId: 'northbridge', active: true, students: 8000, reputation: 50, treasuryBand: 'Strained', treasury: -999, departments: { academics: 2, administration: 2, admissions: 2, athletics: 2, marketing: 2, studentAffairs: 2 }, programs: [], alumni: 10000 },
    { playerId: 'saint-cadmus', active: false, students: 12000, reputation: 90, treasuryBand: 'Strong', departments: { academics: 5, administration: 5, admissions: 5, athletics: 5, marketing: 5, studentAffairs: 5 }, programs: ['nursing'], alumni: 20000 },
  ];
  const ranked = dumpRankings({
    own: { id: 'human', name: 'Founders Green' },
    opponents: [{ id: 'northbridge', name: 'Northbridge' }, { id: 'saint-cadmus', name: 'Saint Cadmus' }],
    standings,
  });

  assert.deepEqual(ranked.map((school) => school.rank), [1, 1, null]);
  assert.equal(ranked[0].score, ranked[1].score);
  assert.equal(ranked[2].closed, true);
});

test('contextual guidance is persisted through the controller without changing engine state', () => {
  let saves = 0;
  const session = createSoloSession({
    seed: 216,
    human,
    rivalIds: ['northbridge', 'saint-cadmus', 'westlake'],
  }, content);
  const stateBefore = JSON.stringify(session.state);
  const game = createSoloController({ session, content, onTransition: () => { saves += 1; } });
  game.dismissTutorial('allocation');
  game.dismissTutorial('allocation');

  assert.equal(game.getView().tutorial.allocationDismissed, true);
  assert.equal(JSON.stringify(game.getSession().state), stateBefore);
  assert.equal(saves, 1);
});

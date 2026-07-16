import assert from 'node:assert/strict';
import test from 'node:test';

import { loadContent } from '../engine/content-node.js';
import {
  annualReport,
  boardBook,
  emergencySaleOptions,
  finalIssue,
  presentationRecords,
} from '../web/presentation.js';

const content = loadContent();

test('player card presentation explains scaling and skipped riders without mutating events', () => {
  const events = [{
    type: 'cardResolved',
    kind: 'fortune',
    cardId: 'F05',
    playerId: 'human',
    target: 'admissions',
    targetLevel: 3,
    effectiveSeverity: 3,
    factor: 4 / 3,
    skippedEffects: ['programRider'],
  }];
  const before = structuredClone(events);
  const records = presentationRecords(events, { humanId: 'human', content });
  const card = records.queue.find((record) => record.kind === 'playerCard');

  assert.equal(card.title, '60 Minutes Profiles Your Access Mission');
  assert.equal(card.targetLevel, 3);
  assert.equal(card.targetFactor, 4 / 3);
  assert.ok(Math.abs(card.effects.find((effect) => effect.type === 'reputation').result - 20 / 3) < 1e-12);
  assert.equal(card.effects.find((effect) => effect.type === 'programRider').skipped, true);
  assert.deepEqual(events, before);
});

test('routine rival cards stay in the feed while severe cards and closures stage once', () => {
  const records = presentationRecords([
    { type: 'cardResolved', kind: 'fortune', cardId: 'F03', playerId: 'northbridge', target: 'admissions', targetLevel: 2, effectiveSeverity: 1, factor: 1 },
    { type: 'cardResolved', kind: 'fortune', cardId: 'F05', playerId: 'northbridge', target: 'admissions', targetLevel: 3, effectiveSeverity: 3, factor: 4 / 3 },
    { type: 'forcedSale', playerId: 'northbridge', department: 'marketing', recovery: 2 },
    { type: 'forcedSale', playerId: 'northbridge', department: 'athletics', recovery: 3 },
    { type: 'playersEliminated', playerIds: ['westlake'], stage: 'round' },
  ], { humanId: 'human', content });

  assert.equal(records.feed.filter((record) => record.kind === 'rivalCard').length, 2);
  assert.equal(records.queue.filter((record) => record.kind === 'rivalCard').length, 1);
  assert.equal(records.queue.filter((record) => record.kind === 'rivalAusterity').length, 1);
  assert.equal(records.queue.filter((record) => record.kind === 'closure').length, 1);
});

test('annual report reconciles the player year and only entitled disruption reveals', () => {
  const view = {
    own: { id: 'human', name: 'Founders Green', students: 5100, reputation: 54, treasury: 22, alumni: 900 },
    history: [
      { round: 1, events: [{ type: 'incomeResolved', players: { human: { tuition: 9, upkeep: 4, treasury: 25 } } }, { type: 'recruitingResolved', players: { human: { converted: 220 } } }] },
      { round: 5, events: [
        { type: 'graduationResolved', playerId: 'human', studentsBefore: 5500, seniors: 1100, graduationRate: 0.7, graduates: 770, studentsAfter: 4730 },
        { type: 'donationsResolved', playerId: 'human', donations: 2.5, grants: 1, total: 3.5, alumni: 900 },
        { type: 'disruptionRevealed', visibility: 'public', cardId: 'D02', year: 2 },
        { type: 'disruptionRevealed', visibility: 'private', cardId: 'D03', year: 3 },
      ] },
    ],
    standings: [{ playerId: 'human', active: true, students: 5500, reputation: 54, treasuryBand: 'Stable', departments: {}, programs: [], alumni: 130 }],
  };
  const report = annualReport(view, content, 1);

  assert.equal(report.recruiting, 220);
  assert.equal(report.graduates, 770);
  assert.equal(report.donations, 3.5);
  assert.equal(report.nextDisruption.title, "State Budget 'Realignment'");
  assert.equal(report.privateLookahead.title, 'Rankings Methodology Overhaul');
  assert.equal(JSON.stringify(report).includes('northbridge'), false);
});

test('emergency choices expose recovery, upkeep relief, and the shared reputation penalty', () => {
  const view = {
    legal: { kind: 'decision', commands: [
      { type: 'decision', decision: 'forcedSale', playerId: 'human', department: 'marketing', recovery: 4, upkeepSaved: 1.5 },
    ] },
    pendingDecision: { type: 'forcedSale', playerId: 'human', choices: ['marketing'] },
  };
  const options = emergencySaleOptions(view, content);

  assert.deepEqual(options[0], {
    command: view.legal.commands[0],
    department: 'marketing',
    recovery: 4,
    upkeepSaved: 1.5,
    reputationLost: content.config.insolvencyAndElimination.forcedFireSaleReputationPenalty,
  });
});

test('the final issue follows the engine winner even when DUMP favors another school', () => {
  const view = {
    winnerId: 'human',
    own: { id: 'human', name: 'Founders Green' },
    opponents: [{ id: 'northbridge', name: 'Northbridge University', treasuryBand: 'Flush' }],
    standings: [
      { playerId: 'human', active: true, students: 4500, reputation: 45, treasuryBand: 'Stable', departments: { academics: 3 }, programs: [], alumni: 1200 },
      { playerId: 'northbridge', active: true, students: 9000, reputation: 80, treasuryBand: 'Flush', departments: { academics: 5 }, programs: ['engineering'], alumni: 2000 },
    ],
    history: [{ round: 30, events: [{ type: 'gameFinished', winnerId: 'human', reason: 'year6HealthScore', round: 30 }] }],
  };
  const issue = finalIssue(view);
  const serialized = JSON.stringify(issue);

  assert.equal(issue.winnerId, 'human');
  assert.equal(issue.winnerName, 'Founders Green');
  assert.match(issue.explanation, /engine result/i);
  assert.equal(serialized.includes('healthScore'), false);
  assert.equal(serialized.includes('treasury":'), false);
  assert.equal(serialized.includes('Flush'), false);
  assert.equal(serialized.includes('Stable'), true);
});

test('Board Book rebuilds named cards, annual reports, and public trends without rival secrets', () => {
  const view = {
    year: 1,
    own: { id: 'human', name: 'Founders Green', students: 5100, reputation: 54, treasury: 22, alumni: 900 },
    opponents: [{ id: 'northbridge', name: 'Northbridge University', treasuryBand: 'Flush' }],
    history: [{ round: 5, own: { treasury: 18, students: 4200, reputation: 51, alumni: 800 }, events: [
      { type: 'cardResolved', kind: 'fortune', cardId: 'F03', playerId: 'human', target: 'admissions', targetLevel: 2, effectiveSeverity: 1, factor: 1, skippedEffects: [] },
      { type: 'cardResolved', kind: 'crisis', cardId: 'C01', playerId: 'northbridge', target: 'academics', targetLevel: 2, effectiveSeverity: 1, factor: 0.8 },
      { type: 'graduationResolved', playerId: 'human', studentsBefore: 5000, graduates: 700, studentsAfter: 4200 },
      { type: 'standingsPublished', players: [
        { playerId: 'human', active: true, students: 5000, reputation: 54, treasuryBand: 'Stable', departments: { academics: 3 }, programs: [], alumni: 900 },
        { playerId: 'northbridge', active: true, students: 7000, reputation: 60, treasuryBand: 'Flush', departments: { academics: 4 }, programs: [], alumni: 1100 },
      ] },
    ] }],
    standings: [],
  };
  const book = boardBook(view, content);
  const serialized = JSON.stringify(book);

  assert.equal(book.cards[0].title, 'Legacy Family Reunion');
  assert.equal(book.cards[1].title.length > 0, true);
  assert.equal(book.reports.length, 1);
  assert.equal(book.reports[0].endingTreasury, 18);
  assert.equal(book.trends[0].ownRank, 2);
  assert.equal(serialized.includes('treasury":'), false);
  assert.equal(serialized.includes('targetWeights'), false);
});

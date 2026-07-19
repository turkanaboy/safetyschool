import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AGENT_TYPES, POLICY_VERSION } from '../agents/index.js';
import { canonicalStringify } from '../engine/content.js';
import { loadContent } from '../engine/content-node.js';
import { ENGINE_VERSION, STATE_SCHEMA_VERSION } from '../engine/index.js';
import { REPLAY_SCHEMA_VERSION } from '../sim/replay.js';
import { buildReport, formatMarkdown } from '../sim/report.js';
import {
  aggregateResults,
  buildSchedule,
  evaluateMetrics,
  runFuzz,
  runSchedule,
  runScheduleParallel,
} from '../sim/run.js';

const content = loadContent();
const criteria = content.config.simulationAcceptanceCriteria;

test('schedule uses complete balanced cycles and identical A/B matchup exposure', () => {
  const enabled = buildSchedule({ minGames: 50, baseSeed: 123, programsEnabled: true });
  const disabled = buildSchedule({ minGames: 50, baseSeed: 123, programsEnabled: false });
  assert.equal(enabled.length, 72);
  assert.equal(enabled.length % 24, 0);
  assert.deepEqual(enabled.map(({ programsEnabled, ...game }) => game), disabled.map(({ programsEnabled, ...game }) => game));

  for (const playerCount of [2, 3, 4, 5]) {
    const subset = enabled.filter((game) => game.playerCount === playerCount);
    for (let seat = 0; seat < playerCount; seat += 1) {
      const counts = Object.fromEntries(AGENT_TYPES.map((type) => [type, 0]));
      subset.forEach((game) => { counts[game.lineup[seat]] += 1; });
      assert.equal(new Set(Object.values(counts)).size, 1);
    }
  }
});

test('schedule, fuzz, and CLI reject zero or malformed game counts', () => {
  assert.throws(() => buildSchedule({ minGames: 0, baseSeed: 1, programsEnabled: true }), /positive integer/);
  assert.throws(() => runFuzz({ games: 0, baseSeed: 1, content }), /positive integer/);

  for (const value of ['0', 'nope']) {
    const result = spawnSync(process.execPath, ['sim/run.js', '--fuzz', '--games', value], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /must be (?:an|a positive) integer/, value);
  }
});

test('tiny fixed matrices produce byte-identical game and aggregate output', () => {
  const schedule = buildSchedule({ minGames: 24, baseSeed: 456, programsEnabled: true });
  const first = runSchedule(schedule, content, { verifyReplay: false });
  const second = runSchedule(schedule, content, { verifyReplay: false });
  assert.equal(canonicalStringify(first.results), canonicalStringify(second.results));
  assert.equal(canonicalStringify(first.metrics), canonicalStringify(second.metrics));
});

test('worker execution is byte-identical to sequential execution', async () => {
  const schedule = buildSchedule({ minGames: 24, baseSeed: 654, programsEnabled: false });
  const sequential = runSchedule(schedule, content, { verifyReplay: false });
  const parallel = await runScheduleParallel(schedule, content, { verifyReplay: false, workers: 2 });
  assert.equal(canonicalStringify(parallel.results), canonicalStringify(sequential.results));
  assert.equal(canonicalStringify(parallel.metrics), canonicalStringify(sequential.metrics));
});

function passingMetrics(programsEnabled = true) {
  return {
    gameCount: criteria.monteCarloGamesMin,
    winnerShares: {
      steadyHand: 0.18,
      gambler: 0.18,
      prestigePlay: 0.18,
      fortress: 0.18,
      oracle: 0.18,
      random: criteria.randomWinnerShareMax - 0.001,
    },
    medianEndRound: criteria.medianGameEndRoundMin,
    endingBeforeRoundShare: criteria.gamesEndingBeforeRoundShareMax,
    year6TiebreakShare: criteria.gamesReachingYear6TiebreakMax,
    austerityEscapeRate: criteria.austerityEscapeRateTarget - criteria.austerityEscapeRateTolerance,
    programWinnerShares: Object.fromEntries(Object.keys(content.config.programs.catalog).map((program) => [program, criteria.winningPortfolioProgramShareMin])),
    replayRate: criteria.deterministicReplayRateMin,
    maxRound: criteria.maxGameRounds,
    programsEnabled,
  };
}

test('metric evaluator handles every configured boundary and names failures', () => {
  const atBoundary = evaluateMetrics(passingMetrics(), criteria, content.config.programs.catalog);
  assert.equal(atBoundary.pass, true);

  const cases = [
    ['winnerShare.steadyHand', (metrics) => { metrics.winnerShares.steadyHand = criteria.archetypeWinnerShareMin - 0.001; }],
    ['winnerShare.gambler', (metrics) => { metrics.winnerShares.gambler = criteria.archetypeWinnerShareMax + 0.001; }],
    ['winnerShare.random', (metrics) => { metrics.winnerShares.random = criteria.randomWinnerShareMax; }],
    ['medianEndRound', (metrics) => { metrics.medianEndRound = criteria.medianGameEndRoundMin - 1; }],
    ['endingBeforeRoundShare', (metrics) => { metrics.endingBeforeRoundShare = criteria.gamesEndingBeforeRoundShareMax + 0.001; }],
    ['year6TiebreakShare', (metrics) => { metrics.year6TiebreakShare = criteria.gamesReachingYear6TiebreakMax + 0.001; }],
    ['austerityEscapeRate', (metrics) => { metrics.austerityEscapeRate = criteria.austerityEscapeRateTarget + criteria.austerityEscapeRateTolerance + 0.001; }],
    ['programWinnerShare.nursing', (metrics) => { metrics.programWinnerShares.nursing = criteria.winningPortfolioProgramShareMax + 0.001; }],
    ['replayRate', (metrics) => { metrics.replayRate = criteria.deterministicReplayRateMin - 0.001; }],
    ['maxRound', (metrics) => { metrics.maxRound = criteria.maxGameRounds + 1; }],
    ['gameCount', (metrics) => { metrics.gameCount = criteria.monteCarloGamesMin - 1; }],
  ];
  for (const [name, mutate] of cases) {
    const metrics = passingMetrics();
    mutate(metrics);
    const evaluation = evaluateMetrics(metrics, criteria, content.config.programs.catalog);
    assert.equal(evaluation.pass, false, name);
    assert.ok(evaluation.checks.some((check) => check.name === name && !check.pass), name);
  }

  assert.equal(evaluateMetrics(passingMetrics(false), criteria, content.config.programs.catalog).checks.some((check) => check.name.startsWith('programWinnerShare.')), false);
});

test('aggregation, reports, and small Random fuzz disclose required evidence', () => {
  const results = [
    { winnerType: 'steadyHand', round: 20, endReason: 'soleSurvivor', winnerPrograms: ['nursing'], austerityEntrants: 1, austeritySurvivors: 1, replayOk: true },
    { winnerType: 'gambler', round: 30, endReason: 'year6HealthScore', winnerPrograms: ['business'], austerityEntrants: 1, austeritySurvivors: 0, replayOk: true },
  ];
  const metrics = aggregateResults(results, true, content.config);
  assert.equal(metrics.medianEndRound, 25);
  assert.equal(metrics.austerityEscapeRate, 0.5);
  const report = buildReport({
    branches: [{ programsEnabled: true, metrics, evaluation: { pass: true, checks: [] } }],
    metadata: {
      scheduleIdentity: 'test-schedule',
      schedule: {
        cycleSize: 24,
        playerCounts: [2, 3, 4, 5],
        cyclicAgentOffsetsPerPlayerCount: AGENT_TYPES.length,
        identicalProgramBranchExposure: true,
        replaySample: 'first complete cycle per branch',
      },
      baseSeed: 123,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      replaySchemaVersion: REPLAY_SCHEMA_VERSION,
      configVersion: content.identity.configVersion,
      configDigest: content.identity.configDigest,
      cardsVersion: content.identity.cardsVersion,
      cardsDigest: content.identity.cardsDigest,
      policyVersion: POLICY_VERSION,
      policyDigest: content.digest(POLICY_VERSION),
    },
    tuningChanges: [],
  });
  const markdown = formatMarkdown(report);
  for (const expected of ['test-schedule', 'complete 24-game cycles', ENGINE_VERSION, `state schema ${STATE_SCHEMA_VERSION}`, content.identity.configVersion, POLICY_VERSION, 'Denominators', 'Human playtesting']) {
    assert.match(markdown, new RegExp(expected));
  }

  const fuzz = runFuzz({ games: 20, baseSeed: 789, content });
  assert.equal(fuzz.failures.length, 0);
  assert.equal(fuzz.games, 20);
});

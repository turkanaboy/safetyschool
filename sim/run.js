import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { AGENT_TYPES, createAgent, POLICY_VERSION } from '../agents/index.js';
import { canonicalStringify, canonicalize, digest, loadContent } from '../engine/content.js';
import { advanceGame, createGame, legalActions, observeGame } from '../engine/index.js';
import { deriveSeed } from '../engine/rng.js';
import { replayGame, REPLAY_SCHEMA_VERSION } from './replay.js';
import { buildReport, formatMarkdown } from './report.js';

const SCRIPTED_TYPES = AGENT_TYPES.filter((type) => type !== 'random');
const SCHEDULE_CYCLE_SIZE = 24;
const TUNING_CHANGES = [
  'Reduced annual upkeep cost disease from 1.05 to 1.03 and raised the State Emergency Appropriation from 5 to 8.',
  'Raised Student Affairs retention from 0.72 + 0.04/level (0.92 cap) to 0.75 + 0.045/level (0.94 cap).',
  'Improved Athletics levels 3-5 odds and raised a great season from 8 money / 8 reputation / 400 next-round conversions to 12 / 10 / 500.',
  'Reduced all program upkeep; reduced Engineering open cost from 15 to 12 and raised its pull from 80 to 100.',
  'Reduced Business open cost from 8 to 6 and raised its pull from 150 to 175.',
];

function applyCommand(state, command, content, capture, commands, checkpoints, events) {
  const result = advanceGame(state, command, content);
  if (capture) {
    commands.push(structuredClone(command));
    checkpoints.push({
      stateDigest: digest(result.state),
      eventDigest: digest(result.events),
      rngBytes: canonicalStringify(result.state.rng),
    });
    events.push(...result.events);
  }
  return result.state;
}

export function runGame({ seed, lineup, programsEnabled, content = loadContent(), captureReplay = false }) {
  const agents = lineup.map((type, seat) => createAgent(type, { seed: deriveSeed(seed, `agent:${seat}:${type}`) }));
  const setup = {
    seed,
    players: agents.map((agent, seat) => agent.setup(`p${seat + 1}`, `${agent.type} ${seat + 1}`)),
    programsEnabled,
  };
  const created = createGame(setup, content);
  let state = created.state;
  const commands = [];
  const checkpoints = [];
  const events = captureReplay ? [...created.events] : [];
  let guard = 0;

  while (!state.finished) {
    guard += 1;
    if (guard > 300) throw new Error('game exceeded 300 engine commands');
    if (state.phase === 'ready') {
      state = applyCommand(state, { type: 'startRound' }, content, captureReplay, commands, checkpoints, events);
      continue;
    }
    if (state.phase === 'allocation') {
      const allocations = {};
      for (const player of state.players.filter((candidate) => candidate.active)) {
        allocations[player.id] = agents[player.seat].chooseAllocation(
          observeGame(state, player.id, content),
          legalActions(state, player.id, content),
        );
      }
      state = applyCommand(state, { type: 'allocate', allocations }, content, captureReplay, commands, checkpoints, events);
      continue;
    }
    if (state.phase === 'pending') {
      const player = state.players.find((candidate) => candidate.id === state.pendingDecision.playerId);
      const command = agents[player.seat].chooseDecision(
        observeGame(state, player.id, content),
        legalActions(state, player.id, content),
      );
      state = applyCommand(state, command, content, captureReplay, commands, checkpoints, events);
      continue;
    }
    throw new Error(`unresolvable phase ${state.phase}`);
  }

  const winner = state.players.find((player) => player.id === state.winnerId);
  const austerityEntrants = state.players.filter((player) => player.enteredAusterity);
  const summary = {
    seed,
    programsEnabled,
    playerCount: lineup.length,
    lineup: [...lineup],
    winnerId: winner.id,
    winnerType: lineup[winner.seat],
    winnerPrograms: [...winner.programs],
    round: state.round,
    endReason: state.endReason,
    austerityEntrants: austerityEntrants.length,
    austeritySurvivors: austerityEntrants.filter((player) => player.active).length,
    replayOk: null,
    finalStateDigest: digest(state),
  };

  const replayLog = captureReplay ? {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    identity: {
      ...content.identity,
      policyVersion: POLICY_VERSION,
      policyDigest: digest(POLICY_VERSION),
    },
    setup: structuredClone(setup),
    commands,
    checkpoints,
    expected: {
      stateBytes: canonicalStringify(state),
      eventBytes: canonicalStringify(events),
      rngBytes: canonicalStringify(state.rng),
    },
  } : null;
  return { summary, replayLog, state };
}

export function buildSchedule({ minGames, baseSeed, programsEnabled }) {
  const cycles = Math.ceil(minGames / SCHEDULE_CYCLE_SIZE);
  const schedule = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (const playerCount of [2, 3, 4, 5]) {
      for (let offset = 0; offset < AGENT_TYPES.length; offset += 1) {
        const lineup = Array.from({ length: playerCount }, (_, seat) => AGENT_TYPES[(offset + seat) % AGENT_TYPES.length]);
        const label = `${cycle}:${playerCount}:${offset}`;
        schedule.push({
          index: schedule.length,
          cycle,
          playerCount,
          lineup,
          seed: deriveSeed(baseSeed, label),
          programsEnabled,
        });
      }
    }
  }
  return schedule;
}

export function aggregateResults(results, programsEnabled, config) {
  const sortedRounds = results.map((result) => result.round).sort((a, b) => a - b);
  const middle = sortedRounds.length / 2;
  const medianEndRound = sortedRounds.length % 2
    ? sortedRounds[Math.floor(middle)]
    : (sortedRounds[middle - 1] + sortedRounds[middle]) / 2;
  const wins = Object.fromEntries(AGENT_TYPES.map((type) => [type, 0]));
  const programWins = Object.fromEntries(Object.keys(config.programs.catalog).map((program) => [program, 0]));
  let austerityEntrants = 0;
  let austeritySurvivors = 0;
  let replays = 0;
  let replayMatches = 0;

  for (const result of results) {
    wins[result.winnerType] += 1;
    result.winnerPrograms.forEach((program) => { programWins[program] += 1; });
    austerityEntrants += result.austerityEntrants;
    austeritySurvivors += result.austeritySurvivors;
    if (result.replayOk !== null) {
      replays += 1;
      if (result.replayOk) replayMatches += 1;
    }
  }

  return {
    programsEnabled,
    gameCount: results.length,
    winnerShares: Object.fromEntries(AGENT_TYPES.map((type) => [type, wins[type] / results.length])),
    medianEndRound,
    endingBeforeRoundShare: results.filter((result) => result.round < config.simulationAcceptanceCriteria.gamesEndingBeforeRoundMaxExclusive).length / results.length,
    year6TiebreakShare: results.filter((result) => result.endReason === 'year6HealthScore').length / results.length,
    austerityEscapeRate: austerityEntrants ? austeritySurvivors / austerityEntrants : null,
    programWinnerShares: Object.fromEntries(Object.keys(programWins).map((program) => [program, programWins[program] / results.length])),
    replayRate: replays ? replayMatches / replays : null,
    maxRound: Math.max(...sortedRounds),
    denominators: { games: results.length, austerityEntrants, replays },
  };
}

export function evaluateMetrics(metrics, criteria, catalog) {
  const checks = [];
  const add = (name, value, pass, expected) => checks.push({ name, value, expected, pass });
  add('gameCount', metrics.gameCount, metrics.gameCount >= criteria.monteCarloGamesMin, `>= ${criteria.monteCarloGamesMin}`);
  for (const type of SCRIPTED_TYPES) {
    const value = metrics.winnerShares[type];
    add(`winnerShare.${type}`, value, value >= criteria.archetypeWinnerShareMin && value <= criteria.archetypeWinnerShareMax,
      `${criteria.archetypeWinnerShareMin}..${criteria.archetypeWinnerShareMax}`);
  }
  add('winnerShare.random', metrics.winnerShares.random, metrics.winnerShares.random < criteria.randomWinnerShareMax, `< ${criteria.randomWinnerShareMax}`);
  add('medianEndRound', metrics.medianEndRound,
    metrics.medianEndRound >= criteria.medianGameEndRoundMin && metrics.medianEndRound <= criteria.medianGameEndRoundMax,
    `${criteria.medianGameEndRoundMin}..${criteria.medianGameEndRoundMax}`);
  add('endingBeforeRoundShare', metrics.endingBeforeRoundShare,
    metrics.endingBeforeRoundShare <= criteria.gamesEndingBeforeRoundShareMax, `<= ${criteria.gamesEndingBeforeRoundShareMax}`);
  add('year6TiebreakShare', metrics.year6TiebreakShare,
    metrics.year6TiebreakShare <= criteria.gamesReachingYear6TiebreakMax, `<= ${criteria.gamesReachingYear6TiebreakMax}`);
  const austerityMin = criteria.austerityEscapeRateTarget - criteria.austerityEscapeRateTolerance;
  const austerityMax = criteria.austerityEscapeRateTarget + criteria.austerityEscapeRateTolerance;
  add('austerityEscapeRate', metrics.austerityEscapeRate,
    metrics.austerityEscapeRate !== null && metrics.austerityEscapeRate >= austerityMin && metrics.austerityEscapeRate <= austerityMax,
    `${austerityMin}..${austerityMax}`);
  if (metrics.programsEnabled) {
    for (const program of Object.keys(catalog)) {
      const value = metrics.programWinnerShares[program];
      add(`programWinnerShare.${program}`, value,
        value >= criteria.winningPortfolioProgramShareMin && value <= criteria.winningPortfolioProgramShareMax,
        `${criteria.winningPortfolioProgramShareMin}..${criteria.winningPortfolioProgramShareMax}`);
    }
  }
  add('replayRate', metrics.replayRate, metrics.replayRate !== null && metrics.replayRate >= criteria.deterministicReplayRateMin,
    `>= ${criteria.deterministicReplayRateMin}`);
  add('maxRound', metrics.maxRound, metrics.maxRound <= criteria.maxGameRounds, `<= ${criteria.maxGameRounds}`);
  return { pass: checks.every((check) => check.pass), checks };
}

export function runSchedule(schedule, content = loadContent(), { verifyReplay = true, onProgress } = {}) {
  const results = [];
  const replayFailures = [];
  for (const game of schedule) {
    const shouldReplay = typeof verifyReplay === 'function' ? verifyReplay(game) : verifyReplay;
    const run = runGame({ ...game, content, captureReplay: shouldReplay });
    if (shouldReplay) {
      const replay = replayGame(run.replayLog, content);
      run.summary.replayOk = replay.ok;
      if (!replay.ok) replayFailures.push({ index: game.index, seed: game.seed, divergence: replay.divergence });
    }
    results.push({ ...run.summary, scheduleIndex: game.index, cycle: game.cycle });
    onProgress?.(results.length, schedule.length);
  }
  const metrics = aggregateResults(results, schedule[0].programsEnabled, content.config);
  return { results, metrics, replayFailures };
}

export async function runScheduleParallel(schedule, content = loadContent(), {
  verifyReplay = 'sample',
  workers = Math.min(8, availableParallelism()),
  onProgress,
} = {}) {
  if (workers <= 1) {
    return runSchedule(schedule, content, {
      verifyReplay: verifyReplay === 'all' ? true : verifyReplay === 'sample' ? (game) => game.cycle === 0 : false,
      onProgress,
    });
  }
  const chunks = Array.from({ length: Math.min(workers, schedule.length) }, () => []);
  schedule.forEach((game, index) => chunks[index % chunks.length].push(game));
  const progress = Array(chunks.length).fill(0);

  const completed = await Promise.all(chunks.map((chunk, workerIndex) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { schedule: chunk, verifyReplay },
    });
    worker.on('message', (message) => {
      if (message.type === 'progress') {
        progress[workerIndex] = message.complete;
        onProgress?.(progress.reduce((total, value) => total + value, 0), schedule.length);
      } else if (message.type === 'complete') {
        if (message.identity.configDigest !== content.identity.configDigest
          || message.identity.cardsDigest !== content.identity.cardsDigest) {
          reject(new Error('worker content identity mismatch'));
        } else resolve(message);
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`simulation worker exited ${code}`));
    });
  })));
  const results = completed.flatMap((result) => result.results).sort((a, b) => a.scheduleIndex - b.scheduleIndex);
  const replayFailures = completed.flatMap((result) => result.replayFailures);
  return {
    results,
    metrics: aggregateResults(results, schedule[0].programsEnabled, content.config),
    replayFailures,
  };
}

function allNumbersFinite(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(allNumbersFinite);
  if (value && typeof value === 'object') return Object.values(value).every(allNumbersFinite);
  return true;
}

export function runFuzz({ games, baseSeed, content = loadContent() }) {
  const failures = [];
  for (let index = 0; index < games; index += 1) {
    const playerCount = 2 + (index % 4);
    try {
      const run = runGame({
        seed: deriveSeed(baseSeed, `fuzz:${index}`),
        lineup: Array.from({ length: playerCount }, () => 'random'),
        programsEnabled: index % 2 === 0,
        content,
        captureReplay: false,
      });
      if (!run.state.finished || run.state.pendingDecision) throw new Error('game ended unresolved');
      if (run.state.round > content.config.simulationAcceptanceCriteria.maxGameRounds) throw new Error(`round ${run.state.round} exceeds maximum`);
      if (!allNumbersFinite(run.state)) throw new Error('state contains a non-finite number');
    } catch (error) {
      failures.push({ index, message: error.message });
    }
  }
  return { games, failures };
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : Number(args[index + 1]);
}

async function main() {
  const args = process.argv.slice(2);
  const content = loadContent();
  const baseSeed = option(args, '--seed', 20260715);
  if (args.includes('--fuzz')) {
    const games = option(args, '--games', content.config.simulationAcceptanceCriteria.randomFuzzGamesMin);
    const fuzz = runFuzz({ games, baseSeed, content });
    console.log(JSON.stringify(fuzz, null, 2));
    if (fuzz.failures.length) process.exitCode = 1;
    return;
  }

  const minGames = option(args, '--games', content.config.simulationAcceptanceCriteria.monteCarloGamesMin);
  const branches = [];
  const allResults = [];
  for (const programsEnabled of [false, true]) {
    const schedule = buildSchedule({ minGames, baseSeed, programsEnabled });
    const run = await runScheduleParallel(schedule, content, {
      verifyReplay: 'sample',
      onProgress: (complete, total) => {
        if (complete % 1000 === 0 || complete === total) console.log(`Programs ${programsEnabled ? 'on' : 'off'}: ${complete}/${total}`);
      },
    });
    const evaluation = evaluateMetrics(run.metrics, content.config.simulationAcceptanceCriteria, content.config.programs.catalog);
    branches.push({ programsEnabled, metrics: run.metrics, evaluation, replayFailures: run.replayFailures });
    allResults.push(...run.results);
  }

  const scheduleIdentity = digest({ baseSeed, minGames, cycleSize: SCHEDULE_CYCLE_SIZE, agentTypes: AGENT_TYPES });
  const report = buildReport({
    branches,
    metadata: {
      scheduleIdentity,
      baseSeed,
      configVersion: content.identity.configVersion,
      configDigest: content.identity.configDigest,
      cardsVersion: content.identity.cardsVersion,
      cardsDigest: content.identity.cardsDigest,
      policyVersion: POLICY_VERSION,
      policyDigest: digest(POLICY_VERSION),
    },
    tuningChanges: TUNING_CHANGES,
  });
  mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../reports/phase-1-games.ndjson', import.meta.url), `${allResults.map(canonicalStringify).join('\n')}\n`);
  writeFileSync(new URL('../reports/phase-1-balance.json', import.meta.url), `${JSON.stringify(canonicalize(report), null, 2)}\n`);
  writeFileSync(new URL('../reports/phase-1-balance.md', import.meta.url), formatMarkdown(report));
  console.log(formatMarkdown(report));
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

import { canonicalStringify, DEPARTMENTS } from './content.js';
import { createRng, shuffle } from './rng.js';
import { resolveAllocation, resolveRound, resumeDecision, startRound } from './rules.js';

export { roundMoney } from './rules.js';
export { healthScore } from './rules.js';
export { legalActions, observeGame } from './rules.js';

export const STATE_SCHEMA_VERSION = 2;
export const ENGINE_VERSION = '0.2.0';

function assert(condition, path, message) {
  if (!condition) throw new TypeError(`${path}: ${message}`);
}

function validatePlayers(players, config) {
  assert(Array.isArray(players), 'players', 'must be an array');
  assert(players.length >= config.players.min && players.length <= config.players.max, 'players', `expected ${config.players.min} through ${config.players.max}`);
  const ids = new Set();

  players.forEach((player, index) => {
    const path = `players[${index}]`;
    assert(player && typeof player === 'object', path, 'must be an object');
    assert(typeof player.id === 'string' && player.id.length > 0, `${path}.id`, 'must be a non-empty string');
    assert(!ids.has(player.id), `${path}.id`, 'must be unique');
    ids.add(player.id);
    assert(typeof player.name === 'string' && player.name.length > 0, `${path}.name`, 'must be a non-empty string');
    assert(player.upgrades && typeof player.upgrades === 'object', `${path}.upgrades`, 'must be an object');

    let total = 0;
    for (const [department, levels] of Object.entries(player.upgrades)) {
      assert(DEPARTMENTS.includes(department), `${path}.upgrades.${department}`, 'unknown department');
      assert(Number.isInteger(levels) && levels >= 0, `${path}.upgrades.${department}`, 'must be a non-negative integer');
      assert(levels <= config.startingState.setupMaxLevelsPerDepartment, `${path}.upgrades.${department}`, `maximum is ${config.startingState.setupMaxLevelsPerDepartment}`);
      total += levels;
    }
    assert(total === config.startingState.setupFreeUpgradeLevels, `${path}.upgrades`, `must total ${config.startingState.setupFreeUpgradeLevels}`);
  });
}

function createPlayer(player, seat, config) {
  const level = config.startingState.allDepartmentsLevel;
  const departments = Object.fromEntries(DEPARTMENTS.map((department) => [
    department,
    level + (player.upgrades[department] ?? 0),
  ]));

  return {
    id: player.id,
    name: player.name,
    seat,
    active: true,
    eliminatedRound: null,
    treasury: config.startingState.treasury,
    students: config.startingState.students,
    reputation: config.startingState.reputation,
    alumni: config.startingState.alumni,
    departments,
    programs: [],
    yearLosses: 0,
    strainedRounds: 0,
    usedSafetyNet: false,
    adminCancelsUsed: 0,
    enteredAusterity: false,
    effects: {
      bonusConversionsPending: 0,
      retentionDeltaThisYear: 0,
      temporaryCapacityThisYear: 0,
      donationMultiplierThisYearEnd: 1,
      nextCrisisSeverityReduction: 0,
      extraActionsNextRound: 0,
      campaignYieldFloorBonusNext: 0,
      campaignYieldLockNext: null,
      campaignPullMultiplierNext: 1,
      campaignBlockedNextRound: false,
      recruitingPenaltyNextRound: 1,
      treasuryRevealedRounds: 0,
    },
  };
}

function shuffleDeck(ids, rng) {
  const shuffled = shuffle(ids, rng);
  return { deck: { draw: shuffled.items, discard: [] }, rng: shuffled.rng };
}

export function assertCompatibleContent(state, content) {
  assert(state.schemaVersion === STATE_SCHEMA_VERSION, 'state.schemaVersion', `expected ${STATE_SCHEMA_VERSION}`);
  assert(state.engineVersion === ENGINE_VERSION, 'state.engineVersion', `expected ${ENGINE_VERSION}`);
  for (const key of ['configDigest', 'cardsDigest']) {
    assert(state.contentIdentity?.[key] === content.identity[key], `state.contentIdentity.${key}`, `does not match loaded content`);
  }
}

export function createGame({ seed, players, programsEnabled = true }, content) {
  assert(content?.config && content?.cards && content?.identity, 'content', 'validated content is required');
  assert(Number.isInteger(seed), 'seed', 'must be an integer');
  assert(typeof programsEnabled === 'boolean', 'programsEnabled', 'must be boolean');
  validatePlayers(players, content.config);

  let rng = createRng(seed);
  const decks = {};
  for (const [name, cards] of [
    ['fortune', content.cards.fortuneCards],
    ['crisis', content.cards.crisisCards],
    ['headline', content.cards.headlines],
    ['disruption', content.cards.annualDisruptions],
  ]) {
    const shuffled = shuffleDeck(cards.map((card) => card.id), rng);
    decks[name] = shuffled.deck;
    rng = shuffled.rng;
  }

  const firstDisruption = decks.disruption.draw.shift();
  const events = [
    { type: 'gameCreated', seed: seed >>> 0, players: players.map(({ id }) => id), programsEnabled },
    { type: 'disruptionRevealed', visibility: 'public', year: 2, cardId: firstDisruption },
  ];
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    contentIdentity: structuredClone(content.identity),
    seed: seed >>> 0,
    programsEnabled,
    rng,
    round: 0,
    year: 0,
    roundOfYear: 0,
    prioritySeat: 0,
    phase: 'ready',
    headline: null,
    players: players.map((player, seat) => createPlayer(player, seat, content.config)),
    decks,
    disruptions: {
      active: null,
      publicThroughYear: 2,
      revealedByYear: { 2: firstDisruption },
      claimedRaceRewards: [],
    },
    pendingDecision: null,
    finished: false,
    winnerId: null,
    endReason: null,
    standings: null,
    lastSnapshot: null,
  };

  return { state, events, rng: state.rng, pendingDecision: null };
}

export function canonicalStateBytes(state) {
  return canonicalStringify(state);
}

export function advanceGame(state, command, content) {
  assertCompatibleContent(state, content);
  if (command?.type === 'startRound') return startRound(state, content);
  if (command?.type === 'allocate') return resolveAllocation(state, command, content);
  if (command?.type === 'round') return resolveRound(state, command, content);
  return resumeDecision(state, command, content);
}

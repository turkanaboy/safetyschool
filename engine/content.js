import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEPARTMENTS = Object.freeze([
  'admissions', 'marketing', 'academics', 'studentAffairs', 'athletics', 'administration',
]);

const RULES = Object.freeze({
  'config.economy.donationPerAlumScalesWithDepartment': new Set(DEPARTMENTS),
  'config.departments.admissions.upgradeRestriction': new Set(['yearEndRoundOnly']),
  'config.programs.catalog.business.reputationMultiplierOverride': new Set(['(reputation / 50) ^ 2']),
  'config.recruiting.poolAllotmentPerRound': new Set(['annualPool / roundsPerYear']),
  'config.recruiting.reputationPullMultiplier': new Set(['reputation / 50']),
  'config.recruiting.eliminatedPlayerInheritance.redistributionWeighting': new Set(['reputationShare']),
  'config.chanceCards.crisisDamageFormula': new Set(['base * (6 - targetLevel) / 5']),
  'config.chanceCards.fortuneBenefitFormula': new Set(['base * (targetLevel + 1) / 3']),
  'config.victory.tiebreakAtYear6.formula': new Set(['treasury/10 + students/100 + reputation + sum(departmentLevels)*5 + alumni/500']),
});

const CRITERIA = Object.freeze([
  'monteCarloGamesMin', 'archetypeWinnerShareMin', 'archetypeWinnerShareMax',
  'randomWinnerShareMax', 'medianGameEndRoundMin', 'medianGameEndRoundMax',
  'austerityEscapeRateTarget', 'austerityEscapeRateTolerance',
  'gamesEndingBeforeRoundMaxExclusive', 'gamesEndingBeforeRoundShareMax',
  'gamesReachingYear6TiebreakMax', 'winningPortfolioProgramShareMin',
  'winningPortfolioProgramShareMax', 'deterministicReplayRateMin',
  'maxGameRounds', 'randomFuzzGamesMin',
]);

function fail(path, message) {
  throw new TypeError(`${path}: ${message}`);
}

function expect(condition, path, message) {
  if (!condition) fail(path, message);
}

function at(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function validateProbabilityTable(table, path) {
  expect(table && typeof table === 'object', path, 'must be an object');
  const values = Object.values(table);
  expect(values.length > 0 && values.every((value) => Number.isFinite(value) && value >= 0), path, 'must contain non-negative finite probabilities');
  expect(Math.abs(values.reduce((total, value) => total + value, 0) - 1) < 1e-9, path, 'probabilities must total 1');
}

function validateEffect(effect, path, allowed, programs) {
  expect(effect && typeof effect === 'object' && !Array.isArray(effect), path, 'must be an object');
  expect(allowed.has(effect.type), `${path}.type`, `unknown effect type ${JSON.stringify(effect.type)}`);

  if ('program' in effect || effect.type === 'programRider') {
    expect(programs.has(effect.program), `${path}.program`, `unknown program ${JSON.stringify(effect.program)}`);
  }
  if ('department' in effect) {
    expect(DEPARTMENTS.includes(effect.department), `${path}.department`, `unknown department ${JSON.stringify(effect.department)}`);
  }
  if (effect.type === 'raceReward') {
    expect(effect.condition && typeof effect.condition === 'object', `${path}.condition`, 'must be an object');
    expect(effect.reward && typeof effect.reward === 'object', `${path}.reward`, 'must be an object');
  }
}

function validateDeck(cards, key, expectedSize, allowedEffects, programs, ids, { playerCards = false } = {}) {
  const deck = cards[key];
  const path = `cards.${key}`;
  expect(Array.isArray(deck), path, 'must be an array');
  expect(deck.length === expectedSize, path, `expected ${expectedSize} cards, received ${deck.length}`);

  deck.forEach((card, index) => {
    const cardPath = `${path}[${index}]`;
    expect(card && typeof card === 'object', cardPath, 'must be an object');
    expect(typeof card.id === 'string' && card.id.length > 0, `${cardPath}.id`, 'must be a non-empty string');
    expect(!ids.has(card.id), `${cardPath}.id`, `duplicate card ID ${card.id}`);
    ids.add(card.id);
    expect(typeof card.name === 'string' && card.name.length > 0, `${cardPath}.name`, 'must be a non-empty string');
    expect(Array.isArray(card.effects), `${cardPath}.effects`, 'must be an array');

    if (playerCards) {
      expect(card.target === 'random' || DEPARTMENTS.includes(card.target), `${cardPath}.target`, `unknown department ${JSON.stringify(card.target)}`);
      expect([1, 2, 3].includes(card.severity), `${cardPath}.severity`, 'must be 1, 2, or 3');
    }

    card.effects.forEach((effect, effectIndex) => validateEffect(effect, `${cardPath}.effects[${effectIndex}]`, allowedEffects, programs));
  });
}

function validateConfig(config) {
  expect(config && typeof config === 'object' && !Array.isArray(config), 'config', 'must be an object');
  expect(Number.isInteger(config.players?.min) && Number.isInteger(config.players?.max), 'config.players', 'min and max must be integers');
  expect(config.players.min >= 2 && config.players.max >= config.players.min, 'config.players', 'invalid player bounds');
  expect(config.departments && DEPARTMENTS.every((department) => department in config.departments), 'config.departments', 'all six departments are required');

  for (const [level, odds] of Object.entries(config.departments.athletics.seasonOddsByLevel ?? {})) {
    validateProbabilityTable(odds, `config.departments.athletics.seasonOddsByLevel.${level}`);
  }
  validateProbabilityTable(config.chanceCards?.severityDistribution, 'config.chanceCards.severityDistribution');

  for (const [path, allowed] of Object.entries(RULES)) {
    const value = at({ config }, path);
    expect(allowed.has(value), path, `unknown executable rule identifier ${JSON.stringify(value)}`);
  }

  const criteria = config.simulationAcceptanceCriteria;
  expect(criteria && typeof criteria === 'object', 'config.simulationAcceptanceCriteria', 'must be an object');
  for (const key of CRITERIA) {
    expect(Number.isFinite(criteria[key]), `config.simulationAcceptanceCriteria.${key}`, 'must be a finite number');
  }
  expect(criteria.archetypeWinnerShareMin <= criteria.archetypeWinnerShareMax, 'config.simulationAcceptanceCriteria', 'archetype winner-share bounds are reversed');
  expect(criteria.winningPortfolioProgramShareMin <= criteria.winningPortfolioProgramShareMax, 'config.simulationAcceptanceCriteria', 'program portfolio bounds are reversed');
}

function validateCards(config, cards) {
  expect(cards && typeof cards === 'object' && !Array.isArray(cards), 'cards', 'must be an object');
  const programs = new Set(Object.keys(config.programs.catalog));
  const ids = new Set();
  const disruptionEffects = new Set(Object.keys(cards.effectTypeVocabulary ?? {}));
  const playerEffects = new Set(Object.keys(cards.playerCardEffectVocabulary ?? {}));
  const headlineEffects = new Set(Object.keys(cards.headlineRules?.effectVocabulary ?? {}));

  validateDeck(cards, 'annualDisruptions', config.annualDisruptions.deckSize, disruptionEffects, programs, ids);
  validateDeck(cards, 'fortuneCards', config.chanceCards.deckSizes.fortune, playerEffects, programs, ids, { playerCards: true });
  validateDeck(cards, 'crisisCards', config.chanceCards.deckSizes.crisis, playerEffects, programs, ids, { playerCards: true });
  validateDeck(cards, 'headlines', config.headlines.deckSize, headlineEffects, programs, ids);

  for (const key of ['fortuneCards', 'crisisCards']) {
    const counts = { 1: 0, 2: 0, 3: 0 };
    cards[key].forEach((card) => { counts[card.severity] += 1; });
    expect(counts[1] === 15 && counts[2] === 14 && counts[3] === 7, `cards.${key}`, 'severity composition must be 15/14/7');
  }

  const noOps = cards.headlines.filter((card) => card.effects.some((effect) => effect.type === 'noOp')).length;
  expect(noOps === Math.round(config.headlines.deckSize * config.headlines.noOpFraction), 'cards.headlines', 'no-op count does not match configured fraction');
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function digest(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

export function validateContent(configInput, cardsInput) {
  const config = structuredClone(configInput);
  const cards = structuredClone(cardsInput);
  validateConfig(config);
  validateCards(config, cards);
  const normalizedConfig = canonicalize(config);
  const normalizedCards = canonicalize(cards);

  return deepFreeze({
    config: normalizedConfig,
    cards: normalizedCards,
    identity: {
      configDigest: digest(normalizedConfig),
      cardsDigest: digest(normalizedCards),
      configVersion: normalizedConfig._meta.version,
      cardsVersion: normalizedCards._meta.version,
    },
  });
}

export function loadContent() {
  const config = JSON.parse(readFileSync(new URL('../balance-config.json', import.meta.url), 'utf8'));
  const cards = JSON.parse(readFileSync(new URL('../cards.json', import.meta.url), 'utf8'));
  return validateContent(config, cards);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const content = loadContent();
  console.log(`Validated Safety School content ${content.identity.configVersion}/${content.identity.cardsVersion}`);
}

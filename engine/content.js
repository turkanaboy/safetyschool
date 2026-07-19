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

const VALUE_EFFECTS = new Set([
  'allPullMultiplier', 'allUpkeepMultiplier', 'bonusConversionsNextRound',
  'bonusConversionsThisRound', 'campaignBlockedNextRound', 'campaignPullMultiplier',
  'campaignPullMultiplierNext', 'campaignSpendCap', 'campaignYieldFloorBonusNext',
  'campaignYieldLockNext', 'departmentUpkeepMultiplier', 'donationMultiplier',
  'donationMultiplierThisYearEnd', 'extraActionsNextRound', 'money', 'moneyDeltaAll',
  'nextCrisisSeverityReduction', 'poachCostDelta', 'poolAllotmentMultiplier',
  'poolMultiplier', 'programMoneyDelta', 'programOpenCostMultiplier',
  'programPullMultiplier', 'recruitingPenaltyNextRound', 'reputation',
  'reputationDeltaAll', 'reputationPullExponentDelta', 'retentionDeltaThisYear',
  'strainFirstOffensePenalty', 'temporaryCapacityThisYear', 'treasuryRevealedRounds',
  'tuitionMultiplier', 'upkeepMultiplier', 'upkeepRefundFraction', 'yieldMultiplier',
]);
const PROGRAM_RIDER_MODIFIERS = new Set([
  'donationBonusMultiplier', 'pullMultiplier', 'pullPerRoundBonus',
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

function expectFiniteFields(object, fields, path) {
  for (const field of fields) expect(Number.isFinite(object[field]), `${path}.${field}`, 'must be a finite number');
}

function validateEffect(effect, path, allowed, programs, { playerCard = false, nested = false } = {}) {
  expect(effect && typeof effect === 'object' && !Array.isArray(effect), path, 'must be an object');
  expect(allowed.has(effect.type), `${path}.type`, `unknown effect type ${JSON.stringify(effect.type)}`);
  if (VALUE_EFFECTS.has(effect.type)) expectFiniteFields(effect, ['value'], path);

  if ('program' in effect || effect.type === 'programRider') {
    expect(programs.has(effect.program), `${path}.program`, `unknown program ${JSON.stringify(effect.program)}`);
  }
  if ('department' in effect) {
    expect(DEPARTMENTS.includes(effect.department), `${path}.department`, `unknown department ${JSON.stringify(effect.department)}`);
  }
  if (effect.type === 'raceReward') {
    expect(effect.condition && typeof effect.condition === 'object', `${path}.condition`, 'must be an object');
    expect(effect.reward && typeof effect.reward === 'object', `${path}.reward`, 'must be an object');
    expectFiniteFields(effect.condition, ['reputationAtLeast'], `${path}.condition`);
    expectFiniteFields(effect.reward, ['bonusConversions'], `${path}.reward`);
    expect(typeof effect.firstOnly === 'boolean', `${path}.firstOnly`, 'must be boolean');
  }
  if (effect.type === 'athleticsPayoutMultiplier') expectFiniteFields(effect, ['great', 'losing'], path);
  if (effect.type === 'poachModifier') expectFiniteFields(effect, ['costMultiplier', 'fractionMultiplier'], path);
  if (effect.type === 'programRider' && playerCard) {
    expect(effect.bonus && typeof effect.bonus === 'object' && !Array.isArray(effect.bonus), `${path}.bonus`, 'must be an object');
    expect(effect.bonus.type !== 'programRider', `${path}.bonus.type`, 'nested program riders are not allowed');
    validateEffect(effect.bonus, `${path}.bonus`, allowed, programs, { playerCard: true, nested: true });
  } else if (effect.type === 'programRider') {
    expect(effect.modifier && typeof effect.modifier === 'object' && !Array.isArray(effect.modifier), `${path}.modifier`, 'must be an object');
    const modifierEntries = Object.entries(effect.modifier);
    expect(modifierEntries.length > 0, `${path}.modifier`, 'must not be empty');
    for (const [name, value] of modifierEntries) {
      expect(PROGRAM_RIDER_MODIFIERS.has(name), `${path}.modifier.${name}`, 'unknown modifier');
      expect(Number.isFinite(value), `${path}.modifier.${name}`, 'must be a finite number');
    }
  }
  if (playerCard && effect.type !== 'programRider' && !nested) {
    expect(typeof effect.scalable === 'boolean', `${path}.scalable`, 'must be boolean');
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

    card.effects.forEach((effect, effectIndex) => validateEffect(
      effect,
      `${cardPath}.effects[${effectIndex}]`,
      allowedEffects,
      programs,
      { playerCard: playerCards },
    ));
  });
}

function validateConfig(config) {
  expect(config && typeof config === 'object' && !Array.isArray(config), 'config', 'must be an object');
  expect(Number.isInteger(config.players?.min) && Number.isInteger(config.players?.max), 'config.players', 'min and max must be integers');
  expect(config.players.min >= 2 && config.players.max >= config.players.min, 'config.players', 'invalid player bounds');
  expect(config.departments && DEPARTMENTS.every((department) => department in config.departments), 'config.departments', 'all six departments are required');
  expect(Number.isInteger(config.allocation?.maxActionsPerRound) && config.allocation.maxActionsPerRound > 0, 'config.allocation.maxActionsPerRound', 'must be a positive integer');
  expect(Number.isFinite(config.resourceBounds?.reputationMin) && Number.isFinite(config.resourceBounds?.reputationMax), 'config.resourceBounds', 'reputation bounds must be finite');
  expect(config.resourceBounds.reputationMin < config.resourceBounds.reputationMax, 'config.resourceBounds', 'reputation bounds are reversed');
  expect(Number.isFinite(config.insolvencyAndElimination?.minimumStudents), 'config.insolvencyAndElimination.minimumStudents', 'must be finite');
  expect(Number.isFinite(config.insolvencyAndElimination?.safetyNet?.treasuryThreshold), 'config.insolvencyAndElimination.safetyNet.treasuryThreshold', 'must be finite');
  expect(Object.values(config.victory?.tiebreakAtYear6?.weights ?? {}).length > 0
    && Object.values(config.victory.tiebreakAtYear6.weights).every(Number.isFinite), 'config.victory.tiebreakAtYear6.weights', 'all score weights must be finite');

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
  expect(criteria.maxGameRounds === config.gameLength.roundsPerYear * config.gameLength.maxYears, 'config.simulationAcceptanceCriteria.maxGameRounds', 'must match the configured game length');
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

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value, amount) => (value >>> amount) | (value << (32 - amount));

export function sha256(text) {
  const input = new TextEncoder().encode(text);
  const byteLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(byteLength);
  bytes.set(input);
  bytes[input.length] = 0x80;

  const view = new DataView(bytes.buffer);
  view.setUint32(byteLength - 8, Math.floor(input.length / 0x20000000));
  view.setUint32(byteLength - 4, (input.length * 8) >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < byteLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + (index * 4));
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15];
      const word2 = words[index - 2];
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

export function digest(value) {
  return sha256(canonicalStringify(value));
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

export function validateContent(configInput, cardsInput, digestValue = digest) {
  const config = structuredClone(configInput);
  const cards = structuredClone(cardsInput);
  validateConfig(config);
  validateCards(config, cards);
  const normalizedConfig = canonicalize(config);
  const normalizedCards = canonicalize(cards);

  return deepFreeze({
    config: normalizedConfig,
    cards: normalizedCards,
    digest: digestValue,
    identity: {
      configDigest: digestValue(normalizedConfig),
      cardsDigest: digestValue(normalizedCards),
      configVersion: normalizedConfig._meta.version,
      cardsVersion: normalizedCards._meta.version,
    },
  });
}

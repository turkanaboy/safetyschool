import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { digest, sha256, validateContent } from '../engine/content.js';
import { loadContent, nodeDigest } from '../engine/content-node.js';

const sourceConfig = JSON.parse(readFileSync(new URL('../balance-config.json', import.meta.url)));
const sourceCards = JSON.parse(readFileSync(new URL('../cards.json', import.meta.url)));

const fixture = () => ({
  config: structuredClone(sourceConfig),
  cards: structuredClone(sourceCards),
});

test('browser SHA-256 matches standard vectors and the Node provider', () => {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ];

  for (const [input, expected] of vectors) assert.equal(sha256(input), expected);

  const values = ['', 'Safety School 🎓', { z: [3, 2, 1], a: true }];
  for (const value of values) assert.equal(digest(value), nodeDigest(value));
});

test('browser-safe and Node content providers preserve Phase 1 identities', () => {
  const browserContent = validateContent(...Object.values(fixture()));
  const nodeContent = loadContent();

  assert.equal(browserContent.identity.configDigest, '45df9be6af3b477f98724c3659a7511de9c390e64db7b8d516f83474714fadc0');
  assert.equal(browserContent.identity.cardsDigest, 'd81fca95f5b8c7ac9bc32281cb922f4f4fd3111aae523fdf884830e68c8fda53');
  assert.deepEqual(nodeContent.identity, browserContent.identity);
  assert.equal(nodeContent.digest({ round: 3 }), browserContent.digest({ round: 3 }));
});

test('browser engine and agent modules contain no Node imports', () => {
  const modules = [
    '../engine/content.js', '../engine/index.js', '../engine/rng.js', '../engine/rules.js', '../agents/index.js',
  ];

  for (const module of modules) {
    assert.doesNotMatch(readFileSync(new URL(module, import.meta.url), 'utf8'), /from ['"]node:/, module);
  }
});

test('canonical content validates, normalizes, hashes, and freezes', () => {
  const content = validateContent(...Object.values(fixture()));

  assert.match(content.identity.configDigest, /^[a-f0-9]{64}$/);
  assert.match(content.identity.cardsDigest, /^[a-f0-9]{64}$/);
  assert.equal(content.cards.fortuneCards.length, content.config.chanceCards.deckSizes.fortune);
  assert.ok(Object.isFrozen(content.config));
  assert.ok(Object.isFrozen(content.cards.fortuneCards[0].effects));
  assert.throws(() => { content.config.players.min = 1; }, TypeError);
});

test('content validation reports the offending path', async (t) => {
  const cases = [
    ['duplicate card ID', ({ cards }) => { cards.crisisCards[0].id = cards.fortuneCards[0].id; }, /cards\.crisisCards\[0\]\.id/],
    ['unknown player effect', ({ cards }) => { cards.fortuneCards[0].effects[0].type = 'wishfulThinking'; }, /cards\.fortuneCards\[0\]\.effects\[0\]\.type/],
    ['missing effect value', ({ cards }) => { delete cards.fortuneCards[1].effects[0].value; }, /cards\.fortuneCards\[1\]\.effects\[0\]\.value/],
    ['invalid nested rider bonus', ({ cards }) => {
      const cardIndex = cards.fortuneCards.findIndex((card) => card.effects.some((effect) => effect.type === 'programRider'));
      const effectIndex = cards.fortuneCards[cardIndex].effects.findIndex((effect) => effect.type === 'programRider');
      cards.fortuneCards[cardIndex].effects[effectIndex].bonus.value = 'many';
    }, /cards\.fortuneCards\[\d+\]\.effects\[\d+\]\.bonus\.value/],
    ['empty disruption rider modifier', ({ cards }) => {
      const card = cards.annualDisruptions.find((candidate) => candidate.effects.some((effect) => effect.type === 'programRider'));
      card.effects.find((effect) => effect.type === 'programRider').modifier = {};
    }, /cards\.annualDisruptions\[\d+\]\.effects\[\d+\]\.modifier/],
    ['missing program reference', ({ cards }) => { cards.annualDisruptions[7].effects[0].program = 'law'; }, /cards\.annualDisruptions\[7\]\.effects\[0\]\.program/],
    ['invalid department', ({ cards }) => { cards.crisisCards[0].target = 'law'; }, /cards\.crisisCards\[0\]\.target/],
    ['deck count mismatch', ({ config }) => { config.chanceCards.deckSizes.fortune += 1; }, /cards\.fortuneCards/],
    ['invalid probability table', ({ config }) => { config.departments.athletics.seasonOddsByLevel['1'].great = 0.2; }, /config\.departments\.athletics\.seasonOddsByLevel\.1/],
    ['unknown rule identifier', ({ config }) => { config.chanceCards.crisisDamageFormula = 'eval(card)'; }, /config\.chanceCards\.crisisDamageFormula/],
  ];

  for (const [name, corrupt, expected] of cases) {
    await t.test(name, () => {
      const data = fixture();
      corrupt(data);
      assert.throws(() => validateContent(data.config, data.cards), expected);
    });
  }
});

test('all Phase 1 acceptance criteria are config-owned', () => {
  const criteria = sourceConfig.simulationAcceptanceCriteria;
  const required = [
    'monteCarloGamesMin',
    'archetypeWinnerShareMin',
    'archetypeWinnerShareMax',
    'randomWinnerShareMax',
    'medianGameEndRoundMin',
    'medianGameEndRoundMax',
    'austerityEscapeRateTarget',
    'austerityEscapeRateTolerance',
    'gamesEndingBeforeRoundMaxExclusive',
    'gamesEndingBeforeRoundShareMax',
    'gamesReachingYear6TiebreakMax',
    'winningPortfolioProgramShareMin',
    'winningPortfolioProgramShareMax',
    'deterministicReplayRateMin',
    'maxGameRounds',
    'randomFuzzGamesMin'
  ];

  assert.deepEqual(required.filter((key) => !(key in criteria)), []);
});

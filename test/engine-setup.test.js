import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalStringify, loadContent } from '../engine/content.js';
import { assertCompatibleContent, createGame, roundMoney, STATE_SCHEMA_VERSION } from '../engine/index.js';
import { createRng, nextRng, shuffle } from '../engine/rng.js';

const content = loadContent();
const setup = (count) => Array.from({ length: count }, (_, seat) => ({
  id: `p${seat + 1}`,
  name: `University ${seat + 1}`,
  upgrades: { admissions: 2, studentAffairs: 1 },
}));

test('Mulberry32 and Fisher-Yates expose deterministic state and cursor', () => {
  const first = nextRng(createRng(123));
  const second = nextRng(first.rng);
  assert.equal(first.rng.cursor, 1);
  assert.equal(second.rng.cursor, 2);
  assert.equal(first.value, nextRng(createRng(123)).value);

  const shuffled = shuffle(['a', 'b', 'c', 'd'], createRng(42));
  assert.equal(shuffled.rng.cursor, 3);
  assert.deepEqual(shuffled.items, shuffle(['a', 'b', 'c', 'd'], createRng(42)).items);
  assert.deepEqual(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd']);
});

test('same setup is byte-identical and deck shuffles consume the exact cursor', () => {
  const a = createGame({ seed: 20260715, players: setup(3), programsEnabled: true }, content);
  const b = createGame({ seed: 20260715, players: setup(3), programsEnabled: true }, content);
  const c = createGame({ seed: 20260716, players: setup(3), programsEnabled: true }, content);

  assert.equal(canonicalStringify(a), canonicalStringify(b));
  assert.notDeepEqual(a.state.decks.fortune.draw, c.state.decks.fortune.draw);
  assert.equal(a.state.rng.cursor, 35 + 35 + 35 + 11);
  assert.equal(a.state.prioritySeat, 0);
  assert.equal(a.events.at(-1).type, 'disruptionRevealed');
  assert.equal(a.events.at(-1).year, 2);
});

test('setup creates independent canonical player state', () => {
  const players = setup(2);
  const result = createGame({ seed: 9, players, programsEnabled: false }, content);
  const [player] = result.state.players;

  assert.equal(result.state.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(result.state.programsEnabled, false);
  assert.equal(player.treasury, content.config.startingState.treasury);
  assert.equal(player.departments.admissions, 3);
  assert.equal(player.departments.studentAffairs, 2);
  assert.equal(player.departments.academics, 1);
  assert.deepEqual(player.programs, []);

  result.state.players[0].departments.admissions = 1;
  assert.equal(players[0].upgrades.admissions, 2);
  assert.equal(content.config.startingState.allDepartmentsLevel, 1);
});

test('setup rejects invalid player counts and upgrade allocations', () => {
  assert.throws(() => createGame({ seed: 1, players: setup(1) }, content), /players: expected 2 through 5/);
  assert.throws(() => createGame({ seed: 1, players: setup(6) }, content), /players: expected 2 through 5/);

  const tooMany = setup(2);
  tooMany[0].upgrades = { admissions: 2, marketing: 2 };
  assert.throws(() => createGame({ seed: 1, players: tooMany }, content), /players\[0\]\.upgrades: must total 3/);

  const concentrated = setup(2);
  concentrated[0].upgrades = { admissions: 3 };
  assert.throws(() => createGame({ seed: 1, players: concentrated }, content), /players\[0\]\.upgrades\.admissions/);
});

test('money persistence uses half-even rounding on both sides of zero', () => {
  assert.equal(roundMoney(1.225), 1.22);
  assert.equal(roundMoney(1.235), 1.24);
  assert.equal(roundMoney(-1.225), -1.22);
  assert.equal(roundMoney(-1.235), -1.24);
  assert.equal(roundMoney(10.129), 10.13);
});

test('state refuses a mismatched schema, engine, config, or card identity before transition work', () => {
  const { state } = createGame({ seed: 2, players: setup(2) }, content);
  assert.doesNotThrow(() => assertCompatibleContent(state, content));

  const wrongSchema = structuredClone(state);
  wrongSchema.schemaVersion += 1;
  assert.throws(() => assertCompatibleContent(wrongSchema, content), /schemaVersion/);

  const wrongEngine = structuredClone(state);
  wrongEngine.engineVersion = 'wrong';
  assert.throws(() => assertCompatibleContent(wrongEngine, content), /engineVersion/);

  const wrongConfig = structuredClone(state);
  wrongConfig.contentIdentity.configDigest = '0'.repeat(64);
  assert.throws(() => assertCompatibleContent(wrongConfig, content), /configDigest/);

  const wrongCards = structuredClone(state);
  wrongCards.contentIdentity.cardsDigest = 'f'.repeat(64);
  assert.throws(() => assertCompatibleContent(wrongCards, content), /cardsDigest/);
});

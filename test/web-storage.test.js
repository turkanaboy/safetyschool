import assert from 'node:assert/strict';
import test from 'node:test';

import { loadContent } from '../engine/content-node.js';
import { canonicalStateBytes, createGame } from '../engine/index.js';
import {
  SAVE_KEY,
  SAVE_SCHEMA_VERSION,
  discardSession,
  isStaleStorageEvent,
  loadSession,
  saveSession,
} from '../web/storage.js';

const content = loadContent();

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    raw(key = SAVE_KEY) {
      return values.get(key);
    },
  };
}

function sessionFixture() {
  const { state } = createGame({
    seed: 41,
    programsEnabled: true,
    players: [
      { id: 'human', name: 'Founders Green', upgrades: { academics: 2, admissions: 1 } },
      { id: 'northbridge', name: 'Northbridge', upgrades: { academics: 2, admissions: 1 } },
      { id: 'saint-cadmus', name: 'Saint Cadmus', upgrades: { studentAffairs: 2, academics: 1 } },
      { id: 'westlake', name: 'Westlake', upgrades: { athletics: 2, marketing: 1 } },
    ],
  }, content);
  return {
    state,
    human: { id: 'human', name: 'Founders Green', mascot: 'owl', color: 'green' },
    rivals: [
      { id: 'northbridge', name: 'Northbridge', archetype: 'prestigePlay', agentSeed: 11 },
      { id: 'saint-cadmus', name: 'Saint Cadmus', archetype: 'fortress', agentSeed: 12 },
      { id: 'westlake', name: 'Westlake', archetype: 'gambler', agentSeed: 13 },
    ],
    tutorial: { step: 'campus' },
    history: [{ round: 0, events: [{ type: 'gameCreated' }] }],
    stagedActions: [],
    mode: 'playing',
  };
}

test('a versioned one-slot save round-trips authoritative state and continuity metadata', () => {
  const storage = memoryStorage();
  const session = sessionFixture();

  const first = saveSession(storage, session, content, { expectedRevision: 0 });
  assert.equal(first.ok, true);
  assert.equal(first.envelope.saveSchemaVersion, SAVE_SCHEMA_VERSION);
  assert.equal(first.envelope.revision, 1);

  const loaded = loadSession(storage, content);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.envelope.revision, 1);
  assert.deepEqual(loaded.envelope.session.human, session.human);
  assert.deepEqual(loaded.envelope.session.rivals, session.rivals);
  assert.deepEqual(loaded.envelope.session.tutorial, session.tutorial);
  assert.deepEqual(loaded.envelope.session.history, session.history);
  assert.equal(canonicalStateBytes(loaded.envelope.session.state), canonicalStateBytes(session.state));

  loaded.envelope.session.tutorial.step = 'allocation';
  const second = saveSession(storage, loaded.envelope.session, content, { expectedRevision: 1 });
  assert.equal(second.ok, true);
  assert.equal(second.envelope.revision, 2);
});

test('invalid, wrong-schema, and incompatible saves are explicit and preserved for discard', () => {
  const invalid = memoryStorage({ [SAVE_KEY]: '{definitely-not-json' });
  assert.deepEqual(loadSession(invalid, content), {
    status: 'invalid',
    reason: 'invalidJson',
    raw: '{definitely-not-json',
  });
  assert.equal(invalid.raw(), '{definitely-not-json');

  const wrongSchemaRaw = JSON.stringify({ saveSchemaVersion: 999, revision: 1, session: sessionFixture() });
  const wrongSchema = memoryStorage({ [SAVE_KEY]: wrongSchemaRaw });
  assert.equal(loadSession(wrongSchema, content).reason, 'unsupportedSchema');
  assert.equal(wrongSchema.raw(), wrongSchemaRaw);

  const incompatibleEnvelope = {
    saveSchemaVersion: SAVE_SCHEMA_VERSION,
    revision: 1,
    session: sessionFixture(),
  };
  incompatibleEnvelope.session.state.contentIdentity.configDigest = 'not-this-content';
  const incompatibleRaw = JSON.stringify(incompatibleEnvelope);
  const incompatible = memoryStorage({ [SAVE_KEY]: incompatibleRaw });
  assert.equal(loadSession(incompatible, content).reason, 'incompatibleContent');
  assert.equal(incompatible.raw(), incompatibleRaw);

  assert.equal(discardSession(incompatible), true);
  assert.equal(loadSession(incompatible, content).status, 'empty');
});

test('stale revisions and unavailable storage never overwrite the current slot', () => {
  const storage = memoryStorage();
  const session = sessionFixture();
  assert.equal(saveSession(storage, session, content, { expectedRevision: 0 }).ok, true);
  const currentRaw = storage.raw();

  const stale = saveSession(storage, session, content, { expectedRevision: 0 });
  assert.deepEqual(stale, { ok: false, reason: 'staleRevision', revision: 1 });
  assert.equal(storage.raw(), currentRaw);

  const invalidExisting = memoryStorage({ [SAVE_KEY]: '{broken' });
  assert.equal(saveSession(invalidExisting, session, content, { expectedRevision: 0 }).reason, 'invalidExisting');
  assert.equal(invalidExisting.raw(), '{broken');

  const unavailable = {
    getItem() { return null; },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('security'); },
  };
  assert.deepEqual(saveSession(unavailable, session, content, { expectedRevision: 0 }), {
    ok: false,
    reason: 'storageUnavailable',
  });
  assert.equal(discardSession(unavailable), false);

  const uncloneable = sessionFixture();
  uncloneable.tutorial.callback = () => {};
  assert.deepEqual(saveSession(memoryStorage(), uncloneable, content, { expectedRevision: 0 }), {
    ok: false,
    reason: 'invalidSession',
  });
});

test('storage events only pause this session for a newer valid revision', () => {
  const session = sessionFixture();
  const newer = JSON.stringify({ saveSchemaVersion: SAVE_SCHEMA_VERSION, revision: 4, session });
  assert.equal(isStaleStorageEvent({ key: SAVE_KEY, newValue: newer }, 3, content), true);
  assert.equal(isStaleStorageEvent({ key: SAVE_KEY, newValue: newer }, 4, content), false);
  assert.equal(isStaleStorageEvent({ key: 'unrelated', newValue: newer }, 3, content), false);
  assert.equal(isStaleStorageEvent({ key: SAVE_KEY, newValue: '{broken' }, 3, content), false);
});

test('a valid existing game requires an explicit discard before a new game can replace it', () => {
  const storage = memoryStorage();
  const firstSession = sessionFixture();
  assert.equal(saveSession(storage, firstSession, content, { expectedRevision: 0 }).ok, true);
  const savedRaw = storage.raw();

  const replacement = sessionFixture();
  replacement.state.seed = 99;
  const blocked = saveSession(storage, replacement, content, { expectedRevision: 0 });
  assert.equal(blocked.reason, 'staleRevision');
  assert.equal(storage.raw(), savedRaw, 'cancel leaves the original game untouched');

  assert.equal(discardSession(storage), true);
  const confirmed = saveSession(storage, replacement, content, { expectedRevision: 0 });
  assert.equal(confirmed.ok, true);
  assert.equal(loadSession(storage, content).envelope.session.state.seed, 99);
});

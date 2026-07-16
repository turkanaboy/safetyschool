import { AGENT_TYPES } from '../agents/index.js';
import { assertCompatibleContent } from '../engine/index.js';

export const SAVE_KEY = 'safety-school:solo';
export const SAVE_SCHEMA_VERSION = 1;

function validateSession(session, content) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new TypeError('session must be an object');
  if (!session.state || typeof session.state !== 'object') throw new TypeError('session.state must be an object');
  assertCompatibleContent(session.state, content);
  if (!session.human || !['id', 'name', 'mascot', 'color']
    .every((field) => typeof session.human[field] === 'string' && session.human[field].length > 0)) {
    throw new TypeError('session.human is invalid');
  }
  if (!Array.isArray(session.rivals) || session.rivals.length !== 3) throw new TypeError('session.rivals must contain three schools');
  const scriptedTypes = new Set(AGENT_TYPES.filter((type) => type !== 'random'));
  if (!session.rivals.every((rival) => rival
    && ['id', 'name', 'archetype'].every((field) => typeof rival[field] === 'string' && rival[field].length > 0)
    && scriptedTypes.has(rival.archetype)
    && Number.isInteger(rival.agentSeed))) {
    throw new TypeError('session rival metadata is invalid');
  }
  const lineup = [session.human.id, ...session.rivals.map((rival) => rival.id)];
  const playerIds = session.state.players?.map((player) => player.id) ?? [];
  if (new Set(lineup).size !== 4 || playerIds.length !== 4
    || lineup.some((id) => !playerIds.includes(id)) || session.state.programsEnabled !== true) {
    throw new TypeError('session lineup is invalid');
  }
  if (!session.tutorial || typeof session.tutorial !== 'object' || Array.isArray(session.tutorial)) {
    throw new TypeError('session.tutorial must be an object');
  }
  if (!Array.isArray(session.history) || !session.history.every((entry) => entry
    && Number.isInteger(entry.round) && Array.isArray(entry.events)
    && entry.events.every((event) => event?.type !== 'roundSnapshot' && !Object.hasOwn(event ?? {}, 'bytes')))) {
    throw new TypeError('session.history is invalid');
  }
  if (!Array.isArray(session.stagedActions)) throw new TypeError('session.stagedActions must be an array');
  if (!['playing', 'eliminationChoice', 'spectating', 'skipping', 'complete'].includes(session.mode)) {
    throw new TypeError('session.mode is invalid');
  }
}

function parseEnvelope(raw, content) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { status: 'invalid', reason: 'invalidJson', raw };
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { status: 'invalid', reason: 'invalidEnvelope', raw };
  }
  if (envelope.saveSchemaVersion !== SAVE_SCHEMA_VERSION) {
    return { status: 'invalid', reason: 'unsupportedSchema', raw };
  }
  if (!Number.isInteger(envelope.revision) || envelope.revision < 1) {
    return { status: 'invalid', reason: 'invalidRevision', raw };
  }
  try {
    validateSession(envelope.session, content);
  } catch (error) {
    const reason = error instanceof TypeError && /^state\.(?:schemaVersion|engineVersion|contentIdentity)/.test(error.message)
      ? 'incompatibleContent'
      : 'invalidSession';
    return { status: 'invalid', reason, raw };
  }
  return { status: 'ok', envelope };
}

export function loadSession(storage, content, { key = SAVE_KEY } = {}) {
  let raw;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: 'unavailable', reason: 'storageUnavailable' };
  }
  if (raw === null) return { status: 'empty' };
  return parseEnvelope(raw, content);
}

export function saveSession(storage, session, content, { expectedRevision = 0, key = SAVE_KEY } = {}) {
  try {
    validateSession(session, content);
  } catch {
    return { ok: false, reason: 'invalidSession' };
  }

  const existing = loadSession(storage, content, { key });
  if (existing.status === 'unavailable') return { ok: false, reason: 'storageUnavailable' };
  if (existing.status === 'invalid') return { ok: false, reason: 'invalidExisting' };
  const revision = existing.status === 'ok' ? existing.envelope.revision : 0;
  if (revision !== expectedRevision) return { ok: false, reason: 'staleRevision', revision };

  let envelope;
  let serialized;
  try {
    envelope = {
      saveSchemaVersion: SAVE_SCHEMA_VERSION,
      revision: revision + 1,
      session: structuredClone(session),
    };
    serialized = JSON.stringify(envelope);
  } catch {
    return { ok: false, reason: 'invalidSession' };
  }
  try {
    storage.setItem(key, serialized);
  } catch {
    return { ok: false, reason: 'storageUnavailable' };
  }
  return { ok: true, envelope };
}

export function discardSession(storage, { key = SAVE_KEY } = {}) {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function isStaleStorageEvent(event, revision, content, { key = SAVE_KEY } = {}) {
  if (event?.key !== key || typeof event.newValue !== 'string') return false;
  const result = parseEnvelope(event.newValue, content);
  return result.status === 'ok' && result.envelope.revision > revision;
}

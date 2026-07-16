import { POLICY_VERSION } from '../agents/index.js';
import { canonicalStringify } from '../engine/content.js';
import { advanceGame, createGame, ENGINE_VERSION, STATE_SCHEMA_VERSION } from '../engine/index.js';

export const REPLAY_SCHEMA_VERSION = 2;

function divergence(commandIndex, artifact, message) {
  return { ok: false, divergence: { commandIndex, artifact, message } };
}

export function replayGame(log, content) {
  if (log.schemaVersion !== REPLAY_SCHEMA_VERSION) return divergence(null, 'identity', 'schemaVersion does not match');
  for (const key of ['configDigest', 'cardsDigest']) {
    if (log.identity?.[key] !== content.identity[key]) return divergence(null, 'identity', `${key} does not match loaded content`);
  }
  if (log.identity?.stateSchemaVersion !== STATE_SCHEMA_VERSION) return divergence(null, 'identity', 'stateSchemaVersion does not match');
  if (log.identity?.engineVersion !== ENGINE_VERSION) return divergence(null, 'identity', 'engineVersion does not match');
  if (log.identity.policyDigest !== content.digest(POLICY_VERSION)) return divergence(null, 'identity', 'policyDigest does not match loaded policies');

  let created;
  try {
    created = createGame(log.setup, content);
  } catch (error) {
    return divergence(null, 'setup', error.message);
  }
  let state = created.state;
  const events = [...created.events];

  for (let commandIndex = 0; commandIndex < log.commands.length; commandIndex += 1) {
    let result;
    try {
      result = advanceGame(state, log.commands[commandIndex], content);
    } catch (error) {
      return divergence(commandIndex, 'command', error.message);
    }
    state = result.state;
    events.push(...result.events);
    const expected = log.checkpoints[commandIndex];
    const actual = {
      stateDigest: content.digest(state),
      eventDigest: content.digest(result.events),
      rngBytes: canonicalStringify(state.rng),
    };
    for (const key of ['stateDigest', 'eventDigest', 'rngBytes']) {
      if (actual[key] !== expected[key]) return divergence(commandIndex, key, `${key} diverged`);
    }
  }

  const result = {
    ok: true,
    stateBytes: canonicalStringify(state),
    eventBytes: canonicalStringify(events),
    rngBytes: canonicalStringify(state.rng),
    divergence: null,
  };
  for (const key of ['stateBytes', 'eventBytes', 'rngBytes']) {
    if (result[key] !== log.expected[key]) return divergence(log.commands.length, key, `${key} diverged at completion`);
  }
  return result;
}

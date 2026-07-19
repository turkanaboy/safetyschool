import assert from 'node:assert/strict';
import test from 'node:test';

import { loadContent } from '../engine/content-node.js';
import { replayGame } from '../sim/replay.js';
import { runGame } from '../sim/run.js';

const content = loadContent();

test('a captured game replays to byte-identical state, events, and RNG', () => {
  const original = runGame({
    seed: 9191,
    lineup: ['steadyHand', 'gambler', 'prestigePlay'],
    programsEnabled: true,
    content,
    captureReplay: true,
  });
  const replay = replayGame(original.replayLog, content);
  assert.equal(replay.ok, true);
  assert.equal(replay.stateBytes, original.replayLog.expected.stateBytes);
  assert.equal(replay.eventBytes, original.replayLog.expected.eventBytes);
  assert.equal(replay.rngBytes, original.replayLog.expected.rngBytes);
});

test('replay reports the first tampered command and rejects identity mismatches before commands', () => {
  const original = runGame({
    seed: 9292,
    lineup: ['steadyHand', 'gambler'],
    programsEnabled: false,
    content,
    captureReplay: true,
  });
  const tampered = structuredClone(original.replayLog);
  const commandIndex = tampered.commands.findIndex((command) => command.type === 'allocate'
    && Object.values(command.allocations).some((actions) => actions.length > 0));
  const playerId = Object.keys(tampered.commands[commandIndex].allocations)
    .find((id) => tampered.commands[commandIndex].allocations[id].length > 0);
  tampered.commands[commandIndex].allocations[playerId] = [];
  const divergent = replayGame(tampered, content);
  assert.equal(divergent.ok, false);
  assert.equal(divergent.divergence.commandIndex, commandIndex);

  const wrongIdentity = structuredClone(original.replayLog);
  wrongIdentity.identity.configDigest = '0'.repeat(64);
  const rejected = replayGame(wrongIdentity, content);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.divergence.commandIndex, null);
  assert.match(rejected.divergence.message, /configDigest/);

  for (const key of ['stateSchemaVersion', 'engineVersion']) {
    const wrongVersion = structuredClone(original.replayLog);
    wrongVersion.identity[key] = 'wrong';
    const versionRejected = replayGame(wrongVersion, content);
    assert.equal(versionRejected.ok, false);
    assert.match(versionRejected.divergence.message, new RegExp(key));
  }
});

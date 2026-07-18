import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalStringify } from '../engine/content.js';
import { loadContent } from '../engine/content-node.js';
import { canonicalStateBytes, healthScore } from '../engine/index.js';
import {
  RIVAL_SCHOOLS,
  createSoloController,
  createSoloSession,
  normalizeHistoryEvents,
  selectRivals,
} from '../web/game.js';
import { loadSession, saveSession } from '../web/storage.js';

const content = loadContent();
const human = {
  id: 'human',
  name: 'Founders Green',
  mascot: 'owl',
  color: 'green',
  upgrades: { academics: 2, admissions: 1 },
};
const rivalIds = ['northbridge', 'saint-cadmus', 'westlake'];

function newSession(seed = 71) {
  return createSoloSession({ seed, human, rivalIds }, content);
}

function force(state, deck, ...ids) {
  state.decks[deck].draw = [...ids, ...state.decks[deck].draw.filter((id) => !ids.includes(id))];
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test('solo setup creates one human and three distinct scripted rivals with programs enabled', () => {
  const session = newSession();
  assert.equal(session.state.players.length, 4);
  assert.equal(session.state.programsEnabled, true);
  assert.deepEqual(session.state.players.map((player) => player.id), ['human', ...rivalIds]);
  assert.equal(new Set(session.rivals.map((rival) => rival.id)).size, 3);
  assert.ok(session.rivals.every((rival) => rival.archetype !== 'random'));
  assert.equal(RIVAL_SCHOOLS.length, 5);

  const rolls = [0.99, 0.01, 0.5, 0.2];
  const selected = selectRivals({ random: () => rolls.shift() });
  assert.equal(selected.length, 3);
  assert.equal(new Set(selected.map((rival) => rival.id)).size, 3);

  assert.throws(() => createSoloSession({
    seed: 71,
    human: { ...human, upgrades: { academics: 3, admissions: 1 } },
    rivalIds,
  }, content), /maximum|must total/i);
});

test('staged allocations are replaceable previews and confirm once with Bank normalization', () => {
  let transitions = 0;
  const controller = createSoloController({
    session: newSession(),
    content,
    onTransition: () => { transitions += 1; },
  });

  controller.startRound();
  const before = canonicalStateBytes(controller.getSession().state);
  const legal = controller.getView().legal;
  const first = legal.actions.find((item) => item.action.type !== 'bank').action;
  const replacement = legal.actions.find((item) => item.action.type !== 'bank'
    && canonicalStringify(item.action) !== canonicalStringify(first)).action;

  controller.stageAction(0, first);
  assert.deepEqual(controller.getView().stagedActions[0], first);
  controller.stageAction(0, replacement);
  assert.deepEqual(controller.getView().stagedActions[0], replacement);
  controller.clearAction(0);
  assert.equal(controller.getView().stagedActions.length, 0);
  assert.equal(canonicalStateBytes(controller.getSession().state), before);

  const result = controller.confirmAllocation();
  const actionEvent = result.events.find((event) => event.type === 'actionsResolved');
  assert.ok(actionEvent);
  assert.deepEqual(actionEvent.actions.find((action) => action.playerId === 'human'), {
    playerId: 'human',
    type: 'bank',
  });
  assert.deepEqual([...new Set(actionEvent.actions.map((action) => action.playerId))].sort(), ['human', ...rivalIds].sort());
  assert.equal(controller.getView().stagedActions.length, 0);
  assert.equal(transitions, 2);
  result.events[0].type = 'tampered';
  assert.equal(controller.getSession().history.flatMap((entry) => entry.events).some((event) => event.type === 'tampered'), false);
});

test('eliminated rivals are skipped when an allocation is confirmed', () => {
  const session = newSession();
  const eliminatedId = session.rivals[0].id;
  session.state.players.find((player) => player.id === eliminatedId).active = false;
  const controller = createSoloController({ session, content });

  controller.startRound();
  const result = controller.confirmAllocation();
  const actionEvent = result.events.find((event) => event.type === 'actionsResolved');
  assert.equal(actionEvent.actions.some((action) => action.playerId === eliminatedId), false);
  assert.equal(actionEvent.actions.some((action) => action.playerId === 'human'), true);
});

test('observations and compact history do not expose raw rival state or snapshots', () => {
  const session = newSession();
  session.state.players.find((player) => player.id === rivalIds[0]).treasury = 123.456789;
  const controller = createSoloController({ session, content });
  const viewText = JSON.stringify(controller.getView());
  assert.equal(viewText.includes('123.456789'), false);
  assert.deepEqual(Object.keys(controller.getSession().history[0].own).sort(), ['alumni', 'reputation', 'students', 'treasury']);

  const safe = normalizeHistoryEvents([
    { type: 'roundSnapshot', bytes: 'private-state-bytes' },
    { type: 'incomeResolved', players: { human: { treasury: 50 }, northbridge: { treasury: 123.456789 } } },
    { type: 'disruptionRevealed', visibility: 'private', playerIds: ['northbridge'], cardId: 'D01' },
    { type: 'disruptionRevealed', visibility: 'private', playerIds: ['human'], cardId: 'D02' },
  ], 'human');
  const safeText = JSON.stringify(safe);
  assert.equal(safeText.includes('private-state-bytes'), false);
  assert.equal(safeText.includes('123.456789'), false);
  assert.equal(safeText.includes('D01'), false);
  assert.equal(safeText.includes('playerIds'), false);
  assert.equal(safeText.includes('D02'), true);

  session.state.finished = true;
  session.state.phase = 'complete';
  session.mode = 'complete';
  const finalView = createSoloController({ session, content }).getView();
  assert.equal(finalView.finalScores.human, healthScore(session.state.players.find((player) => player.id === 'human'), content.config));
  assert.equal(finalView.finalScores[rivalIds[0]], healthScore(session.state.players.find((player) => player.id === rivalIds[0]), content.config));
});

test('AI-owned decisions settle automatically while human-owned decisions pause and resume exactly', () => {
  const aiSession = newSession(83);
  aiSession.state.players.find((player) => player.id === 'northbridge').departments.administration = 5;
  force(aiSession.state, 'fortune', 'F03', 'F04');
  force(aiSession.state, 'crisis', 'C05', 'C01');
  const ai = createSoloController({ session: aiSession, content });
  ai.startRound();
  const aiResult = ai.confirmAllocation();
  assert.ok(aiResult.events.some((event) => event.type === 'cardAwaitingDecision' && event.playerId === 'northbridge'));
  assert.notEqual(ai.getSession().state.pendingDecision?.playerId, 'northbridge');

  const humanSession = newSession(89);
  humanSession.state.players.find((player) => player.id === 'human').departments.administration = 5;
  force(humanSession.state, 'fortune', 'F03');
  force(humanSession.state, 'crisis', 'C01');
  const humanController = createSoloController({ session: humanSession, content });
  humanController.startRound();
  humanController.confirmAllocation();
  const paused = humanController.getSession();
  assert.equal(paused.state.pendingDecision.playerId, 'human');
  assert.equal(humanController.getView().legal.kind, 'decision');

  const bytes = canonicalStateBytes(paused.state);
  const cursor = paused.state.rng.cursor;
  const history = canonicalStringify(paused.history);
  const restored = createSoloController({ session: JSON.parse(JSON.stringify(paused)), content });
  assert.equal(canonicalStateBytes(restored.getSession().state), bytes);
  assert.equal(restored.getSession().state.rng.cursor, cursor);
  assert.equal(canonicalStringify(restored.getSession().history), history);
  assert.deepEqual(restored.resume().events, []);

  const command = restored.getView().legal.commands.find((candidate) => candidate.choice === 'keep');
  const resolved = restored.answerDecision(command);
  assert.ok(resolved.events.some((event) => event.type === 'cardResolved' && event.cardId === 'C01'));
  const allEvents = restored.getSession().history.flatMap((entry) => entry.events);
  assert.equal(allEvents.filter((event) => event.type === 'cardAwaitingDecision' && event.cardId === 'C01').length, 1);
  assert.equal(restored.getSession().state.rng.cursor >= cursor, true);
});

test('AI-owned forced sales auto-resolve and human-owned forced sales expose only engine commands', () => {
  const aiSession = newSession(97);
  aiSession.state.players.find((player) => player.id === 'northbridge').treasury = -100;
  const ai = createSoloController({ session: aiSession, content });
  ai.startRound();
  const aiResult = ai.confirmAllocation();
  assert.ok(aiResult.events.some((event) => event.type === 'forcedSale' && event.playerId === 'northbridge'));
  assert.notEqual(ai.getSession().state.pendingDecision?.playerId, 'northbridge');

  const playerSession = newSession(101);
  playerSession.state.players.find((player) => player.id === 'human').treasury = -100;
  const player = createSoloController({ session: playerSession, content });
  player.startRound();
  player.confirmAllocation();
  const view = player.getView();
  assert.equal(view.pendingDecision.type, 'forcedSale');
  assert.equal(view.legal.kind, 'decision');
  assert.ok(view.legal.commands.every((command) => command.playerId === 'human' && command.decision === 'forcedSale'));
});

test('the transition hook produces monotonic exact saves without repeating history or RNG', () => {
  const storage = memoryStorage();
  let revision = 0;
  let saves = 0;
  const controller = createSoloController({
    session: newSession(107),
    content,
    onTransition: (session) => {
      const saved = saveSession(storage, session, content, { expectedRevision: revision });
      assert.equal(saved.ok, true);
      revision = saved.envelope.revision;
      saves += 1;
    },
  });

  controller.startRound();
  controller.confirmAllocation();
  const current = controller.getSession();
  const loaded = loadSession(storage, content);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.envelope.revision, saves);
  assert.equal(canonicalStateBytes(loaded.envelope.session.state), canonicalStateBytes(current.state));
  assert.equal(canonicalStringify(loaded.envelope.session.history), canonicalStringify(current.history));
  assert.deepEqual(loaded.envelope.session.state.rng, current.state.rng);
  assert.deepEqual(loaded.envelope.session.rivals, current.rivals);
  assert.deepEqual(loaded.envelope.session.tutorial, current.tutorial);
});

test('spectate and skip use one rules loop and finish with byte-identical results', () => {
  const session = newSession(109);
  session.state.players.find((player) => player.id === human.id).active = false;
  session.mode = 'eliminationChoice';
  let spectate = createSoloController({ session: structuredClone(session), content });
  const skip = createSoloController({ session: structuredClone(session), content });

  const presentation = [...spectate.spectateNext().presentationEvents];
  const spectatorSave = JSON.parse(JSON.stringify(spectate.getSession()));
  assert.equal(spectatorSave.mode, 'spectating');
  spectate = createSoloController({ session: spectatorSave, content });
  let guard = 1;
  while (!spectate.getSession().state.finished) {
    guard += 1;
    assert.ok(guard < 100, 'spectated game did not finish');
    presentation.push(...spectate.spectateNext().presentationEvents);
  }
  const skipped = skip.skipRemaining();

  const watchedSession = spectate.getSession();
  const skippedSession = skip.getSession();
  assert.ok(presentation.length > 0);
  assert.deepEqual(skipped.presentationEvents, []);
  assert.equal(canonicalStateBytes(watchedSession.state), canonicalStateBytes(skippedSession.state));
  assert.equal(watchedSession.state.winnerId, skippedSession.state.winnerId);
  assert.equal(canonicalStringify(watchedSession.history), canonicalStringify(skippedSession.history));
  assert.deepEqual(watchedSession.state.rng, skippedSession.state.rng);
});

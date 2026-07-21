import { createAgent } from '../agents/index.js';
import { canonicalStringify } from '../engine/content.js';
import { advanceGame, createGame, legalActions, observeGame } from '../engine/index.js';
import { deriveSeed } from '../engine/rng.js';
import { normalizeHistoryEvents, RIVAL_SCHOOLS } from '../web/game.js';

export const DEFAULT_FOUNDING_UPGRADES = Object.freeze({
  academics: 1,
  studentAffairs: 1,
  administration: 1,
});

function requireMember(meta, userId) {
  const member = meta.humans.find((candidate) => candidate.userId === userId);
  if (!member) throw new Error('Only a match member can take that action.');
  return member;
}

function agentFor(rival) {
  return createAgent(rival.archetype, { seed: rival.agentSeed });
}

function settleAiDecisions(inputState, meta, content) {
  let state = inputState;
  const events = [];
  let guard = 0;
  while (state.phase === 'pending' && meta.rivals.some(({ id }) => id === state.pendingDecision.playerId)) {
    guard += 1;
    if (guard > 30) throw new Error('AI decision loop did not settle.');
    const rival = meta.rivals.find(({ id }) => id === state.pendingDecision.playerId);
    const result = advanceGame(
      state,
      agentFor(rival).chooseDecision(observeGame(state, rival.id, content), legalActions(state, rival.id, content)),
      content,
    );
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

export function createMatchRuntime({ seed, members }, content) {
  if (!Number.isInteger(seed)) throw new TypeError('seed: must be an integer');
  if (!Array.isArray(members) || members.length < 2 || members.length > 4) {
    throw new TypeError('members: expected two through four humans');
  }
  const seats = new Set();
  const users = new Set();
  for (const member of members) {
    if (!member || typeof member.userId !== 'string' || !member.userId) throw new TypeError('member.userId: required');
    if (typeof member.name !== 'string' || !member.name.trim()) throw new TypeError('member.name: required');
    if (!Number.isInteger(member.seat) || member.seat < 0 || member.seat > 3) throw new TypeError('member.seat: expected 0 through 3');
    if (seats.has(member.seat) || users.has(member.userId)) throw new TypeError('members: seats and users must be unique');
    seats.add(member.seat);
    users.add(member.userId);
  }

  const humans = members.map((member) => ({
    userId: member.userId,
    playerId: member.userId,
    name: member.name.trim(),
    seat: member.seat,
  })).sort((a, b) => a.seat - b.seat);
  const rivals = [];
  const players = Array.from({ length: 4 }, (_, seat) => {
    const human = humans.find((member) => member.seat === seat);
    if (human) return { id: human.playerId, name: human.name, upgrades: structuredClone(DEFAULT_FOUNDING_UPGRADES) };
    const school = RIVAL_SCHOOLS[rivals.length];
    const rival = {
      ...structuredClone(school),
      seat,
      agentSeed: deriveSeed(seed, `agent:${seat}:${school.archetype}`),
    };
    rivals.push(rival);
    return agentFor(rival).setup(rival.id, rival.name);
  });
  const created = createGame({ seed, players, programsEnabled: true }, content);
  return {
    state: created.state,
    events: created.events,
    meta: { schemaVersion: 1, humans, rivals },
  };
}

export function matchViews(state, meta, content, { submittedUserIds = [], events = [] } = {}) {
  const submitted = new Set(submittedUserIds);
  const activeHumans = meta.humans.filter(({ playerId }) => state.players.find(({ id }) => id === playerId)?.active);
  const waitingFor = state.phase === 'allocation'
    ? activeHumans.filter(({ userId }) => !submitted.has(userId)).map(({ name }) => name)
    : [];

  return Object.fromEntries(meta.humans.map((member) => {
    const observation = observeGame(state, member.playerId, content);
    const ownsDecision = state.phase === 'pending' && state.pendingDecision?.playerId === member.playerId;
    const canAllocate = state.phase === 'allocation' && observation.own.active && !submitted.has(member.userId);
    const legal = canAllocate || ownsDecision ? legalActions(state, member.playerId, content) : null;
    return [member.userId, {
      ...observation,
      legal,
      submitted: submitted.has(member.userId),
      waitingFor,
      canStartRound: state.phase === 'ready' && !state.finished,
      latestEvents: normalizeHistoryEvents(events, member.playerId),
      players: state.players.map(({ id, name, seat, active }) => ({ id, name, seat, active })),
    }];
  }));
}

export function startMatchRound(state, meta, actorUserId, content) {
  requireMember(meta, actorUserId);
  if (state.phase !== 'ready' || state.finished) throw new Error('The match is not ready to begin a term.');
  return advanceGame(state, { type: 'startRound' }, content);
}

export function validateHumanAllocation(state, meta, actorUserId, actions, content) {
  const member = requireMember(meta, actorUserId);
  if (!Array.isArray(actions)) throw new TypeError('actions: must be an array');
  const legal = legalActions(state, member.playerId, content);
  if (legal.kind !== 'allocation') throw new Error('The match is not accepting allocations.');
  if (actions.length > legal.maxActions) throw new Error(`Choose no more than ${legal.maxActions} actions.`);

  const types = new Set();
  let cost = 0;
  for (const action of actions) {
    if (action?.type === 'bank') throw new Error('Bank by leaving an action slot empty.');
    if (types.has(action?.type)) throw new Error(`Only one ${action?.type} action is allowed per term.`);
    types.add(action?.type);
    const bytes = canonicalStringify(action);
    const option = legal.actions.find((candidate) => canonicalStringify(candidate.action) === bytes);
    if (!option) throw new Error('An allocation is no longer legal.');
    cost += option.cost;
  }
  if (cost > observationTreasury(state, member.playerId) + 1e-9) throw new Error('Allocations exceed the available treasury.');
  return structuredClone(actions);
}

function observationTreasury(state, playerId) {
  return state.players.find(({ id }) => id === playerId).treasury;
}

export function resolveMatchAllocation(state, meta, submissions, content) {
  if (!(submissions instanceof Map)) throw new TypeError('submissions: expected a Map');
  const activeHumans = meta.humans.filter(({ playerId }) => state.players.find(({ id }) => id === playerId)?.active);
  const missing = activeHumans.filter(({ userId }) => !submissions.has(userId));
  if (missing.length) throw new Error(`Waiting for ${missing.map(({ name }) => name).join(', ')}.`);

  const allocations = {};
  for (const human of activeHumans) {
    allocations[human.playerId] = validateHumanAllocation(state, meta, human.userId, submissions.get(human.userId), content);
  }
  for (const rival of meta.rivals) {
    const player = state.players.find(({ id }) => id === rival.id);
    if (!player?.active) continue;
    allocations[rival.id] = agentFor(rival).chooseAllocation(
      observeGame(state, rival.id, content),
      legalActions(state, rival.id, content),
    );
  }

  const resolved = advanceGame(state, { type: 'allocate', allocations }, content);
  const decisions = settleAiDecisions(resolved.state, meta, content);
  return { state: decisions.state, events: [...resolved.events, ...decisions.events] };
}

export function resolveMatchDecision(state, meta, actorUserId, command, content) {
  const member = requireMember(meta, actorUserId);
  if (state.phase !== 'pending' || state.pendingDecision?.playerId !== member.playerId) {
    throw new Error('That player does not own the pending decision.');
  }
  const legal = legalActions(state, member.playerId, content);
  const wanted = canonicalStringify(command);
  if (!legal.commands.some((candidate) => canonicalStringify(candidate) === wanted)) {
    throw new Error('That decision is no longer legal.');
  }
  const resolved = advanceGame(state, command, content);
  const decisions = settleAiDecisions(resolved.state, meta, content);
  return { state: decisions.state, events: [...resolved.events, ...decisions.events] };
}

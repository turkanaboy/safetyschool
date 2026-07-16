import { createAgent } from '../agents/index.js';
import { canonicalStringify } from '../engine/content.js';
import { advanceGame, createGame, legalActions, observeGame } from '../engine/index.js';
import { deriveSeed } from '../engine/rng.js';

export const RIVAL_SCHOOLS = Object.freeze([
  Object.freeze({ id: 'northbridge', name: 'Northbridge University', archetype: 'prestigePlay' }),
  Object.freeze({ id: 'saint-cadmus', name: 'Saint Cadmus College', archetype: 'fortress' }),
  Object.freeze({ id: 'westlake', name: 'Westlake University', archetype: 'gambler' }),
  Object.freeze({ id: 'regional-state', name: 'Regional State', archetype: 'steadyHand' }),
  Object.freeze({ id: 'bellwether', name: 'Bellwether Institute', archetype: 'oracle' }),
]);

const PUBLIC_RIVAL_EVENT_FIELDS = new Set([
  'type', 'playerId', 'cardId', 'kind', 'target', 'outcome', 'department', 'program',
  'targetPlayerId', 'reason', 'winnerId', 'round', 'year', 'roundOfYear', 'stage',
  'visibility', 'choice', 'effectiveSeverity', 'effectTypes', 'skippedEffects',
]);

function assertText(value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${path}: must be a non-empty string`);
}

function rivalById(id) {
  return RIVAL_SCHOOLS.find((rival) => rival.id === id);
}

export function selectRivals({ ids, random = Math.random } = {}) {
  if (ids !== undefined) {
    if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3) {
      throw new TypeError('rivalIds: expected three distinct schools');
    }
    return ids.map((id) => {
      const rival = rivalById(id);
      if (!rival) throw new TypeError(`rivalIds: unknown school ${id}`);
      return structuredClone(rival);
    });
  }

  const pool = RIVAL_SCHOOLS.map((rival) => structuredClone(rival));
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const value = random();
    if (!(value >= 0 && value < 1)) throw new TypeError('random: expected a value from 0 through less than 1');
    const swapIndex = Math.floor(value * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return pool.slice(0, 3);
}

function publicRivalEvent(event) {
  return Object.fromEntries(Object.entries(event)
    .filter(([key]) => PUBLIC_RIVAL_EVENT_FIELDS.has(key))
    .map(([key, value]) => [key, structuredClone(value)]));
}

export function normalizeHistoryEvents(events, humanId) {
  const normalized = [];
  for (const event of events) {
    if (event.type === 'roundSnapshot') continue;
    if (event.type === 'disruptionRevealed' && event.visibility === 'private') {
      if (!event.playerIds.includes(humanId)) continue;
      const ownReveal = structuredClone(event);
      delete ownReveal.playerIds;
      normalized.push(ownReveal);
      continue;
    }
    if (event.type === 'incomeResolved' || event.type === 'recruitingResolved') {
      const own = event.players?.[humanId];
      normalized.push({
        type: event.type,
        ...(own ? { players: { [humanId]: structuredClone(own) } } : {}),
      });
      continue;
    }
    if (event.type === 'healthScoresComputed') {
      normalized.push({ type: event.type });
      continue;
    }
    if (event.type === 'playersEliminated') {
      normalized.push({ type: event.type, stage: event.stage, playerIds: [...event.playerIds] });
      continue;
    }
    if (event.playerId && event.playerId !== humanId) {
      normalized.push(publicRivalEvent(event));
      continue;
    }

    const safe = structuredClone(event);
    delete safe.roll;
    delete safe.targetRngValue;
    delete safe.targetWeights;
    delete safe.cursorAfter;
    normalized.push(safe);
  }
  return normalized;
}

function historyEntry(state, events, humanId) {
  return {
    round: state.round,
    events: normalizeHistoryEvents(events, humanId),
  };
}

function agentFor(rival) {
  return createAgent(rival.archetype, { seed: rival.agentSeed });
}

export function createSoloSession({ seed, human, rivalIds, random = Math.random }, content) {
  if (!Number.isInteger(seed)) throw new TypeError('seed: must be an integer');
  if (!human || typeof human !== 'object') throw new TypeError('human: must be an object');
  for (const field of ['id', 'name', 'mascot', 'color']) assertText(human[field], `human.${field}`);

  const rivals = selectRivals({ ids: rivalIds, random }).map((rival, index) => ({
    ...rival,
    agentSeed: deriveSeed(seed, `agent:${index + 1}:${rival.archetype}`),
  }));
  const players = [
    { id: human.id, name: human.name, upgrades: structuredClone(human.upgrades) },
    ...rivals.map((rival) => agentFor(rival).setup(rival.id, rival.name)),
  ];
  const created = createGame({ seed, players, programsEnabled: true }, content);
  const session = {
    state: created.state,
    human: structuredClone(human),
    rivals,
    tutorial: { step: 'campus' },
    history: [],
    stagedActions: [],
    mode: 'playing',
  };
  session.history.push(historyEntry(session.state, created.events, human.id));
  return session;
}

function actionOption(legal, action) {
  const bytes = canonicalStringify(action);
  return legal.actions.find((option) => canonicalStringify(option.action) === bytes);
}

export function createSoloController({ session: initialSession, content, onTransition = null }) {
  const session = structuredClone(initialSession);
  const humanId = session.human.id;
  let commandCount = 0;

  const humanPlayer = () => session.state.players.find((player) => player.id === humanId);

  function updateMode() {
    if (session.state.finished) {
      session.mode = 'complete';
    } else if (!humanPlayer().active && session.mode === 'playing') {
      session.mode = 'eliminationChoice';
    }
  }

  function apply(command, present = true) {
    commandCount += 1;
    if (commandCount > 300) throw new Error('Solo session exceeded the 300-command safety limit');
    const result = advanceGame(session.state, command, content);
    session.state = result.state;
    const safeEvents = normalizeHistoryEvents(result.events, humanId);
    session.history.push({ round: session.state.round, events: safeEvents });
    updateMode();
    if (onTransition) onTransition(structuredClone(session));
    const emittedEvents = structuredClone(safeEvents);
    return {
      events: emittedEvents,
      presentationEvents: present ? structuredClone(safeEvents) : [],
    };
  }

  function aiPending(present = true) {
    const aggregate = { events: [], presentationEvents: [] };
    let guard = 0;
    while (session.state.phase === 'pending' && session.state.pendingDecision.playerId !== humanId) {
      guard += 1;
      if (guard > 30) throw new Error('AI decision loop did not settle');
      const rival = session.rivals.find((candidate) => candidate.id === session.state.pendingDecision.playerId);
      if (!rival) throw new Error(`No rival metadata for ${session.state.pendingDecision.playerId}`);
      const agent = agentFor(rival);
      const observation = observeGame(session.state, rival.id, content);
      const legal = legalActions(session.state, rival.id, content);
      const step = apply(agent.chooseDecision(observation, legal), present);
      aggregate.events.push(...step.events);
      aggregate.presentationEvents.push(...step.presentationEvents);
    }
    return aggregate;
  }

  function allocations(humanActions = null) {
    const result = {};
    if (humanPlayer().active && humanActions !== null) result[humanId] = structuredClone(humanActions);
    for (const rival of session.rivals) {
      const player = session.state.players.find((candidate) => candidate.id === rival.id);
      if (!player?.active) continue;
      const observation = observeGame(session.state, rival.id, content);
      const legal = legalActions(session.state, rival.id, content);
      result[rival.id] = agentFor(rival).chooseAllocation(observation, legal);
    }
    return result;
  }

  function settleAllocation(humanActions, present = true) {
    const first = apply({ type: 'allocate', allocations: allocations(humanActions) }, present);
    const decisions = aiPending(present);
    return {
      events: [...first.events, ...decisions.events],
      presentationEvents: [...first.presentationEvents, ...decisions.presentationEvents],
    };
  }

  function oneRivalTerm(present) {
    const aggregate = { events: [], presentationEvents: [] };
    let started = false;
    let guard = 0;
    while (!session.state.finished) {
      guard += 1;
      if (guard > 40) throw new Error('Rival term did not settle');
      if (session.state.phase === 'ready') {
        if (started) break;
        const step = apply({ type: 'startRound' }, present);
        aggregate.events.push(...step.events);
        aggregate.presentationEvents.push(...step.presentationEvents);
        started = true;
      } else if (session.state.phase === 'allocation') {
        const step = settleAllocation(null, present);
        aggregate.events.push(...step.events);
        aggregate.presentationEvents.push(...step.presentationEvents);
        started = true;
      } else if (session.state.phase === 'pending') {
        const step = aiPending(present);
        aggregate.events.push(...step.events);
        aggregate.presentationEvents.push(...step.presentationEvents);
        started = true;
      } else {
        throw new Error(`Unsupported game phase ${session.state.phase}`);
      }
    }
    return aggregate;
  }

  function getView() {
    const observation = observeGame(session.state, humanId, content);
    let legal = null;
    if (humanPlayer().active && (session.state.phase === 'allocation'
      || session.state.pendingDecision?.playerId === humanId)) {
      legal = legalActions(session.state, humanId, content);
    }
    return {
      ...observation,
      legal,
      stagedActions: structuredClone(session.stagedActions),
      mode: session.mode,
    };
  }

  updateMode();
  return {
    getSession: () => structuredClone(session),
    getView,
    startRound() {
      if (session.mode !== 'playing' || session.state.phase !== 'ready') throw new Error('The game is not ready to start a round');
      return apply({ type: 'startRound' });
    },
    stageAction(slot, action) {
      if (session.mode !== 'playing' || session.state.phase !== 'allocation') throw new Error('The game is not accepting allocations');
      const legal = legalActions(session.state, humanId, content);
      if (!Number.isInteger(slot) || slot < 0 || slot >= legal.maxActions) throw new TypeError('slot is outside the allocation limit');
      const option = actionOption(legal, action);
      if (!option || action.type === 'bank') throw new TypeError('action is not currently legal');
      const next = [...session.stagedActions];
      next[slot] = structuredClone(action);
      const staged = next.filter(Boolean);
      if (new Set(staged.map((candidate) => candidate.type)).size !== staged.length) {
        throw new TypeError(`duplicate ${action.type} action`);
      }
      const spend = staged.reduce((total, candidate) => total + actionOption(legal, candidate).cost, 0);
      if (spend > humanPlayer().treasury + 1e-9) throw new TypeError('staged actions exceed the available treasury');
      session.stagedActions = next;
      return getView();
    },
    clearAction(slot) {
      if (session.mode !== 'playing' || session.state.phase !== 'allocation') throw new Error('The game is not accepting allocations');
      if (!Number.isInteger(slot) || slot < 0) throw new TypeError('slot must be a non-negative integer');
      session.stagedActions.splice(slot, 1, undefined);
      while (session.stagedActions.length > 0 && session.stagedActions.at(-1) === undefined) {
        session.stagedActions.pop();
      }
      return getView();
    },
    confirmAllocation() {
      if (session.mode !== 'playing' || session.state.phase !== 'allocation') throw new Error('The game is not accepting allocations');
      const chosen = session.stagedActions.filter(Boolean);
      const legal = legalActions(session.state, humanId, content);
      for (const action of chosen) {
        if (!actionOption(legal, action)) throw new TypeError('a staged action is no longer legal');
      }
      session.stagedActions = [];
      return settleAllocation(chosen);
    },
    answerDecision(command) {
      if (session.mode !== 'playing' || session.state.pendingDecision?.playerId !== humanId) {
        throw new Error('The player does not own a pending decision');
      }
      const legal = legalActions(session.state, humanId, content);
      const wanted = canonicalStringify(command);
      if (!legal.commands.some((candidate) => canonicalStringify(candidate) === wanted)) {
        throw new TypeError('decision is not currently legal');
      }
      const first = apply(command);
      const decisions = aiPending();
      return {
        events: [...first.events, ...decisions.events],
        presentationEvents: [...first.presentationEvents, ...decisions.presentationEvents],
      };
    },
    resume() {
      return aiPending();
    },
    spectateNext() {
      if (humanPlayer().active || !['eliminationChoice', 'spectating'].includes(session.mode)) {
        throw new Error('Spectating is only available after elimination');
      }
      session.mode = 'spectating';
      return oneRivalTerm(true);
    },
    skipRemaining() {
      if (humanPlayer().active || !['eliminationChoice', 'spectating', 'skipping'].includes(session.mode)) {
        throw new Error('Skipping is only available after elimination');
      }
      session.mode = 'skipping';
      const aggregate = { events: [], presentationEvents: [] };
      let guard = 0;
      while (!session.state.finished) {
        guard += 1;
        if (guard > 100) throw new Error('Skipped game did not finish');
        const step = oneRivalTerm(false);
        aggregate.events.push(...step.events);
      }
      return aggregate;
    },
  };
}

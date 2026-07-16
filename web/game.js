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

function departmentCostMultiplier(department, config) {
  return config.departmentCostCurve.costMultipliers[department]
    ?? config.departmentCostCurve.costMultipliers.default;
}

function computedUpgradeCost(level, department, config) {
  const cumulative = config.departmentCostCurve.buildCostToReachLevel;
  const current = level === config.startingState.allDepartmentsLevel ? 0 : cumulative[level];
  return (cumulative[level + 1] - current) * departmentCostMultiplier(department, config);
}

export function buildingManagement(view, department, content) {
  if (!Object.hasOwn(view.own.departments, department)) throw new TypeError(`department: unknown ${department}`);
  const config = content.config;
  const level = view.own.departments[department];
  const maxLevel = Math.max(...Object.keys(config.departmentCostCurve.upkeepAtLevel).map(Number));
  const nextLevel = level < maxLevel ? level + 1 : null;
  const allocation = view.legal?.kind === 'allocation' ? view.legal : null;
  const upgrade = allocation?.actions.find((option) => option.action.type === 'upgrade'
    && option.action.department === department) ?? null;
  const sell = allocation?.actions.find((option) => option.action.type === 'sell'
    && option.action.department === department) ?? null;
  const baseUpkeepChange = nextLevel === null ? 0 : (
    config.departmentCostCurve.upkeepAtLevel[nextLevel] - config.departmentCostCurve.upkeepAtLevel[level]
  ) * departmentCostMultiplier(department, config);
  const upgradeCost = nextLevel === null ? null : (upgrade?.cost ?? computedUpgradeCost(level, department, config));

  let upgradeReason = null;
  if (nextLevel === null) upgradeReason = 'This department is fully developed at Level 5.';
  else if (department === 'admissions' && view.roundOfYear !== config.gameLength.yearEndRound) {
    upgradeReason = `Admissions upgrades are available in Term ${config.gameLength.yearEndRound}.`;
  } else if (view.phase !== 'allocation') upgradeReason = 'Begin the next term to plan an upgrade.';
  else if (!upgrade && upgradeCost > view.own.treasury) upgradeReason = 'The current treasury cannot cover this upgrade.';
  else if (!upgrade) upgradeReason = 'This upgrade is not available in the current term.';

  return {
    department,
    level,
    maxLevel,
    nextLevel,
    upgrade,
    sell,
    upgradeCost,
    baseUpkeepChange,
    upgradeReason,
  };
}

function stagedUpkeepChange(action, option, view, config) {
  if (action.type === 'upgrade') {
    const level = view.own.departments[action.department];
    return (config.departmentCostCurve.upkeepAtLevel[level + 1]
      - config.departmentCostCurve.upkeepAtLevel[level]) * departmentCostMultiplier(action.department, config);
  }
  if (action.type === 'sell') return -option.upkeepSaved;
  if (action.type === 'openProgram') return config.programs.catalog[action.program].upkeepPerRound;
  return 0;
}

export function allocationSummary(view, content) {
  const legal = view.legal?.kind === 'allocation' ? view.legal : null;
  const maxActions = legal?.maxActions ?? content.config.allocation.maxActionsPerRound;
  const staged = view.stagedActions.filter(Boolean);
  let committedSpend = 0;
  let saleRecovery = 0;
  let baseUpkeepChange = 0;
  for (const action of staged) {
    const option = actionOption(legal, action);
    if (!option) throw new TypeError('staged action is not currently legal');
    committedSpend += option.cost;
    saleRecovery += option.recovery ?? 0;
    baseUpkeepChange += stagedUpkeepChange(action, option, view, content.config);
  }
  return {
    maxActions,
    bonusSlots: Math.max(0, maxActions - content.config.allocation.maxActionsPerRound),
    slots: Array.from({ length: maxActions }, (_, index) => ({
      index,
      action: view.stagedActions[index] ? structuredClone(view.stagedActions[index]) : null,
      bonus: index >= content.config.allocation.maxActionsPerRound,
    })),
    committedSpend,
    saleRecovery,
    projectedTreasury: view.own.treasury - committedSpend + saleRecovery,
    baseUpkeepChange,
    bankSlots: maxActions - staged.length,
  };
}

export function programManagement(view, content) {
  const slotCount = content.config.programs.slotsByAcademicsLevel[view.own.departments.academics];
  const available = view.legal?.kind === 'allocation'
    ? view.legal.actions.filter((option) => option.action.type === 'openProgram').map((option) => structuredClone(option))
    : [];
  return {
    slotCount,
    openSlots: Math.max(0, slotCount - view.own.programs.length),
    current: view.own.programs.map((program) => ({ program, ...structuredClone(content.config.programs.catalog[program]) })),
    available,
  };
}

export function rivalProfile(view, rivalId) {
  const rival = view.opponents.find((candidate) => candidate.id === rivalId);
  if (!rival) throw new TypeError(`rivalId: unknown ${rivalId}`);
  const identity = view.lineup.find((candidate) => candidate.id === rivalId);
  const recentEvents = [];
  for (const entry of view.history) {
    for (const event of entry.events) {
      if (event.playerId === rivalId) recentEvents.push(structuredClone(event));
      if (event.type === 'actionsResolved') {
        for (const action of event.actions.filter((candidate) => candidate.playerId === rivalId)) {
          recentEvents.push({ type: 'actionResolved', ...structuredClone(action) });
        }
      }
      if (event.type === 'playersEliminated' && event.playerIds.includes(rivalId)) {
        recentEvents.push({ type: event.type, playerId: rivalId, stage: event.stage });
      }
    }
  }
  return {
    ...structuredClone(rival),
    archetype: identity.archetype,
    recentEvents: recentEvents.slice(-8),
  };
}

export function dumpScore(standing) {
  const departmentLevels = Object.values(standing.departments).reduce((total, level) => total + level, 0);
  return standing.students * 0.01 + standing.reputation + departmentLevels * 5
    + standing.programs.length * 5 + standing.alumni * 0.002;
}

export function dumpRankings(view) {
  const names = new Map([[view.own.id, view.own.name], ...view.opponents.map((rival) => [rival.id, rival.name])]);
  if (!view.standings) {
    return [view.own, ...view.opponents].map((school) => ({
      id: school.id,
      name: school.name,
      rank: null,
      score: null,
      closed: school.active === false,
    }));
  }
  const scored = view.standings.map((standing, index) => ({
    id: standing.playerId,
    name: names.get(standing.playerId) ?? standing.playerId,
    active: standing.active,
    score: standing.active ? dumpScore(standing) : null,
    order: index,
  }));
  const active = scored.filter((school) => school.active).sort((a, b) => b.score - a.score || a.order - b.order);
  let previousScore = null;
  let previousRank = null;
  active.forEach((school, index) => {
    school.rank = school.score === previousScore ? previousRank : index + 1;
    previousScore = school.score;
    previousRank = school.rank;
  });
  return [...active.map(({ active: _active, order: _order, ...school }) => ({ ...school, closed: false })),
    ...scored.filter((school) => !school.active).map((school) => ({
      id: school.id,
      name: school.name,
      rank: null,
      score: null,
      closed: true,
    }))];
}

function historyEntry(state, safeEvents, humanId) {
  const own = state.players.find((player) => player.id === humanId);
  return {
    round: state.round,
    events: structuredClone(safeEvents),
    own: {
      treasury: own.treasury,
      students: own.students,
      reputation: own.reputation,
      alumni: own.alumni,
    },
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
    tutorial: {
      setupDismissed: false,
      allocationDismissed: false,
      cardDismissed: false,
      reportDismissed: false,
    },
    history: [],
    stagedActions: [],
    mode: 'playing',
  };
  session.history.push(historyEntry(session.state, normalizeHistoryEvents(created.events, human.id), human.id));
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

  function notify() {
    if (onTransition) onTransition(structuredClone(session));
  }

  function apply(command, present = true) {
    commandCount += 1;
    if (commandCount > 300) throw new Error('Solo session exceeded the 300-command safety limit');
    const result = advanceGame(session.state, command, content);
    session.state = result.state;
    const safeEvents = normalizeHistoryEvents(result.events, humanId);
    session.history.push(historyEntry(session.state, safeEvents, humanId));
    updateMode();
    notify();
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
      identity: structuredClone(session.human),
      lineup: session.rivals.map(({ agentSeed: _agentSeed, ...rival }) => structuredClone(rival)),
      standings: session.state.standings ? structuredClone(session.state.standings) : null,
      history: structuredClone(session.history),
      tutorial: structuredClone(session.tutorial),
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
    dismissTutorial(moment) {
      if (!['setup', 'allocation', 'card', 'report'].includes(moment)) throw new TypeError(`tutorial moment: unknown ${moment}`);
      if (session.tutorial[`${moment}Dismissed`]) return getView();
      session.tutorial[`${moment}Dismissed`] = true;
      notify();
      return getView();
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

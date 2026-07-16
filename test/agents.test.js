import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_TYPES, createAgent } from '../agents/index.js';
import { advanceGame, createGame, legalActions, observeGame } from '../engine/index.js';
import { loadContent } from '../engine/content.js';

const content = loadContent();
const scripted = AGENT_TYPES.filter((type) => type !== 'random');

test('scripted setup identities match the documented strategy cores', () => {
  const expected = {
    steadyHand: { admissions: 2, studentAffairs: 1 },
    gambler: { athletics: 2, admissions: 1 },
    prestigePlay: { academics: 2, admissions: 1 },
    fortress: { studentAffairs: 2, admissions: 1 },
    oracle: { administration: 2, admissions: 1 },
  };
  for (const type of scripted) {
    assert.deepEqual(createAgent(type, { seed: 1 }).setup('p1', 'Test U').upgrades, expected[type]);
  }
});

test('observations expose own private state and only public opponent information', () => {
  const players = [
    createAgent('oracle', { seed: 1 }).setup('p1', 'Oracle U'),
    createAgent('gambler', { seed: 2 }).setup('p2', 'Gambler U'),
  ];
  const { state } = createGame({ seed: 3, players, programsEnabled: true }, content);
  state.players[0].departments.administration = 3;
  state.disruptions.privateByPlayer = { p1: { 3: 'D03' } };
  state.players[1].treasury = 123.45;
  const observation = observeGame(state, 'p1', content);
  assert.equal(observation.own.treasury, state.players[0].treasury);
  assert.equal('treasury' in observation.opponents[0], false);
  assert.equal(observation.privateDisruptions['3'], 'D03');
  assert.equal(JSON.stringify(observation).includes('123.45'), false);
});

test('agents choose legal allocations under constrained game states', () => {
  for (const type of AGENT_TYPES) {
    const agent = createAgent(type, { seed: 90 });
    const opponent = createAgent('steadyHand', { seed: 91 });
    let { state } = createGame({
      seed: 10,
      players: [agent.setup('p1', 'Agent U'), opponent.setup('p2', 'Other U')],
      programsEnabled: false,
    }, content);
    state.players[0].treasury = 1;
    state.players[0].effects.campaignBlockedNextRound = true;
    state = advanceGame(state, { type: 'startRound' }, content).state;
    const observation = observeGame(state, 'p1', content);
    const legal = legalActions(state, 'p1', content);
    const actions = agent.chooseAllocation(observation, legal);
    assert.ok(actions.length <= legal.maxActions);
    assert.ok(actions.every((action) => legal.actions.some((option) => JSON.stringify(option.action) === JSON.stringify(action))));
    assert.equal(actions.some((action) => action.type === 'openProgram' || action.type === 'campaign'), false);
  }
});

test('Admin and forced-sale decisions follow the default heuristics', () => {
  const oracle = createAgent('oracle', { seed: 8 });
  assert.equal(oracle.chooseDecision({ pendingDecision: { type: 'adminCrisis', playerId: 'p1', effectiveSeverity: 1 } }, { kind: 'decision',
    commands: [
      { type: 'decision', decision: 'adminCrisis', playerId: 'p1', choice: 'cancel' },
      { type: 'decision', decision: 'adminCrisis', playerId: 'p1', choice: 'keep' },
    ],
  }).choice, 'keep');
  assert.equal(oracle.chooseDecision({ pendingDecision: { type: 'adminCrisis', playerId: 'p1', effectiveSeverity: 2 } }, { kind: 'decision',
    commands: [
      { type: 'decision', decision: 'adminCrisis', playerId: 'p1', choice: 'cancel' },
      { type: 'decision', decision: 'adminCrisis', playerId: 'p1', choice: 'keep' },
    ],
  }).choice, 'cancel');

  const sale = oracle.chooseDecision({ pendingDecision: { type: 'forcedSale', playerId: 'p1' } }, { kind: 'decision',
    commands: [
      { type: 'decision', decision: 'forcedSale', playerId: 'p1', department: 'administration', recovery: 10, upkeepSaved: 4 },
      { type: 'decision', decision: 'forcedSale', playerId: 'p1', department: 'marketing', recovery: 8, upkeepSaved: 2 },
    ],
  });
  assert.equal(sale.department, 'marketing', 'Oracle protects its core Administration department');
});

test('policies do not depend on injected opponent treasury or another player secret', () => {
  const agentA = createAgent('steadyHand', { seed: 5 });
  const agentB = createAgent('steadyHand', { seed: 5 });
  const players = [agentA.setup('p1', 'A'), createAgent('gambler', { seed: 6 }).setup('p2', 'B')];
  let { state } = createGame({ seed: 7, players, programsEnabled: true }, content);
  state = advanceGame(state, { type: 'startRound' }, content).state;
  const observation = observeGame(state, 'p1', content);
  const injected = structuredClone(observation);
  injected.opponents[0].treasury = 999;
  injected.privateDisruptions['99'] = 'D12';
  const options = legalActions(state, 'p1', content);
  assert.deepEqual(agentA.chooseAllocation(observation, options), agentB.chooseAllocation(injected, options));
});

test('Random policy is reproducible and never consumes game RNG', () => {
  const a = createAgent('random', { seed: 1234 });
  const b = createAgent('random', { seed: 1234 });
  const setupA = a.setup('p1', 'Random U');
  const setupB = b.setup('p1', 'Random U');
  assert.deepEqual(setupA, setupB);
  const players = [setupA, createAgent('steadyHand', { seed: 2 }).setup('p2', 'Other U')];
  let { state } = createGame({ seed: 22, players, programsEnabled: true }, content);
  state = advanceGame(state, { type: 'startRound' }, content).state;
  const cursor = state.rng.cursor;
  const observation = observeGame(state, 'p1', content);
  const options = legalActions(state, 'p1', content);
  const first = a.chooseAllocation(observation, options);
  const second = b.chooseAllocation(observation, options);
  assert.deepEqual(first, second);
  assert.equal(state.rng.cursor, cursor);
});

test('all policies complete seeded smoke games without illegal commands', () => {
  for (const count of [2, 3, 4, 5]) {
    const agents = Array.from({ length: count }, (_, seat) => createAgent(AGENT_TYPES[seat], { seed: 1000 + count * 10 + seat }));
    let { state } = createGame({
      seed: 2000 + count,
      players: agents.map((agent, seat) => agent.setup(`p${seat + 1}`, `University ${seat + 1}`)),
      programsEnabled: count % 2 === 0,
    }, content);
    let commands = 0;
    while (!state.finished) {
      commands += 1;
      assert.ok(commands < 300, `stalled ${count}-player game`);
      if (state.phase === 'ready') {
        state = advanceGame(state, { type: 'startRound' }, content).state;
      } else if (state.phase === 'allocation') {
        const allocations = {};
        for (const player of state.players.filter((candidate) => candidate.active)) {
          const agent = agents[player.seat];
          allocations[player.id] = agent.chooseAllocation(observeGame(state, player.id, content), legalActions(state, player.id, content));
        }
        state = advanceGame(state, { type: 'allocate', allocations }, content).state;
      } else {
        const player = state.players.find((candidate) => candidate.id === state.pendingDecision.playerId);
        const agent = agents[player.seat];
        const command = agent.chooseDecision(observeGame(state, player.id, content), legalActions(state, player.id, content));
        state = advanceGame(state, command, content).state;
      }
    }
    assert.ok(state.round <= content.config.simulationAcceptanceCriteria.maxGameRounds);
    assert.ok(state.winnerId);
  }
});

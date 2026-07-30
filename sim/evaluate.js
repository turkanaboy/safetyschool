import { createAgent, POLICY_VERSION } from '../agents/index.js';
import { canonicalStringify } from '../engine/content.js';
import {
  advanceGame, createGame, ENGINE_VERSION, legalActions, observeGame, STATE_SCHEMA_VERSION,
} from '../engine/index.js';
import { deriveSeed } from '../engine/rng.js';
import { REPLAY_SCHEMA_VERSION } from './replay.js';

function applyCommand(state, command, content, capture, commands, checkpoints, events) {
  const result = advanceGame(state, command, content);
  if (capture) {
    commands.push(structuredClone(command));
    checkpoints.push({
      stateDigest: content.digest(result.state),
      eventDigest: content.digest(result.events),
      rngBytes: canonicalStringify(result.state.rng),
    });
    events.push(...result.events);
  }
  return result.state;
}

export function runGame({ seed, lineup, programsEnabled, content, captureReplay = false }) {
  const agents = lineup.map((type, seat) => createAgent(type, { seed: deriveSeed(seed, `agent:${seat}:${type}`) }));
  const setup = {
    seed,
    players: agents.map((agent, seat) => agent.setup(`p${seat + 1}`, `${agent.type} ${seat + 1}`)),
    programsEnabled,
  };
  const created = createGame(setup, content);
  let state = created.state;
  const commands = [];
  const checkpoints = [];
  const events = captureReplay ? [...created.events] : [];
  let guard = 0;

  while (!state.finished) {
    guard += 1;
    if (guard > 300) throw new Error('game exceeded 300 engine commands');
    if (state.phase === 'ready') {
      state = applyCommand(state, { type: 'startRound' }, content, captureReplay, commands, checkpoints, events);
      continue;
    }
    if (state.phase === 'allocation') {
      const allocations = {};
      for (const player of state.players.filter((candidate) => candidate.active)) {
        allocations[player.id] = agents[player.seat].chooseAllocation(
          observeGame(state, player.id, content),
          legalActions(state, player.id, content),
        );
      }
      state = applyCommand(state, { type: 'allocate', allocations }, content, captureReplay, commands, checkpoints, events);
      continue;
    }
    if (state.phase === 'pending') {
      const player = state.players.find((candidate) => candidate.id === state.pendingDecision.playerId);
      const command = agents[player.seat].chooseDecision(
        observeGame(state, player.id, content),
        legalActions(state, player.id, content),
      );
      state = applyCommand(state, command, content, captureReplay, commands, checkpoints, events);
      continue;
    }
    throw new Error(`unresolvable phase ${state.phase}`);
  }

  const winner = state.players.find((player) => player.id === state.winnerId);
  const austerityEntrants = state.players.filter((player) => player.enteredAusterity);
  const summary = {
    seed,
    programsEnabled,
    playerCount: lineup.length,
    lineup: [...lineup],
    winnerId: winner.id,
    winnerType: lineup[winner.seat],
    winnerPrograms: [...winner.programs],
    round: state.round,
    endReason: state.endReason,
    austerityEntrants: austerityEntrants.length,
    austeritySurvivors: austerityEntrants.filter((player) => player.active).length,
    replayOk: null,
    finalStateDigest: content.digest(state),
  };

  const replayLog = captureReplay ? {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    identity: {
      ...content.identity,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      policyVersion: POLICY_VERSION,
      policyDigest: content.digest(POLICY_VERSION),
    },
    setup: structuredClone(setup),
    commands,
    checkpoints,
    expected: {
      stateBytes: canonicalStringify(state),
      eventBytes: canonicalStringify(events),
      rngBytes: canonicalStringify(state.rng),
    },
  } : null;
  return { summary, replayLog, state };
}

export function runPublishSmoke(content) {
  return [
    { seed: 1701, lineup: ['steadyHand', 'gambler', 'prestigePlay', 'random'], programsEnabled: true },
    { seed: 1702, lineup: ['fortress', 'oracle', 'steadyHand', 'random'], programsEnabled: false },
    { seed: 1703, lineup: ['prestigePlay', 'gambler', 'fortress', 'random'], programsEnabled: true },
  ].map((game) => runGame({ ...game, content }).summary);
}

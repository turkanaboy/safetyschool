import {
  createMatchRuntime,
  matchViews,
  resolveMatchAllocation,
  resolveMatchDecision,
  startMatchRound,
  validateHumanAllocation,
} from './runtime.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value, name) {
  if (!UUID.test(String(value ?? ''))) throw new Error(`${name} must be a valid identifier.`);
  return value;
}

function profileOf(member) {
  return Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
}

function seedValue() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function requestId() {
  return crypto.randomUUID();
}

function seatPayload(state, meta) {
  return state.players.map((player) => {
    const human = meta.humans.find(({ playerId }) => playerId === player.id);
    return {
      userId: human?.userId ?? '',
      playerId: player.id,
      seat: player.seat,
      name: player.name,
      isHuman: Boolean(human),
    };
  });
}

export function createMatchService({ content, store, randomSeed = seedValue, randomId = requestId }) {
  if (!content?.config || !store) throw new TypeError('content and store are required');

  async function current(matchId, userId) {
    const view = await store.getView(matchId, userId);
    if (!view) throw new Error('Match view is unavailable.');
    return view;
  }

  async function transition(runtime, userId, id, command, result) {
    const views = matchViews(result.state, runtime.snapshot.meta, content, { events: result.events });
    await store.commitTransition({
      matchId: runtime.match.id,
      expectedVersion: runtime.match.version,
      requestId: id,
      actorUserId: userId,
      command,
      state: result.state,
      meta: runtime.snapshot.meta,
      events: result.events,
      views,
      status: result.state.finished ? 'complete' : 'active',
      winnerPlayerId: result.state.winnerId,
    });
    return current(runtime.match.id, userId);
  }

  return {
    async handle(userId, body) {
      requireUuid(userId, 'userId');
      if (!body || typeof body !== 'object') throw new Error('A command body is required.');

      if (body.action === 'start') {
        const lobbyId = requireUuid(body.lobbyId, 'lobbyId');
        const lobby = await store.getLobby(lobbyId);
        if (!lobby || lobby.status !== 'waiting') throw new Error('That lobby is no longer waiting.');
        if (lobby.host_user_id !== userId) throw new Error('Only the lobby host can start the match.');
        const members = lobby.lobby_members ?? [];
        if (members.length < 2 || !members.every(({ is_ready }) => is_ready)) {
          throw new Error('At least two humans must join and every human must be ready.');
        }
        const created = createMatchRuntime({
          seed: randomSeed(),
          members: members.map((member) => ({
            userId: member.user_id,
            seat: member.seat_index,
            name: profileOf(member)?.display_name ?? 'President',
          })),
        }, content);
        const views = matchViews(created.state, created.meta, content, { events: created.events });
        const match = await store.startMatch({
          lobbyId,
          hostUserId: userId,
          seed: created.state.seed,
          state: created.state,
          meta: created.meta,
          seats: seatPayload(created.state, created.meta),
          views,
        });
        return current(match.id, userId);
      }

      const matchId = requireUuid(body.matchId, 'matchId');
      const id = requireUuid(body.requestId, 'requestId');
      const previous = await store.getRequest(matchId, id);
      let runtime;
      let submittedActions = body.actions;
      if (previous) {
        if (previous.actor_user_id && previous.actor_user_id !== userId) {
          throw new Error('That request identifier belongs to another player.');
        }
        if (body.action !== 'submitAllocation' || previous.command?.type !== 'submitAllocation') {
          return current(matchId, userId);
        }
        runtime = await store.getRuntime(matchId);
        if (runtime.match.version !== previous.version_before || runtime.snapshot.state.phase !== 'allocation') {
          return current(matchId, userId);
        }
        submittedActions = previous.command.actions;
      }
      runtime ??= await store.getRuntime(matchId);
      if (!runtime || runtime.match.status !== 'active') return current(matchId, userId);

      if (body.action === 'beginTerm') {
        if (runtime.snapshot.state.phase !== 'ready' || runtime.snapshot.state.finished) {
          return current(matchId, userId);
        }
        return transition(
          runtime,
          userId,
          id,
          { type: 'startRound' },
          startMatchRound(runtime.snapshot.state, runtime.snapshot.meta, userId, content),
        );
      }

      if (body.action === 'submitAllocation') {
        const actions = validateHumanAllocation(
          runtime.snapshot.state,
          runtime.snapshot.meta,
          userId,
          submittedActions,
          content,
        );
        const stored = await store.storeSubmission({
          matchId,
          expectedVersion: runtime.match.version,
          userId,
          requestId: id,
          actions,
        });
        const submissions = new Map(stored.submissions.map((submission) => [submission.userId, submission.actions]));
        const activeHumanIds = runtime.snapshot.meta.humans
          .filter(({ playerId }) => runtime.snapshot.state.players.find(({ id: playerIdInState }) => playerIdInState === playerId)?.active)
          .map(({ userId: activeUserId }) => activeUserId);

        if (!activeHumanIds.every((activeUserId) => submissions.has(activeUserId))) {
          const views = matchViews(runtime.snapshot.state, runtime.snapshot.meta, content, {
            submittedUserIds: [...submissions.keys()],
          });
          await store.updateViews({ matchId, expectedVersion: runtime.match.version, views });
          return current(matchId, userId);
        }

        const result = resolveMatchAllocation(runtime.snapshot.state, runtime.snapshot.meta, submissions, content);
        return transition(
          runtime,
          userId,
          randomId(),
          { type: 'resolveAllocations', submittedUserIds: [...submissions.keys()] },
          result,
        );
      }

      if (body.action === 'decision') {
        return transition(
          runtime,
          userId,
          id,
          body.command,
          resolveMatchDecision(runtime.snapshot.state, runtime.snapshot.meta, userId, body.command, content),
        );
      }

      throw new Error('Unknown match command.');
    },
  };
}

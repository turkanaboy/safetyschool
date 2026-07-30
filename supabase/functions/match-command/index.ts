import { createClient } from 'npm:@supabase/supabase-js@2.110.7';

import config from '../../../balance-config.json' with { type: 'json' };
import cards from '../../../cards.json' with { type: 'json' };
import { validateContent } from '../../../engine/content.js';
import { createMatchService } from '../../../multiplayer/service.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function configuredKey(currentName, legacyName) {
  const current = Deno.env.get(currentName);
  if (current) return JSON.parse(current).default;
  return Deno.env.get(legacyName) ?? '';
}

function value(result) {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

function createStore(admin, contentSetId) {
  return {
    async getLobby(lobbyId) {
      return value(await admin.from('lobbies')
        .select('id,host_user_id,status,lobby_members(user_id,seat_index,is_ready,setup)')
        .eq('id', lobbyId).single());
    },

    async startMatch(payload) {
      return value(await admin.rpc('commit_match_start', {
        p_lobby_id: payload.lobbyId,
        p_host_user_id: payload.hostUserId,
        p_seed: payload.seed,
        p_state: payload.state,
        p_meta: payload.meta,
        p_seats: payload.seats,
        p_views: payload.views,
        p_content_set_id: contentSetId,
      }))[0];
    },

    async getView(matchId, userId) {
      const row = value(await admin.from('match_views')
        .select('match_id,user_id,version,view,matches(status,content_set_id)')
        .eq('match_id', matchId).eq('user_id', userId).single());
      const match = Array.isArray(row.matches) ? row.matches[0] : row.matches;
      return {
        matchId: row.match_id,
        version: row.version,
        status: match?.status,
        contentSetId: match?.content_set_id,
        view: row.view,
      };
    },

    async getRequest(matchId, requestId) {
      return value(await admin.from('match_actions')
        .select('actor_user_id,version_before,command')
        .eq('match_id', matchId).eq('request_id', requestId).maybeSingle());
    },

    async getRuntime(matchId) {
      const match = value(await admin.from('matches')
        .select('id,status,version,match_snapshots(version,state,meta),match_submissions(user_id,actions)')
        .eq('id', matchId).single());
      const snapshot = Array.isArray(match.match_snapshots) ? match.match_snapshots[0] : match.match_snapshots;
      if (!snapshot || snapshot.version !== match.version) throw new Error('Match snapshot version is inconsistent.');
      return {
        match: { id: match.id, status: match.status, version: match.version },
        snapshot,
        submissions: (match.match_submissions ?? []).map((row) => ({ userId: row.user_id, actions: row.actions })),
      };
    },

    async storeSubmission(payload) {
      return value(await admin.rpc('store_match_submission', {
        p_match_id: payload.matchId,
        p_expected_version: payload.expectedVersion,
        p_user_id: payload.userId,
        p_request_id: payload.requestId,
        p_actions: payload.actions,
      }));
    },

    async updateViews(payload) {
      return value(await admin.rpc('update_match_views', {
        p_match_id: payload.matchId,
        p_expected_version: payload.expectedVersion,
        p_views: payload.views,
      }));
    },

    async commitTransition(payload) {
      return value(await admin.rpc('commit_match_transition', {
        p_match_id: payload.matchId,
        p_expected_version: payload.expectedVersion,
        p_request_id: payload.requestId,
        p_actor_user_id: payload.actorUserId,
        p_command: payload.command,
        p_state: payload.state,
        p_meta: payload.meta,
        p_events: payload.events,
        p_views: payload.views,
        p_status: payload.status,
        p_winner_player_id: payload.winnerPlayerId,
      }));
    },
  };
}

const bundledContent = validateContent(config, cards);

async function matchContent(admin, body) {
  let set;
  if (body?.action === 'start') {
    const active = value(await admin.rpc('ensure_active_card_set', {
      p_deck: bundledContent.cards,
      p_content_hash: bundledContent.identity.cardsDigest,
      p_validation: { kind: 'bundled', passedAt: new Date().toISOString() },
    }))[0];
    return { contentSetId: active.id, content: validateContent(config, active.deck) };
  }

  const row = value(await admin.from('matches')
    .select('content_set_id,card_sets(deck,content_hash)').eq('id', body?.matchId).single());
  if (!row.content_set_id) return { contentSetId: null, content: bundledContent };
  set = Array.isArray(row.card_sets) ? row.card_sets[0] : row.card_sets;
  const content = validateContent(config, set.deck);
  if (content.identity.cardsDigest !== set.content_hash) throw new Error('Pinned card set hash is inconsistent.');
  return { contentSetId: row.content_set_id, content };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: corsHeaders });

  try {
    const authorization = request.headers.get('Authorization') ?? '';
    const token = authorization.replace(/^Bearer\s+/i, '');
    if (!token) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: corsHeaders });

    const url = Deno.env.get('SUPABASE_URL') ?? '';
    const userClient = createClient(url, configuredKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser(token);
    if (userError || !user) return Response.json({ error: 'Authentication required.' }, { status: 401, headers: corsHeaders });

    const admin = createClient(url, configuredKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    });
    const body = await request.json();
    const { contentSetId, content } = await matchContent(admin, body);
    const service = createMatchService({ content, store: createStore(admin, contentSetId) });
    return Response.json(await service.handle(user.id, body), { headers: corsHeaders });
  } catch (error) {
    console.error(error);
    return Response.json({ error: error?.message ?? 'Match command failed.' }, { status: 400, headers: corsHeaders });
  }
});

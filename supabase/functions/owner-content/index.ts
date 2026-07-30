import { createClient } from 'npm:@supabase/supabase-js@2.110.7';

import config from '../../../balance-config.json' with { type: 'json' };
import cards from '../../../cards.json' with { type: 'json' };
import { createOwnerContentService } from './service.js';

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

function createStore(admin) {
  async function active() {
    const row = value(await admin.from('active_card_set')
      .select('card_set_id,card_sets(*)').eq('singleton', true).maybeSingle());
    return Array.isArray(row?.card_sets) ? row.card_sets[0] : row?.card_sets;
  }

  return {
    async ensureSeed(payload) {
      return value(await admin.rpc('ensure_active_card_set', {
        p_deck: payload.deck,
        p_content_hash: payload.contentHash,
        p_validation: payload.validation,
      }))[0];
    },

    async overview(userId) {
      const [current, drafts, published] = await Promise.all([
        active(),
        admin.from('card_sets').select().eq('status', 'draft').eq('created_by', userId).order('updated_at', { ascending: false }),
        admin.from('card_sets').select().eq('status', 'published').order('version', { ascending: false }),
      ]);
      return { active: current, drafts: value(drafts), published: value(published) };
    },

    async createDraft(userId) {
      const current = await active();
      if (!current) throw new Error('No published card set is active.');
      return value(await admin.from('card_sets').insert({
        deck: current.deck,
        content_hash: current.content_hash,
        created_by: userId,
      }).select().single());
    },

    async loadDraft(userId, cardSetId) {
      return value(await admin.from('card_sets').select()
        .eq('id', cardSetId).eq('status', 'draft').eq('created_by', userId).single());
    },

    async saveDraft(payload) {
      return value(await admin.from('card_sets').update({
        deck: payload.deck,
        content_hash: payload.contentHash,
        validation: null,
        updated_at: new Date().toISOString(),
      }).eq('id', payload.cardSetId).eq('status', 'draft').eq('created_by', payload.userId).select().single());
    },

    async publish(payload) {
      return value(await admin.rpc('publish_card_set', {
        p_set_id: payload.cardSetId,
        p_validation: payload.validation,
      }))[0];
    },

    async activate(cardSetId) {
      return value(await admin.rpc('activate_card_set', { p_set_id: cardSetId }))[0];
    },
  };
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
    const profile = value(await admin.from('profiles').select('role').eq('id', user.id).single());
    if (profile.role !== 'owner' || user.is_anonymous) {
      return Response.json({ error: 'Owner access required.' }, { status: 403, headers: corsHeaders });
    }

    const service = createOwnerContentService({ config, seedCards: cards, store: createStore(admin) });
    return Response.json(await service.handle(user.id, await request.json()), { headers: corsHeaders });
  } catch (error) {
    console.error(error);
    return Response.json({ error: error?.message ?? 'Owner content request failed.' }, { status: 400, headers: corsHeaders });
  }
});

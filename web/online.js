export const SUPABASE_URL = 'https://qpmgwmmwbfehwvmabdds.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_fzF56Af6fSXTLCPKbnlZhg_0FjtzSOK';

function value(result) {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

async function invoke(client, body) {
  const result = await client.functions.invoke('match-command', { body });
  if (result.error) {
    let detail;
    try {
      detail = await result.error.context?.json?.();
    } catch {
      // Keep the SDK message when the response body is unavailable.
    }
    throw new Error(detail?.error ?? result.error.message);
  }
  return result.data;
}

function displayName(name) {
  const clean = String(name ?? '').trim();
  if (clean.length < 1 || clean.length > 40) throw new Error('Display name must be 1–40 characters.');
  return clean;
}

export function normalizeLobbyCode(code) {
  const clean = String(code ?? '').trim().toUpperCase();
  if (!/^(?:[2-9A-HJ-NP-Z]{6}|[A-F0-9]{8})$/.test(clean)) throw new Error('Enter a six-character lobby code.');
  return clean;
}

export function createOnlineService(client) {
  return {
    async session() {
      return value(await client.auth.getSession()).session;
    },

    async enterGuest(name) {
      return value(await client.auth.signInAnonymously({
        options: { data: { display_name: displayName(name) } },
      })).session;
    },

    async profile(userId) {
      return value(await client.from('profiles').select('id,display_name,role').eq('id', userId).single());
    },

    async lobbies() {
      return value(await client.from('lobbies')
        .select('id,invite_code,host_user_id,status,created_at,lobby_members(user_id,seat_index,is_ready,profiles(display_name,role))')
        .eq('status', 'waiting').order('created_at', { ascending: false }));
    },

    async createLobby() {
      return value(await client.rpc('create_lobby'))[0];
    },

    async joinLobby(code) {
      return value(await client.rpc('join_lobby', { p_invite_code: normalizeLobbyCode(code) }))[0];
    },

    async setReady(lobbyId, ready) {
      return value(await client.rpc('set_lobby_ready', { p_lobby_id: lobbyId, p_ready: Boolean(ready) }))[0];
    },

    async leaveLobby(lobbyId) {
      value(await client.rpc('leave_lobby', { p_lobby_id: lobbyId }));
    },

    async matchViews() {
      return value(await client.from('match_views')
        .select('match_id,version,view,updated_at,matches(status,updated_at)')
        .order('updated_at', { ascending: false }));
    },

    async startMatch(lobbyId) {
      return invoke(client, { action: 'start', lobbyId });
    },

    async sendMatchCommand(command) {
      return invoke(client, command);
    },

    subscribe(lobbyId, onChange) {
      const channel = client.channel(`lobby:${lobbyId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'lobbies', filter: `id=eq.${lobbyId}` }, onChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'lobby_members', filter: `lobby_id=eq.${lobbyId}` }, onChange)
        .subscribe();
      return () => client.removeChannel(channel);
    },

    subscribeMatch(matchId, onChange) {
      const channel = client.channel(`match:${matchId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'match_views', filter: `match_id=eq.${matchId}` }, onChange)
        .subscribe();
      return () => client.removeChannel(channel);
    },
  };
}

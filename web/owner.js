import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './online.js';

function value(result) {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

async function invoke(client, body) {
  const result = await client.functions.invoke('owner-content', { body });
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

export { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL };

export function createOwnerService(client) {
  return {
    async session() {
      return value(await client.auth.getSession()).session;
    },

    async signIn(email, redirectTo) {
      const clean = String(email ?? '').trim();
      if (!clean) throw new Error('Enter the owner email address.');
      await value(await client.auth.signInWithOtp({
        email: clean,
        options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
      }));
    },

    async signOut() {
      await value(await client.auth.signOut());
    },

    async dashboard(days = 30) {
      return value(await client.rpc('owner_dashboard', { p_days: Number(days) }));
    },

    async content(action, values = {}) {
      return invoke(client, { action, ...structuredClone(values) });
    },
  };
}

export function completionRate(matches) {
  return matches?.started ? Math.round((matches.completed / matches.started) * 100) : 0;
}

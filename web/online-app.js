import { createClient } from '/vendor/supabase.js';
import {
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
  createOnlineService,
  normalizeLobbyCode,
} from '/online.js';

const root = document.querySelector('#online-root');
const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const online = createOnlineService(client);
const pendingCodeKey = 'safety-school:pending-lobby-code';
let session = null;
let profile = null;
let lobbies = [];
let activeLobbyId = null;
let stopSubscription = null;
let subscribedLobbyId = null;
let busy = false;
let refreshVersion = 0;
let message = '';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function pendingCode(value) {
  try {
    if (value === undefined) return sessionStorage.getItem(pendingCodeKey);
    if (value === null) sessionStorage.removeItem(pendingCodeKey);
    else sessionStorage.setItem(pendingCodeKey, value);
  } catch {
    return null;
  }
  return value;
}

function setLobbyUrl(lobby = null) {
  const url = new URL('/online.html', location.origin);
  if (lobby) url.searchParams.set('lobby', lobby.id);
  history.replaceState(null, '', url);
}

function profileOf(member) {
  return Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
}

function renderMessage() {
  return message ? `<p class="online-message" role="status">${escapeHtml(message)}</p>` : '';
}

function renderGuestEntry() {
  const invitedCode = pendingCode();
  root.innerHTML = `
    <a class="online-back" href="/">← Solo campus</a>
    <span class="startup__seal" aria-hidden="true">SS</span>
    <p class="eyebrow">Phase 3 multiplayer</p>
    <h1>${invitedCode ? `Join game ${escapeHtml(invitedCode)}` : 'Enter the presidents’ lounge'}</h1>
    <p>Choose the name other presidents will see. No account, email, or password is required.</p>
    ${renderMessage()}
    <form class="online-form" id="online-guest-form">
      <label>Display name<input name="displayName" maxlength="40" autocomplete="nickname" required></label>
      <button class="primary-button" type="submit">${invitedCode ? 'Join game' : 'Enter multiplayer'}</button>
    </form>
    <p class="online-note">This guest seat stays connected in this browser. Keep its browser data until the game is finished.</p>`;
}

function renderProfileRecovery() {
  root.innerHTML = `
    <span class="startup__seal" aria-hidden="true">SS</span>
    <p class="eyebrow">Signed in, profile unavailable</p>
    <h1>We could not open the presidents&rsquo; lounge</h1>
    <p>Your session is safe. This is usually a temporary connection or profile-provisioning delay.</p>
    ${renderMessage()}
    <div class="startup-actions"><button class="primary-button" type="button" data-online-action="retry-profile">Try again</button></div>`;
}

function renderLobbyList() {
  const records = lobbies.map((lobby) => {
    const humans = lobby.lobby_members?.length ?? 0;
    return `<li><button type="button" data-online-action="open-lobby" data-lobby-id="${lobby.id}"><span><strong>Lobby ${escapeHtml(lobby.invite_code)}</strong><small>${humans} human${humans === 1 ? '' : 's'} · ${4 - humans} AI seat${4 - humans === 1 ? '' : 's'}</small></span><b>Open</b></button></li>`;
  }).join('');
  root.innerHTML = `
    <header class="online-header"><div><p class="eyebrow">Playing as</p><h1>${escapeHtml(profile.display_name)}</h1></div>${profile.role === 'owner' ? '<span class="owner-badge">Owner</span>' : ''}</header>
    ${renderMessage()}
    <div class="online-grid">
      <section class="online-card"><h2>Create a lobby</h2><p>Invite up to three other presidents. Start with two to four humans; AI campuses will fill open seats.</p><button class="primary-button" type="button" data-online-action="create-lobby">Create lobby</button></section>
      <section class="online-card"><h2>Join by code</h2><form class="online-form online-form--inline" id="join-lobby-form"><label>Six-character code<input name="code" maxlength="8" autocomplete="off" required></label><button class="primary-button" type="submit">Join lobby</button></form></section>
    </div>
    <section class="online-card online-lobbies"><h2>Your waiting lobbies</h2><ul>${records || '<li class="online-empty">No waiting lobbies yet.</li>'}</ul></section>
    <a class="online-back online-back--footer" href="/">Return to solo campus</a>`;
}

function renderLobby(lobby) {
  const members = lobby.lobby_members ?? [];
  const ownMember = members.find((member) => member.user_id === session.user.id);
  const seats = Array.from({ length: 4 }, (_, seat) => {
    const member = members.find((candidate) => candidate.seat_index === seat);
    if (!member) return `<li class="online-seat online-seat--ai"><span>AI</span><div><strong>AI campus</strong><small>Fills this seat when play begins</small></div></li>`;
    const memberProfile = profileOf(member);
    return `<li class="online-seat"><span>${escapeHtml((memberProfile?.display_name ?? 'P').slice(0, 2).toUpperCase())}</span><div><strong>${escapeHtml(memberProfile?.display_name ?? 'President')}${member.user_id === lobby.host_user_id ? ' · Host' : ''}${member.user_id === session.user.id ? ' · You' : ''}</strong><small>${member.is_ready ? 'Ready' : 'Not ready'}</small></div></li>`;
  }).join('');
  const shareUrl = `${location.origin}/online.html?join=${lobby.invite_code}`;
  root.innerHTML = `
    <header class="online-header"><button class="secondary-button" type="button" data-online-action="back-to-lobbies">← Lobbies</button><div><p class="eyebrow">Private lobby</p><h1>${escapeHtml(lobby.invite_code)}</h1></div></header>
    ${renderMessage()}
    <section class="online-card online-invite"><div><h2>Invite presidents</h2><p>Share this code or link. Lobby membership is protected by row-level security.</p></div><div><strong>${escapeHtml(lobby.invite_code)}</strong><button class="primary-button" type="button" data-online-action="copy-invite" data-share-url="${escapeHtml(shareUrl)}">Copy invite link</button></div></section>
    <ol class="online-seats">${seats}</ol>
    <section class="online-card online-lobby-actions"><div><h2>${members.length} human player${members.length === 1 ? '' : 's'}</h2><p>At least two humans are required. Empty seats use the existing AI schools.</p></div><div><button class="primary-button" type="button" data-online-action="toggle-ready">${ownMember?.is_ready ? 'Mark not ready' : 'Mark ready'}</button><button class="danger-button" type="button" data-online-action="leave-lobby">${lobby.host_user_id === session.user.id ? 'Cancel lobby' : 'Leave lobby'}</button></div></section>
    <p class="online-note">Starting the match comes with the next server-authoritative gameplay slice; this foundation intentionally stops at secure lobby readiness.</p>`;
}

function render() {
  if (!session) return renderGuestEntry();
  if (!profile) return renderProfileRecovery();
  const active = lobbies.find((lobby) => lobby.id === activeLobbyId);
  if (active) renderLobby(active);
  else renderLobbyList();
}

function perform(task) {
  if (busy) return;
  busy = true;
  root.setAttribute('aria-busy', 'true');
  void task().catch(showError).finally(() => {
    busy = false;
    root.removeAttribute('aria-busy');
  });
}

function showError(error) {
  message = error.message;
  render();
}

function subscribe() {
  if (subscribedLobbyId === activeLobbyId) return;
  stopSubscription?.();
  subscribedLobbyId = activeLobbyId;
  stopSubscription = activeLobbyId
    ? online.subscribe(activeLobbyId, () => void refresh().catch(showError))
    : null;
}

async function refresh() {
  const version = ++refreshVersion;
  const nextLobbies = await online.lobbies();
  if (version !== refreshVersion) return;
  lobbies = nextLobbies;
  if (activeLobbyId && !lobbies.some((lobby) => lobby.id === activeLobbyId)) {
    activeLobbyId = null;
    setLobbyUrl();
  }
  subscribe();
  render();
}

async function boot() {
  try {
    const requested = new URLSearchParams(location.search).get('join');
    if (requested) {
      try {
        pendingCode(normalizeLobbyCode(requested));
      } catch (error) {
        message = error.message;
        pendingCode(null);
        setLobbyUrl();
      }
    }
    session = await online.session();
    if (!session) return renderGuestEntry();
    profile = await online.profile(session.user.id);
    const queuedCode = pendingCode();
    if (queuedCode) {
      try {
        const lobby = await online.joinLobby(queuedCode);
        activeLobbyId = lobby.id;
        setLobbyUrl(lobby);
      } catch (error) {
        message = `Could not join that lobby. ${error.message}`;
        activeLobbyId = null;
        setLobbyUrl();
      } finally {
        pendingCode(null);
      }
    } else {
      activeLobbyId = new URLSearchParams(location.search).get('lobby');
    }
    await refresh();
  } catch (error) {
    message = error.message;
    render();
  }
}

root.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  perform(async () => {
    message = '';
    if (event.target.id === 'online-guest-form') {
      await online.enterGuest(form.get('displayName'));
      await boot();
    } else if (event.target.id === 'join-lobby-form') {
      const lobby = await online.joinLobby(form.get('code'));
      activeLobbyId = lobby.id;
      setLobbyUrl(lobby);
      await refresh();
    }
  });
});

root.addEventListener('click', (event) => {
  const button = event.target.closest('[data-online-action]');
  if (!button) return;
  perform(async () => {
    message = '';
    if (button.dataset.onlineAction === 'retry-profile') {
      profile = await online.profile(session.user.id);
      await refresh();
    } else if (button.dataset.onlineAction === 'create-lobby') {
      const lobby = await online.createLobby();
      activeLobbyId = lobby.id;
      setLobbyUrl(lobby);
      await refresh();
    } else if (button.dataset.onlineAction === 'open-lobby') {
      activeLobbyId = button.dataset.lobbyId;
      setLobbyUrl(lobbies.find((lobby) => lobby.id === activeLobbyId));
      subscribe();
      render();
    } else if (button.dataset.onlineAction === 'back-to-lobbies') {
      activeLobbyId = null;
      setLobbyUrl();
      subscribe();
      render();
    } else if (button.dataset.onlineAction === 'toggle-ready') {
      const lobby = lobbies.find((candidate) => candidate.id === activeLobbyId);
      const member = lobby?.lobby_members?.find((candidate) => candidate.user_id === session.user.id);
      if (!member) {
        message = 'That lobby changed before your action completed. Your lobby list has been refreshed.';
        await refresh();
        return;
      }
      await online.setReady(activeLobbyId, !member.is_ready);
      await refresh();
    } else if (button.dataset.onlineAction === 'leave-lobby') {
      await online.leaveLobby(activeLobbyId);
      activeLobbyId = null;
      setLobbyUrl();
      await refresh();
    } else if (button.dataset.onlineAction === 'copy-invite') {
      await navigator.clipboard.writeText(button.dataset.shareUrl);
      message = 'Invite link copied.';
      render();
    }
  });
});

window.addEventListener('pagehide', () => stopSubscription?.());
boot();

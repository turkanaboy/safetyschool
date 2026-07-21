import { createClient } from '/vendor/supabase.js';
import {
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
  createOnlineService,
  normalizeLobbyCode,
  selectMatchRecord,
} from '/online.js';

const root = document.querySelector('#online-root');
const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const online = createOnlineService(client);
const pendingCodeKey = 'safety-school:pending-lobby-code';
let session = null;
let profile = null;
let lobbies = [];
let matchRecords = [];
let activeLobbyId = null;
let activeMatchId = null;
let stopSubscription = null;
let subscribedKey = null;
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

function setOnlineUrl({ lobby = null, match = null } = {}) {
  const url = new URL('/online.html', location.origin);
  if (lobby) url.searchParams.set('lobby', lobby.id);
  if (match) url.searchParams.set('match', match.match_id ?? match.matchId);
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

function relation(value) {
  return Array.isArray(value) ? value[0] : value;
}

function matchStatus(record) {
  return relation(record.matches)?.status;
}

function titleCase(value) {
  return String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase());
}

function formatMoney(value) {
  return `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(1)}m`;
}

function formatNumber(value) {
  return Math.round(value).toLocaleString();
}

function termLabel(view, next = false) {
  const roundsPerYear = view.roundsPerYear ?? 5;
  const round = Math.max(1, view.round + (next ? 1 : 0));
  const year = Math.ceil(round / roundsPerYear);
  const term = ((round - 1) % roundsPerYear) + 1;
  return `Year ${year} · Term ${term}`;
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
  const isHost = lobby.host_user_id === session.user.id;
  const canStart = isHost && members.length >= 2 && members.every((member) => member.is_ready);
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
    <section class="online-card online-lobby-actions"><div><h2>${members.length} human player${members.length === 1 ? '' : 's'}</h2><p>${canStart ? 'Everyone is ready. Start the game when you are set.' : 'At least two humans must join and every human must be ready. Empty seats become AI schools.'}</p></div><div><button class="primary-button" type="button" data-online-action="toggle-ready">${ownMember?.is_ready ? 'Mark not ready' : 'Mark ready'}</button>${isHost ? `<button class="primary-button" type="button" data-online-action="start-match" ${canStart ? '' : 'disabled'}>Start game</button>` : ''}<button class="danger-button" type="button" data-online-action="leave-lobby">${isHost ? 'Cancel lobby' : 'Leave lobby'}</button></div></section>
    <p class="online-note">All campuses begin with the same balanced founding plan: +1 Academics, +1 Student Affairs, and +1 Administration.</p>`;
}

function actionLabel(option, view) {
  const action = option.action;
  if (action.type === 'upgrade') return `Upgrade ${titleCase(action.department)} · ${formatMoney(option.cost)}`;
  if (action.type === 'sell') return `Sell one ${titleCase(action.department)} level · recover ${formatMoney(option.recovery)}`;
  if (action.type === 'openProgram') return `Open ${titleCase(action.program)} · ${formatMoney(option.cost)}`;
  if (action.type === 'campaign') return `Run a marketing campaign · ${formatMoney(option.cost)}`;
  if (action.type === 'poach') {
    const target = view.players.find((player) => player.id === action.targetPlayerId)?.name ?? 'a rival';
    return `Recruit from ${target} · ${formatMoney(option.cost)}`;
  }
  return titleCase(action.type);
}

function renderMatch(record) {
  const view = record.view;
  const status = matchStatus(record) ?? record.status;
  const term = termLabel(view);
  const nextTerm = termLabel(view, true);
  const rivals = view.players.filter(({ id }) => id !== view.own.id).map((player) => `
    <li><strong>${escapeHtml(player.name)}</strong><span>${player.active ? 'Open' : 'Closed'}</span></li>`).join('');
  const events = view.latestEvents.slice(-4).map((event) => `<li>${escapeHtml(titleCase(event.type))}</li>`).join('');

  let action = '';
  if (status === 'complete' || view.finished) {
    const winner = view.players.find(({ id }) => id === view.winnerId)?.name ?? 'The field';
    action = `<section class="online-card online-match-action"><p class="eyebrow">Final issue</p><h2>${escapeHtml(winner)} wins</h2><p>The authoritative match is complete.</p><button class="secondary-button" type="button" data-online-action="close-match">Return to lobbies</button></section>`;
  } else if (view.canStartRound) {
    action = `<section class="online-card online-match-action"><p class="eyebrow">Shared turn</p><h2>Begin ${escapeHtml(nextTerm)}</h2><p>Any human president can open the term. The first valid request advances everyone once.</p><button class="primary-button" type="button" data-online-action="begin-term">Begin term</button></section>`;
  } else if (view.submitted) {
    action = `<section class="online-card online-match-action"><p class="eyebrow">Allocation submitted</p><h2>Waiting for the other presidents</h2><p>${escapeHtml(view.waitingFor.length ? view.waitingFor.join(', ') : 'The term is resolving now.')}</p></section>`;
  } else if (view.legal?.kind === 'allocation') {
    const options = view.legal.actions.map((option, index) => ({ option, index }))
      .filter(({ option }) => option.action.type !== 'bank')
      .map(({ option, index }) => `<label class="online-match-choice"><input type="checkbox" name="actionIndex" value="${index}"><span>${escapeHtml(actionLabel(option, view))}</span></label>`).join('');
    action = `<section class="online-card online-match-action"><p class="eyebrow">Your allocation</p><h2>Choose up to ${view.legal.maxActions} actions</h2><p>Use each action type once. Leave slots empty to bank them.</p><form id="match-allocation-form" class="online-match-choices">${options}<button class="primary-button" type="submit">Submit allocation</button></form></section>`;
  } else if (view.legal?.kind === 'decision') {
    const choices = view.legal.commands.map((command, index) => `<button class="primary-button" type="button" data-online-action="match-decision" data-command-index="${index}">${escapeHtml(command.choice ? titleCase(command.choice) : `Sell ${titleCase(command.department)}`)}</button>`).join('');
    action = `<section class="online-card online-match-action"><p class="eyebrow">Your decision</p><h2>${escapeHtml(titleCase(view.pendingDecision?.type))}</h2><div class="startup-actions">${choices}</div></section>`;
  } else {
    action = `<section class="online-card online-match-action"><p class="eyebrow">Shared turn</p><h2>Waiting for another president</h2><p>The match will update here automatically.</p></section>`;
  }

  root.innerHTML = `
    <header class="online-header"><div><p class="eyebrow">Online campus · ${escapeHtml(term)}</p><h1>${escapeHtml(view.own.name)}</h1></div><span class="owner-badge">Live</span></header>
    ${renderMessage()}
    <section class="online-match-stats" aria-label="Campus resources">
      <article><span>Treasury</span><strong>${formatMoney(view.own.treasury)}</strong></article>
      <article><span>Students</span><strong>${formatNumber(view.own.students)}</strong></article>
      <article><span>Reputation</span><strong>${formatNumber(view.own.reputation)}</strong></article>
      <article><span>Alumni</span><strong>${formatNumber(view.own.alumni)}</strong></article>
    </section>
    <div class="online-match-grid">${action}<aside class="online-card"><h2>Campuses</h2><ul class="online-match-list">${rivals}</ul><h2>Latest resolutions</h2><ul class="online-match-list">${events || '<li>The board is convening.</li>'}</ul></aside></div>`;
}

function render() {
  if (!session) return renderGuestEntry();
  if (!profile) return renderProfileRecovery();
  const match = matchRecords.find((record) => record.match_id === activeMatchId);
  if (match) return renderMatch(match);
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
  const key = activeMatchId ? `match:${activeMatchId}` : activeLobbyId ? `lobby:${activeLobbyId}` : null;
  if (subscribedKey === key) return;
  stopSubscription?.();
  subscribedKey = key;
  stopSubscription = activeMatchId
    ? online.subscribeMatch(activeMatchId, () => void refresh().catch(showError))
    : activeLobbyId ? online.subscribe(activeLobbyId, () => void refresh().catch(showError)) : null;
}

async function refresh() {
  const version = ++refreshVersion;
  const [nextLobbies, nextMatches] = await Promise.all([online.lobbies(), online.matchViews()]);
  if (version !== refreshVersion) return;
  lobbies = nextLobbies;
  matchRecords = nextMatches;
  const requestedMatchId = new URLSearchParams(location.search).get('match');
  const resume = selectMatchRecord(matchRecords, requestedMatchId);
  if (resume) {
    activeMatchId = resume.match_id;
    activeLobbyId = null;
    if (requestedMatchId !== activeMatchId) setOnlineUrl({ match: resume });
  } else {
    activeMatchId = null;
  }
  if (activeLobbyId && !lobbies.some((lobby) => lobby.id === activeLobbyId)) {
    activeLobbyId = null;
    setOnlineUrl();
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
        setOnlineUrl();
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
        setOnlineUrl({ lobby });
      } catch (error) {
        message = `Could not join that lobby. ${error.message}`;
        activeLobbyId = null;
        setOnlineUrl();
      } finally {
        pendingCode(null);
      }
    } else {
      activeLobbyId = new URLSearchParams(location.search).get('lobby');
      activeMatchId = new URLSearchParams(location.search).get('match');
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
      setOnlineUrl({ lobby });
      await refresh();
    } else if (event.target.id === 'match-allocation-form') {
      const record = matchRecords.find((candidate) => candidate.match_id === activeMatchId);
      const actions = form.getAll('actionIndex').map((index) => record.view.legal.actions[Number(index)].action);
      await online.sendMatchCommand({
        action: 'submitAllocation',
        matchId: activeMatchId,
        requestId: crypto.randomUUID(),
        actions,
      });
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
      setOnlineUrl({ lobby });
      await refresh();
    } else if (button.dataset.onlineAction === 'open-lobby') {
      activeLobbyId = button.dataset.lobbyId;
      setOnlineUrl({ lobby: lobbies.find((lobby) => lobby.id === activeLobbyId) });
      subscribe();
      render();
    } else if (button.dataset.onlineAction === 'back-to-lobbies') {
      activeLobbyId = null;
      setOnlineUrl();
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
    } else if (button.dataset.onlineAction === 'start-match') {
      const started = await online.startMatch(activeLobbyId);
      activeMatchId = started.matchId;
      activeLobbyId = null;
      setOnlineUrl({ match: { matchId: activeMatchId } });
      await refresh();
    } else if (button.dataset.onlineAction === 'begin-term') {
      await online.sendMatchCommand({
        action: 'beginTerm',
        matchId: activeMatchId,
        requestId: crypto.randomUUID(),
      });
      await refresh();
    } else if (button.dataset.onlineAction === 'match-decision') {
      const record = matchRecords.find((candidate) => candidate.match_id === activeMatchId);
      await online.sendMatchCommand({
        action: 'decision',
        matchId: activeMatchId,
        requestId: crypto.randomUUID(),
        command: record.view.legal.commands[Number(button.dataset.commandIndex)],
      });
      await refresh();
    } else if (button.dataset.onlineAction === 'close-match') {
      activeMatchId = null;
      setOnlineUrl();
      await refresh();
    } else if (button.dataset.onlineAction === 'leave-lobby') {
      await online.leaveLobby(activeLobbyId);
      activeLobbyId = null;
      setOnlineUrl();
      await refresh();
    } else if (button.dataset.onlineAction === 'copy-invite') {
      await navigator.clipboard.writeText(button.dataset.shareUrl);
      message = 'Invite link copied.';
      render();
    }
  });
});

window.addEventListener('pagehide', () => {
  stopSubscription?.();
  stopSubscription = null;
  subscribedKey = null;
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void refresh().catch(showError);
});
boot();

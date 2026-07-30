import { createClient } from '/vendor/supabase.js';
import {
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
  completionRate,
  createOwnerService,
} from '/owner.js';

const root = document.querySelector('#owner-root');
const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { storageKey: 'safety-school-owner-auth' },
});
const owner = createOwnerService(client);
let session = null;
let dashboard = null;
let busy = true;
let message = '';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function date(value) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}

function duration(minutes) {
  if (!minutes) return '—';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderSignIn() {
  root.innerHTML = `<main class="owner-login">
    <a class="owner-back" href="/">← Safety School</a>
    <img src="/assets/brand/logo-mark.png" alt="" width="72" height="72">
    <p class="owner-kicker">Office of the proprietor</p>
    <h1>Owner operations</h1>
    <p>Request a one-time link for the designated owner account. Player sessions remain separate.</p>
    ${message ? `<p class="owner-message" role="status">${escapeHtml(message)}</p>` : ''}
    <form id="owner-sign-in">
      <label>Owner email<input type="email" name="email" autocomplete="email" required></label>
      <button type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Email sign-in link'}</button>
    </form>
  </main>`;
}

function metric(label, value, detail) {
  return `<article class="owner-metric"><small>${label}</small><strong>${value}</strong><span>${detail}</span></article>`;
}

function activityBars(rows) {
  const max = Math.max(1, ...rows.map((row) => row.lobbies + row.matches));
  return rows.map((row) => {
    const height = Math.max(3, Math.round(((row.lobbies + row.matches) / max) * 100));
    return `<span style="--height:${height}%" title="${escapeHtml(`${date(row.date)}: ${row.lobbies} lobbies, ${row.matches} matches`)}"><i></i></span>`;
  }).join('');
}

function renderDashboard() {
  const { lobbies, matches, players, daily, recentMatches, windowDays } = dashboard;
  const rows = recentMatches.map((match) => `<tr>
    <td><code>${escapeHtml(match.id.slice(0, 8))}</code></td>
    <td><span class="owner-status owner-status--${match.status}">${match.status}</span></td>
    <td>${match.humanSeats}</td>
    <td>${date(match.createdAt)}</td>
    <td>${duration(match.durationMinutes)}</td>
  </tr>`).join('');
  root.innerHTML = `<main class="owner-dashboard">
    <header class="owner-header">
      <div><p class="owner-kicker">Office of the proprietor</p><h1>Game health</h1><p>Aggregate operations only. No private match state is exposed.</p></div>
      <div class="owner-header__actions">
        <label>Window<select id="owner-window">${[7, 30, 90].map((days) => `<option value="${days}" ${days === windowDays ? 'selected' : ''}>${days} days</option>`).join('')}</select></label>
        <button class="owner-secondary" id="owner-sign-out">Sign out</button>
      </div>
    </header>
    ${message ? `<p class="owner-message" role="status">${escapeHtml(message)}</p>` : ''}
    <section class="owner-metrics" aria-label="Operations summary">
      ${metric('Matches started', matches.started, `${matches.active} active now`)}
      ${metric('Completion rate', `${completionRate(matches)}%`, `${matches.completed} completed`)}
      ${metric('Human seats', players.human_seats, `${players.anonymous_identities} anonymous identities`)}
      ${metric('Average game', duration(matches.average_minutes), 'Completed matches')}
      ${metric('Lobbies created', lobbies.created, `${lobbies.cancelled} cancelled`)}
    </section>
    <section class="owner-panel">
      <div class="owner-panel__heading"><div><p class="owner-kicker">Activity</p><h2>Lobby and match starts</h2></div><span>Last ${windowDays} days</span></div>
      <div class="owner-chart" role="img" aria-label="Daily lobby and match activity">${activityBars(daily)}</div>
    </section>
    <section class="owner-panel">
      <div class="owner-panel__heading"><div><p class="owner-kicker">Recent boardrooms</p><h2>Latest matches</h2></div><span>${recentMatches.length} shown</span></div>
      ${rows ? `<div class="owner-table-wrap"><table><thead><tr><th>Match</th><th>Status</th><th>Humans</th><th>Started</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="owner-empty">No matches started in this window yet.</p>'}
    </section>
  </main>`;
}

function render() {
  if (!session || !dashboard) renderSignIn();
  else renderDashboard();
}

async function loadDashboard(days = 30) {
  busy = true;
  message = '';
  render();
  try {
    dashboard = await owner.dashboard(days);
  } catch (error) {
    dashboard = null;
    message = error.message === 'Owner access required' ? 'This session is not authorized for owner operations.' : error.message;
  } finally {
    busy = false;
    render();
  }
}

root.addEventListener('submit', async (event) => {
  if (event.target.id !== 'owner-sign-in') return;
  event.preventDefault();
  busy = true;
  message = '';
  render();
  try {
    await owner.signIn(new FormData(event.target).get('email'), `${location.origin}/owner.html`);
    message = 'Check that inbox for a one-time sign-in link.';
  } catch (error) {
    message = error.message;
  } finally {
    busy = false;
    render();
  }
});

root.addEventListener('change', (event) => {
  if (event.target.id === 'owner-window') loadDashboard(event.target.value);
});

root.addEventListener('click', async (event) => {
  if (event.target.id !== 'owner-sign-out') return;
  await owner.signOut();
  session = null;
  dashboard = null;
  message = '';
  render();
});

client.auth.onAuthStateChange((_event, nextSession) => {
  if (nextSession?.user?.id === session?.user?.id) return;
  session = nextSession;
  if (session) loadDashboard();
});

session = await owner.session();
if (session) await loadDashboard();
else {
  busy = false;
  render();
}


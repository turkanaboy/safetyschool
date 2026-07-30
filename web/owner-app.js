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
let section = 'dashboard';
let contentOverview = null;
let draft = null;
let draftDirty = false;
let selectedDeck = 'fortuneCards';
let selectedCardId = null;

const deckLabels = {
  annualDisruptions: 'Annual disruptions',
  fortuneCards: 'Fortunes',
  crisisCards: 'Crises',
  headlines: 'Headlines',
};

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

function ownerNav() {
  return `<nav class="owner-nav" aria-label="Owner operations">
    <button data-owner-section="dashboard" ${section === 'dashboard' ? 'aria-current="page"' : ''}>Game health</button>
    <button data-owner-section="cards" ${section === 'cards' ? 'aria-current="page"' : ''}>Card studio</button>
  </nav>`;
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
    ${ownerNav()}
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

function effectField(effectIndex, key, value) {
  if (typeof value === 'boolean') return `<label>${escapeHtml(key)}<select name="effect.${effectIndex}.${escapeHtml(key)}"><option value="true" ${value ? 'selected' : ''}>True</option><option value="false" ${!value ? 'selected' : ''}>False</option></select></label>`;
  if (typeof value === 'number') return `<label>${escapeHtml(key)}<input type="number" step="any" name="effect.${effectIndex}.${escapeHtml(key)}" value="${value}" required></label>`;
  if (value && typeof value === 'object') return `<label>${escapeHtml(key)}<textarea name="effect.${effectIndex}.${escapeHtml(key)}" rows="3">${escapeHtml(JSON.stringify(value, null, 2))}</textarea></label>`;
  return `<label>${escapeHtml(key)}<input name="effect.${effectIndex}.${escapeHtml(key)}" value="${escapeHtml(value ?? '')}" required></label>`;
}

function renderEffects(card) {
  const vocabulary = selectedDeck === 'fortuneCards' || selectedDeck === 'crisisCards'
    ? draft.deck.playerCardEffectVocabulary
    : draft.deck.effectTypeVocabulary;
  return card.effects.map((effect, index) => `<fieldset class="owner-effect">
    <legend>Effect ${index + 1}</legend>
    <label>Modifier<select data-effect-type="${index}">${Object.keys(vocabulary).map((type) => `<option value="${type}" ${effect.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label>
    <div class="owner-effect__fields">${Object.entries(effect).filter(([key]) => key !== 'type').map(([key, value]) => effectField(index, key, value)).join('')}</div>
    <p>${escapeHtml(vocabulary[effect.type] ?? 'This modifier is not in the allowed vocabulary.')}</p>
    <label>Advanced replacement (optional)<textarea name="effectReplacement.${index}" rows="4" placeholder='{"type":"${escapeHtml(effect.type)}", ...}'></textarea></label>
    <button type="button" class="owner-danger" data-remove-effect="${index}" ${draftDirty ? 'disabled' : ''}>Remove effect</button>
  </fieldset>`).join('');
}

function renderCardEditor() {
  const cards = draft.deck[selectedDeck];
  if (!selectedCardId || !cards.some(({ id }) => id === selectedCardId)) selectedCardId = cards[0]?.id ?? null;
  const card = cards.find(({ id }) => id === selectedCardId);
  if (!card) return '<p class="owner-empty">This deck has no cards. Duplicate a card before removing the final entry.</p>';
  return `<div class="owner-editor">
    <aside class="owner-card-list" aria-label="${deckLabels[selectedDeck]} cards">
      ${cards.map((item) => `<button data-card-id="${escapeHtml(item.id)}" ${item.id === card.id ? 'aria-current="true"' : ''} ${draftDirty && item.id !== card.id ? 'disabled title="Save this card before switching."' : ''}><small>${escapeHtml(item.id)}</small>${escapeHtml(item.name)}</button>`).join('')}
    </aside>
    <form class="owner-card-form" id="owner-card-form">
      <div class="owner-editor__actions">
        <button type="button" class="owner-secondary" data-duplicate-card ${draftDirty ? 'disabled' : ''}>Duplicate card</button>
        <button type="button" class="owner-danger" data-remove-card ${draftDirty ? 'disabled' : ''}>Remove card</button>
      </div>
      <div class="owner-form-grid">
        <label>Card ID<input name="id" value="${escapeHtml(card.id)}" required></label>
        ${'target' in card ? `<label>Target<select name="target">${['random', 'admissions', 'marketing', 'academics', 'studentAffairs', 'athletics', 'administration'].map((target) => `<option value="${target}" ${card.target === target ? 'selected' : ''}>${target}</option>`).join('')}</select></label>` : ''}
        ${'severity' in card ? `<label>Severity<select name="severity">${[1, 2, 3].map((severity) => `<option value="${severity}" ${card.severity === severity ? 'selected' : ''}>${severity}</option>`).join('')}</select></label>` : ''}
        <label class="owner-span">Name<input name="name" value="${escapeHtml(card.name)}" required></label>
        <label class="owner-span">Flavor text<textarea name="flavor" rows="4">${escapeHtml(card.flavor ?? '')}</textarea></label>
        ${'prepHint' in card ? `<label class="owner-span">Preparation hint<textarea name="prepHint" rows="3">${escapeHtml(card.prepHint ?? '')}</textarea></label>` : ''}
      </div>
      <section class="owner-effects"><div class="owner-panel__heading"><div><p class="owner-kicker">Closed vocabulary</p><h2>Effects</h2></div><button type="button" class="owner-secondary" data-add-effect ${draftDirty ? 'disabled' : ''}>Add effect</button></div>${renderEffects(card)}</section>
      <button type="submit" ${busy ? 'disabled' : ''}>Save and validate draft</button>
    </form>
  </div>`;
}

function renderCards() {
  const draftList = contentOverview?.drafts ?? [];
  const active = contentOverview?.active;
  root.innerHTML = `<main class="owner-dashboard">
    <header class="owner-header">
      <div><p class="owner-kicker">Office of the proprietor</p><h1>Card studio</h1><p>Published decks are immutable. Changes apply only to matches created after activation.</p></div>
      <div class="owner-header__actions"><button class="owner-secondary" id="owner-sign-out">Sign out</button></div>
    </header>
    ${ownerNav()}
    ${message ? `<p class="owner-message" role="status">${escapeHtml(message)}</p>` : ''}
    <section class="owner-panel owner-content-bar">
      <div><small>Active set</small><strong>${active ? `Version ${active.version}` : 'Loading…'}</strong></div>
      <label>Draft<select id="owner-draft-select"><option value="">Choose a draft</option>${draftList.map((item) => `<option value="${item.id}" ${draft?.id === item.id ? 'selected' : ''}>Version ${item.version} · ${date(item.updatedAt)}</option>`).join('')}</select></label>
      <button id="owner-new-draft" ${busy ? 'disabled' : ''}>New draft from active</button>
      ${draft ? `<button id="owner-publish" class="owner-publish" ${busy || draftDirty ? 'disabled' : ''} ${draftDirty ? 'title="Save and validate before publishing."' : ''}>Publish version ${draft.version}</button>` : ''}
    </section>
    ${draft ? `<nav class="owner-deck-tabs" aria-label="Card decks">${Object.keys(deckLabels).map((key) => `<button data-deck="${key}" ${key === selectedDeck ? 'aria-current="page"' : ''} ${draftDirty && key !== selectedDeck ? 'disabled title="Save this card before switching decks."' : ''}>${deckLabels[key]} <span>${draft.deck[key].length}</span></button>`).join('')}</nav>${renderCardEditor()}`
      : '<section class="owner-panel"><p class="owner-empty">Create a draft or choose an existing one to begin editing.</p></section>'}
  </main>`;
}

function render() {
  if (!session || !dashboard) renderSignIn();
  else if (section === 'cards') renderCards();
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

async function loadContent() {
  busy = true;
  message = '';
  render();
  try {
    contentOverview = await owner.content('overview');
    const existingId = contentOverview.drafts[0]?.id;
    draft = existingId
      ? await owner.content('loadDraft', { cardSetId: existingId })
      : await owner.content('createDraft');
    selectedCardId = null;
    if (!existingId) {
      contentOverview = await owner.content('overview');
      message = 'Editable draft created from the active card set.';
    }
  } catch (error) {
    message = error.message;
  } finally {
    busy = false;
    render();
  }
}

function currentCard() {
  return draft?.deck[selectedDeck].find(({ id }) => id === selectedCardId);
}

function applyCardForm(form) {
  const card = currentCard();
  const data = new FormData(form);
  card.id = String(data.get('id')).trim();
  card.name = String(data.get('name')).trim();
  if ('target' in card) card.target = data.get('target');
  if ('severity' in card) card.severity = Number(data.get('severity'));
  if ('flavor' in card) card.flavor = String(data.get('flavor') ?? '');
  if ('prepHint' in card) card.prepHint = String(data.get('prepHint') ?? '');
  card.effects.forEach((effect, index) => {
    for (const key of Object.keys(effect).filter((name) => name !== 'type')) {
      const raw = data.get(`effect.${index}.${key}`);
      if (typeof effect[key] === 'number') effect[key] = Number(raw);
      else if (typeof effect[key] === 'boolean') effect[key] = raw === 'true';
      else if (effect[key] && typeof effect[key] === 'object') effect[key] = JSON.parse(raw);
      else effect[key] = String(raw);
    }
    const replacement = String(data.get(`effectReplacement.${index}`) ?? '').trim();
    if (replacement) card.effects[index] = JSON.parse(replacement);
  });
  return card;
}

root.addEventListener('submit', async (event) => {
  if (event.target.id === 'owner-card-form') {
    event.preventDefault();
    busy = true;
    message = '';
    try {
      const savedId = applyCardForm(event.target).id;
      draft = await owner.content('saveDraft', { cardSetId: draft.id, deck: draft.deck });
      selectedCardId = savedId;
      draftDirty = false;
      contentOverview = await owner.content('overview');
      message = 'Draft saved and canonical validation passed.';
    } catch (error) {
      message = error.message;
    } finally {
      busy = false;
      render();
    }
    return;
  }
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
  if (event.target.id === 'owner-draft-select' && event.target.value) {
    busy = true;
    owner.content('loadDraft', { cardSetId: event.target.value })
      .then((value) => { draft = value; draftDirty = false; selectedCardId = null; message = ''; })
      .catch((error) => { message = error.message; })
      .finally(() => { busy = false; render(); });
  }
  if (event.target.matches('[data-effect-type]')) {
    const index = Number(event.target.dataset.effectType);
    currentCard().effects[index] = { type: event.target.value, value: 1 };
    draftDirty = true;
    render();
  }
});

root.addEventListener('input', (event) => {
  if (!event.target.closest('#owner-card-form')) return;
  draftDirty = true;
  root.querySelectorAll('[data-deck], [data-card-id], [data-duplicate-card], [data-remove-card], [data-add-effect], [data-remove-effect], [data-effect-type], #owner-publish')
    .forEach((button) => { button.disabled = true; });
});

root.addEventListener('click', async (event) => {
  const sectionButton = event.target.closest('[data-owner-section]');
  if (sectionButton) {
    section = sectionButton.dataset.ownerSection;
    message = '';
    render();
    if (section === 'cards' && !contentOverview) loadContent();
    return;
  }
  const deckButton = event.target.closest('[data-deck]');
  if (deckButton) {
    selectedDeck = deckButton.dataset.deck;
    selectedCardId = null;
    render();
    return;
  }
  const cardButton = event.target.closest('[data-card-id]');
  if (cardButton) {
    selectedCardId = cardButton.dataset.cardId;
    render();
    return;
  }
  if (event.target.closest('[data-duplicate-card]')) {
    const copy = structuredClone(currentCard());
    copy.id = `${copy.id}-COPY-${String(Date.now()).slice(-4)}`;
    copy.name = `${copy.name} (Copy)`;
    draft.deck[selectedDeck].push(copy);
    selectedCardId = copy.id;
    draftDirty = true;
    render();
    return;
  }
  if (event.target.closest('[data-remove-card]')) {
    draft.deck[selectedDeck] = draft.deck[selectedDeck].filter(({ id }) => id !== selectedCardId);
    selectedCardId = draft.deck[selectedDeck][0]?.id ?? null;
    draftDirty = true;
    render();
    return;
  }
  if (event.target.closest('[data-add-effect]')) {
    const vocabulary = selectedDeck === 'fortuneCards' || selectedDeck === 'crisisCards'
      ? draft.deck.playerCardEffectVocabulary : draft.deck.effectTypeVocabulary;
    currentCard().effects.push({ type: Object.keys(vocabulary)[0], value: 1 });
    draftDirty = true;
    render();
    return;
  }
  const removeEffect = event.target.closest('[data-remove-effect]');
  if (removeEffect) {
    currentCard().effects.splice(Number(removeEffect.dataset.removeEffect), 1);
    draftDirty = true;
    render();
    return;
  }
  if (event.target.id === 'owner-new-draft') {
    busy = true;
    try {
      draft = await owner.content('createDraft');
      draftDirty = false;
      contentOverview = await owner.content('overview');
      selectedCardId = null;
      message = 'Draft created from the active published deck.';
    } catch (error) {
      message = error.message;
    } finally {
      busy = false;
      render();
    }
    return;
  }
  if (event.target.id === 'owner-publish') {
    if (draftDirty) {
      message = 'Save and validate the draft before publishing.';
      render();
      return;
    }
    busy = true;
    try {
      const published = await owner.content('publish', { cardSetId: draft.id });
      draft = null;
      draftDirty = false;
      contentOverview = await owner.content('overview');
      message = `Version ${published.version} is active for new matches.`;
    } catch (error) {
      message = error.message;
    } finally {
      busy = false;
      render();
    }
    return;
  }
  if (event.target.id === 'owner-sign-out') {
    await owner.signOut();
    session = null;
    dashboard = null;
    contentOverview = null;
    draft = null;
    draftDirty = false;
    message = '';
    render();
  }
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

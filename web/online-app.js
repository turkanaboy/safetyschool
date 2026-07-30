import { createClient } from '/vendor/supabase.js';
import { validateContent } from '/engine/content.js';
import { CAMPUS_COLORS, MASCOTS, dumpRankings } from '/game.js';
import { renderOnlineManagement } from '/online-management.js';
import {
  annualReport,
  emergencySaleOptions,
  finalIssue,
  presentationRecords,
} from '/presentation.js';
import {
  applyCampusEnvironment,
  campusPresentation,
  clearCampusEnvironment,
  renderCampusBoard,
  startCampusMotion,
} from '/online-campus.js';
import {
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
  createOnlineService,
  normalizeLobbyCode,
  selectMatchRecord,
} from '/online.js';

const root = document.querySelector('#online-root');
const eventDialog = document.querySelector('#online-event-dialog');
const eventTitle = document.querySelector('#online-event-title');
const eventContent = document.querySelector('#online-event-content');
const eventActions = document.querySelector('#online-event-actions');
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
let campusRuntime = null;
let characterRuntime = null;
let content = null;
let campusLoad = null;
let campusAssetError = '';
let contentMatchId = null;
let previousDepartmentLevels = null;
let stopCampusMotion = null;
let activeManagementSection = null;
let selectedOnlineRival = null;
let presentationMatchId = null;
let presentationVersion = null;
let presentationQueue = [];
let currentPresentation = null;
let stagedAusterity = new Set();
let lobbySetupId = null;
let lobbySetupDraft = null;
let lobbySetupDirty = false;

const departmentNames = {
  academics: 'Academics',
  administration: 'Administration',
  admissions: 'Admissions',
  athletics: 'Athletics',
  marketing: 'Marketing',
  studentAffairs: 'Student Affairs',
};

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

function defaultLobbySetup() {
  return {
    schoolName: profile?.display_name ?? 'Safety School',
    mascot: MASCOTS[0].id,
    color: CAMPUS_COLORS[0].id,
    upgrades: { academics: 1, studentAffairs: 1, administration: 1 },
  };
}

function syncLobbySetupDraft(lobby, member) {
  if (lobbySetupId !== lobby.id) {
    lobbySetupId = lobby.id;
    lobbySetupDraft = structuredClone(member?.setup ?? defaultLobbySetup());
    lobbySetupDirty = false;
  } else if (!lobbySetupDirty && member?.setup) {
    lobbySetupDraft = structuredClone(member.setup);
  }
}

function setupSummary(setup) {
  if (!setup) return 'Founding plan not saved';
  return Object.entries(setup.upgrades)
    .filter(([, levels]) => levels > 0)
    .map(([department, levels]) => `${departmentNames[department]} +${levels}`)
    .join(' / ');
}

function renderMessage() {
  return message ? `<p class="online-message" role="status">${escapeHtml(message)}</p>` : '';
}

function resetMatchShell() {
  stopCampusMotion?.();
  stopCampusMotion = null;
  presentationMatchId = null;
  presentationVersion = null;
  presentationQueue = [];
  currentPresentation = null;
  stagedAusterity = new Set();
  if (eventDialog.open) eventDialog.close();
  root.className = 'online-shell';
  document.body.classList.remove('online-match-page');
  delete document.body.dataset.color;
  clearCampusEnvironment();
  previousDepartmentLevels = null;
}

function ensureCampusAssets() {
  if (campusLoad && contentMatchId === activeMatchId) return campusLoad;
  contentMatchId = activeMatchId;
  campusLoad = Promise.all([
    fetch('/assets/university-quad/Runtime/runtime-manifest.json'),
    fetch('/assets/university-quad/Runtime/Characters/student-actions.json'),
    fetch('/balance-config.json'),
    fetch('/cards.json'),
  ]).then(async (responses) => {
    if (responses.some((response) => !response.ok)) throw new Error('The campus art package could not be loaded.');
    const [runtime, characters, config, bundledCards] = await Promise.all(responses.map((response) => response.json()));
    const pinned = activeMatchId ? await online.matchContent(activeMatchId) : null;
    const cards = pinned?.deck ?? bundledCards;
    const validated = validateContent(config, cards);
    if (pinned?.contentHash && validated.identity.cardsDigest !== pinned.contentHash) {
      throw new Error('The match card set did not pass its identity check.');
    }
    campusRuntime = runtime;
    characterRuntime = characters;
    content = validated;
    campusAssetError = '';
    render();
  }).catch((error) => {
    campusRuntime = null;
    characterRuntime = null;
    campusLoad = null;
    campusAssetError = error.message;
    render();
  });
  return campusLoad;
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

function formatMoney(value, signed = false) {
  return `${value < 0 ? '−' : signed && value > 0 ? '+' : ''}$${Math.abs(value).toFixed(1)}m`;
}

function formatNumber(value) {
  return Math.round(value).toLocaleString();
}

function schoolName(view, playerId) {
  return view.players.find((player) => player.id === playerId)?.name ?? playerId;
}

function percentChange(value) {
  return `${Math.round(Math.abs(value - 1) * 100)}% ${value >= 1 ? 'increase' : 'decrease'}`;
}

function headlineEffect(effect) {
  if (effect.type === 'noOp') return ['neutral', 'No rule change this term.'];
  if (effect.type === 'tuitionMultiplier') return [effect.value >= 1 ? 'positive' : 'negative', `Tuition income: ${percentChange(effect.value)}.`];
  if (effect.type === 'poolAllotmentMultiplier') return [effect.value >= 1 ? 'positive' : 'negative', `Applicant pool: ${percentChange(effect.value)}.`];
  if (effect.type === 'allUpkeepMultiplier') return [effect.value <= 1 ? 'positive' : 'negative', `All upkeep: ${percentChange(effect.value)}.`];
  if (effect.type === 'departmentUpkeepMultiplier') return [effect.value <= 1 ? 'positive' : 'negative', `${departmentNames[effect.department]} upkeep: ${percentChange(effect.value)}.`];
  if (effect.type === 'allPullMultiplier') return [effect.value >= 1 ? 'positive' : 'negative', `All recruiting pull: ${percentChange(effect.value)}.`];
  if (effect.type === 'campaignPullMultiplier') return [effect.value >= 1 ? 'positive' : 'negative', `Campaign recruiting pull: ${percentChange(effect.value)}.`];
  if (effect.type === 'programPullMultiplier') return [effect.value >= 1 ? 'positive' : 'negative', `${titleCase(effect.program)} recruiting pull: ${percentChange(effect.value)} for campuses offering it.`];
  if (effect.type === 'yieldMultiplier') return [effect.value >= 1 ? 'positive' : 'negative', `All recruiting yield: ${percentChange(effect.value)}.`];
  if (effect.type === 'reputationDeltaAll') return [effect.value >= 0 ? 'positive' : 'negative', `Every campus: ${effect.value > 0 ? '+' : ''}${effect.value} reputation.`];
  if (effect.type === 'moneyDeltaAll') return [effect.value >= 0 ? 'positive' : 'negative', `Every campus: ${formatMoney(effect.value, true)} treasury.`];
  if (effect.type === 'programMoneyDelta') return [effect.value >= 0 ? 'positive' : 'negative', `${titleCase(effect.program)} campuses: ${formatMoney(effect.value, true)} treasury.`];
  if (effect.type === 'poachCostDelta') return [effect.value <= 0 ? 'positive' : 'negative', `Recruiting from a rival costs ${formatMoney(Math.abs(effect.value))} ${effect.value > 0 ? 'more' : 'less'} this term.`];
  return ['neutral', titleCase(effect.type)];
}

function effectResult(effect) {
  if (effect.skipped) return `${effect.program ? titleCase(effect.program) : 'Required Program'} not held`;
  if (effect.result === null) return effect.scalable ? `Scaled by ×${Number(effect.multiplier.toFixed(2))}` : 'Rule modifier applied';
  if (effect.type === 'money') return formatMoney(effect.result, true);
  if (effect.type.includes('Conversions') || effect.type.includes('Capacity') || effect.type === 'extraActionsNextRound') {
    return `${effect.result > 0 ? '+' : ''}${formatNumber(effect.result)}`;
  }
  if (effect.type.includes('retention') || effect.type.includes('YieldFloor') || effect.type === 'upkeepRefundFraction') {
    return `${effect.result > 0 ? '+' : ''}${Number((effect.result * 100).toFixed(2))} points`;
  }
  if (effect.type.includes('Multiplier') || effect.type.includes('Penalty')) return `×${Number(effect.result.toFixed(2))}`;
  return `${effect.result > 0 ? '+' : ''}${Number(effect.result.toFixed(2))}`;
}

function cardPresentation(record, view) {
  const own = record.kind === 'playerCard';
  const type = record.cardKind === 'fortune' ? 'Fortune — helps that campus' : 'Crisis — hurts that campus';
  const effects = record.effects?.map((effect) => `<li class="is-${record.cardKind === 'fortune' ? 'positive' : 'negative'} ${effect.skipped ? 'is-skipped' : ''}"><span>${escapeHtml(effect.label)}</span><strong>${escapeHtml(effectResult(effect))}</strong></li>`).join('') ?? '';
  return `<div class="ceremony ceremony--${escapeHtml(record.cardKind)}">
    <p class="eyebrow">Resolved card · Severity ${record.severity}</p>
    <div class="card-orientation">
      <span><small>Applies to</small><strong>${escapeHtml(schoolName(view, record.playerId))}${own ? ' (you)' : ''}</strong></span>
      <span><small>Card type</small><strong>${escapeHtml(type)}</strong></span>
      <span><small>Target</small><strong>${escapeHtml(record.target ? departmentNames[record.target] : 'Campus-wide')}</strong></span>
      <span><small>Your action</small><strong>${own && record.cardKind === 'crisis' ? 'Resolved unless Administration offered a choice' : 'None — already resolved'}</strong></span>
    </div>
    ${record.flavor ? `<blockquote>${escapeHtml(record.flavor)}</blockquote>` : ''}
    ${own ? `<div class="calculation-strip"><span><small>${escapeHtml(departmentNames[record.target])} level</small><strong>${record.targetLevel}</strong></span><span><small>Building factor</small><strong>×${Number(record.targetFactor.toFixed(2))}</strong></span><span><small>Severity factor</small><strong>×${Number(record.severityFactor.toFixed(2))}</strong></span><span><small>Final factor</small><strong>×${Number(record.factor.toFixed(2))}</strong></span></div><ul class="effect-list">${effects}</ul>` : '<p>A consequential rival card changed the competitive field. Its public outcome is in the Board Book.</p>'}
  </div>`;
}

function annualReportPresentation(view) {
  const report = annualReport(view, content, view.year);
  return `<div class="ceremony ceremony--report">
    <p class="eyebrow">Mandatory report to the Board</p>
    <div class="report-grid">
      <span><small>Tuition collected</small><strong>${formatMoney(report.tuition)}</strong></span>
      <span><small>Upkeep paid</small><strong>${formatMoney(report.upkeep)}</strong></span>
      <span><small>Students recruited</small><strong>${formatNumber(report.recruiting)}</strong></span>
      <span><small>Graduates</small><strong>${formatNumber(report.graduates)}</strong></span>
      <span><small>Donations &amp; grants</small><strong>${formatMoney(report.donations)}</strong></span>
      <span><small>Closing treasury</small><strong>${formatMoney(report.endingTreasury)}</strong></span>
      <span><small>DUMP standing</small><strong>${report.dumpRank ? `#${report.dumpRank}` : 'Unranked'}</strong></span>
    </div>
    ${report.nextDisruption ? `<section class="disruption-brief"><small>Public outlook · Year ${report.year + 1}</small><strong>${escapeHtml(report.nextDisruption.title)}</strong><p>${escapeHtml(report.nextDisruption.prepHint)}</p></section>` : ''}
    ${report.privateLookahead ? `<section class="disruption-brief disruption-brief--private"><small>Administration foresight · confidential</small><strong>${escapeHtml(report.privateLookahead.title)}</strong><p>${escapeHtml(report.privateLookahead.prepHint)}</p></section>` : ''}
  </div>`;
}

function finalPresentation(view) {
  const issue = finalIssue(view, content);
  const scores = issue.scoreboard.map((school) => `<li><span>${school.playerId === issue.winnerId ? '<b>WINNER</b> ' : ''}${escapeHtml(school.name)}${school.playerId === view.own.id ? ' (You)' : ''}</span><strong>${school.score.toFixed(1)}</strong></li>`).join('');
  return `<div class="ceremony ceremony--final"><p class="special-issue">DUMP Rankings Special Issue</p><p class="eyebrow">Definitive Ultimate Marketing Ploy</p><h3>${issue.winnerId === view.own.id ? 'You win' : `${escapeHtml(issue.winnerName)} wins`}</h3><p>${escapeHtml(issue.explanation)}</p>${scores ? `<section><h4>Final Institutional Health Scores</h4><ol class="history-list final-score-list">${scores}</ol></section>` : ''}${issue.turningPoints.length ? `<section><h4>Turning points</h4><ol class="history-list">${issue.turningPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ol></section>` : ''}</div>`;
}

function termLabel(view, next = false) {
  const roundsPerYear = view.roundsPerYear ?? 5;
  const round = Math.max(1, view.round + (next ? 1 : 0));
  const year = Math.ceil(round / roundsPerYear);
  const term = ((round - 1) % roundsPerYear) + 1;
  return `Year ${year} · Term ${term}`;
}

function showNextPresentation() {
  if (eventDialog.open || !presentationQueue.length) return;
  currentPresentation = presentationQueue.shift();
  const { item, view } = currentPresentation;

  if (item.kind === 'headline') {
    const effects = item.effects.map((effect) => {
      const [tone, description] = headlineEffect(effect);
      return `<li class="is-${tone}">${escapeHtml(description)}</li>`;
    }).join('');
    eventTitle.textContent = item.title;
    eventContent.innerHTML = `<div class="ceremony ceremony--headline"><p class="eyebrow">Shared Headline · applies to every active campus</p><div class="card-orientation"><span><small>Who it affects</small><strong>Every active campus</strong></span><span><small>When</small><strong>This term only</strong></span><span><small>Your action</small><strong>Review, then choose actions</strong></span></div><blockquote>${escapeHtml(item.flavor)}</blockquote><section class="headline-rule"><strong>Rule in effect</strong><ul>${effects}</ul></section></div>`;
  } else if (item.kind === 'playerCard' || item.kind === 'rivalCard') {
    eventTitle.textContent = item.title;
    eventContent.innerHTML = cardPresentation(item, view);
  } else if (item.kind === 'rivalAusterity') {
    eventTitle.textContent = `${schoolName(view, item.playerId)} enters austerity`;
    eventContent.innerHTML = '<div class="ceremony ceremony--crisis"><p class="eyebrow">Emergency bulletin</p><p>A rival board has begun selling assets. Its exact treasury remains private.</p></div>';
  } else if (item.kind === 'closure') {
    eventTitle.textContent = item.playerIds.length === 1 ? 'A campus closes' : 'Campuses close';
    eventContent.innerHTML = `<div class="ceremony ceremony--crisis"><p class="eyebrow">Field update</p><p>${escapeHtml(item.playerIds.map((id) => schoolName(view, id)).join(', '))} ${item.playerIds.length === 1 ? 'has' : 'have'} left the competition.</p></div>`;
  } else if (item.kind === 'annualReport') {
    eventTitle.textContent = `Year ${view.year} Annual Report`;
    eventContent.innerHTML = annualReportPresentation(view);
  } else {
    eventTitle.textContent = 'The final issue';
    eventContent.innerHTML = finalPresentation(view);
  }

  eventActions.innerHTML = `<button class="primary-button" type="button" data-continue-online-event>${item.kind === 'headline' ? 'Continue to Actions' : item.kind === 'finalIssue' ? 'Return to final campus' : 'Continue'}</button>`;
  eventDialog.showModal();
  eventActions.querySelector('button').focus();
}

function enqueuePresentations(record) {
  if (presentationMatchId !== record.match_id) {
    presentationMatchId = record.match_id;
    presentationVersion = null;
    presentationQueue = [];
    currentPresentation = null;
    stagedAusterity = new Set();
    if (eventDialog.open) eventDialog.close();
  }
  if (presentationVersion === record.version) return;
  presentationVersion = record.version;
  const records = presentationRecords(record.view.latestEvents ?? [], {
    humanId: record.view.own.id,
    content,
    stagedAusterity,
  });
  presentationQueue.push(...records.queue.map((item) => ({ item, view: record.view })));
  showNextPresentation();
}

function completePresentation() {
  if (!currentPresentation) return;
  const headline = currentPresentation.item.kind === 'headline';
  currentPresentation = null;
  eventDialog.close();
  if (headline) requestAnimationFrame(() => root.querySelector('.online-match-action button, .online-match-action input')?.focus());
}

function renderEmergencyMeeting(view) {
  const options = emergencySaleOptions(view, content);
  return `<div class="emergency-layout">
    <section class="emergency-heading"><p class="eyebrow">Required decision</p><h2>Emergency Board Meeting</h2><p>The campus is below the solvency threshold. Sell one eligible building level at a time until the engine clears the emergency.</p><div class="emergency-status"><span><small>Current treasury</small><strong>${formatMoney(view.own.treasury)}</strong></span><span><small>Reputation</small><strong>${formatNumber(view.own.reputation)}</strong></span></div></section>
    <section><h3>Choose the next fire sale</h3><div class="emergency-options">${options.map((option, index) => `<button type="button" data-online-action="match-decision" data-command-index="${index}"><span><strong>${escapeHtml(departmentNames[option.department])}</strong><small>Level ${view.own.departments[option.department]} → ${view.own.departments[option.department] - 1}</small></span><span><b>${formatMoney(option.recovery)} recovered</b><small>${formatMoney(option.upkeepSaved)} upkeep saved · −${option.reputationLost} reputation</small></span></button>`).join('')}</div><p class="projection-note">If another sale is required, the meeting remains available from Briefing.</p></section>
  </div>`;
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
  syncLobbySetupDraft(lobby, ownMember);
  const isHost = lobby.host_user_id === session.user.id;
  const canStart = isHost && members.length >= 2 && members.every((member) => member.setup && member.is_ready);
  const seats = Array.from({ length: 4 }, (_, seat) => {
    const member = members.find((candidate) => candidate.seat_index === seat);
    if (!member) return `<li class="online-seat online-seat--ai"><span>AI</span><div><strong>AI campus</strong><small>Fills this seat when play begins</small></div></li>`;
    const memberProfile = profileOf(member);
    if (member.setup) {
      const mascot = MASCOTS.find(({ id }) => id === member.setup.mascot);
      return `<li class="online-seat"><span>${escapeHtml(mascot?.mark ?? 'SS')}</span><div><strong>${escapeHtml(member.setup.schoolName)}${member.user_id === lobby.host_user_id ? ' / Host' : ''}${member.user_id === session.user.id ? ' / You' : ''}</strong><small>${escapeHtml(setupSummary(member.setup))}</small><small>${member.is_ready ? 'Ready' : 'Plan saved / not ready'}</small></div></li>`;
    }
    return `<li class="online-seat"><span>${escapeHtml((memberProfile?.display_name ?? 'P').slice(0, 2).toUpperCase())}</span><div><strong>${escapeHtml(memberProfile?.display_name ?? 'President')}${member.user_id === lobby.host_user_id ? ' · Host' : ''}${member.user_id === session.user.id ? ' · You' : ''}</strong><small>${member.is_ready ? 'Ready' : 'Not ready'}</small></div></li>`;
  }).join('');
  const setupTotal = Object.values(lobbySetupDraft.upgrades).reduce((sum, levels) => sum + levels, 0);
  const setupRows = Object.keys(departmentNames).map((department) => {
    const levels = lobbySetupDraft.upgrades[department] ?? 0;
    return `<div class="online-setup-level"><span><strong>${departmentNames[department]}</strong><small>Starts at Level ${levels + 1}</small></span><span><button type="button" data-lobby-setup-department="${department}" data-lobby-setup-delta="-1" aria-label="Remove a free ${departmentNames[department]} level" ${levels === 0 ? 'disabled' : ''}>-</button><output>${levels}</output><button type="button" data-lobby-setup-department="${department}" data-lobby-setup-delta="1" aria-label="Add a free ${departmentNames[department]} level" ${levels === 2 || setupTotal === 3 ? 'disabled' : ''}>+</button></span></div>`;
  }).join('');
  const shareUrl = `${location.origin}/online.html?join=${lobby.invite_code}`;
  root.innerHTML = `
    <header class="online-header"><button class="secondary-button" type="button" data-online-action="back-to-lobbies">← Lobbies</button><div><p class="eyebrow">Private lobby</p><h1>${escapeHtml(lobby.invite_code)}</h1></div></header>
    ${renderMessage()}
    <section class="online-card online-invite"><div><h2>Invite presidents</h2><p>Share this code or link. Lobby membership is protected by row-level security.</p></div><div><strong>${escapeHtml(lobby.invite_code)}</strong><button class="primary-button" type="button" data-online-action="copy-invite" data-share-url="${escapeHtml(shareUrl)}">Copy invite link</button></div></section>
    <ol class="online-seats">${seats}</ol>
    <section class="online-card online-setup-card">
      <div><p class="eyebrow">Your campus</p><h2>Founding plan</h2><p>Name your school and assign exactly three free levels. No department can receive more than two.</p></div>
      <form id="lobby-setup-form" class="online-setup-form">
        <label class="online-setup-name">School name<input name="schoolName" maxlength="42" required value="${escapeHtml(lobbySetupDraft.schoolName)}" autocomplete="organization"></label>
        <fieldset><legend>Mascot</legend><div class="online-setup-presets">${MASCOTS.map((mascot) => `<label><input type="radio" name="mascot" value="${mascot.id}" ${lobbySetupDraft.mascot === mascot.id ? 'checked' : ''}><span><b>${mascot.mark}</b>${mascot.name}</span></label>`).join('')}</div></fieldset>
        <fieldset><legend>Campus colors</legend><div class="online-setup-presets">${CAMPUS_COLORS.map((color) => `<label><input type="radio" name="color" value="${color.id}" ${lobbySetupDraft.color === color.id ? 'checked' : ''}><span>${color.name}</span></label>`).join('')}</div></fieldset>
        <section class="online-setup-levels"><header><strong>Founding investments</strong><output>${setupTotal}/3 placed</output></header>${setupRows}</section>
        <button class="primary-button" type="submit" ${!lobbySetupDirty && ownMember?.setup ? 'disabled' : ''}>${ownMember?.setup ? 'Save changes' : 'Save founding plan'}</button>
      </form>
    </section>
    <section class="online-card online-lobby-actions"><div><h2>${members.length} human player${members.length === 1 ? '' : 's'}</h2><p>${canStart ? 'Everyone is ready. Start the game when you are set.' : 'Each human must save a founding plan and mark ready. Empty seats become AI schools.'}</p></div><div><button class="primary-button" type="button" data-online-action="toggle-ready">${ownMember?.is_ready ? 'Mark not ready' : 'Mark ready'}</button>${isHost ? `<button class="primary-button" type="button" data-online-action="start-match" ${canStart ? '' : 'disabled'}>Start game</button>` : ''}<button class="danger-button" type="button" data-online-action="leave-lobby">${isHost ? 'Cancel lobby' : 'Leave lobby'}</button></div></section>
    <p class="online-note">Saving a changed founding plan automatically clears Ready so every player sees the final setup before play begins.</p>`;
  root.querySelector('[data-online-action="toggle-ready"]').disabled = !ownMember?.setup || lobbySetupDirty;
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

function managementButton(section, label, emergency) {
  const disabled = emergency && section !== 'briefing';
  return `<button type="button" data-online-section="${section}" aria-pressed="${activeManagementSection === section}" ${disabled ? 'disabled' : ''}>${emergency && section === 'briefing' ? 'Emergency Board Meeting' : label}</button>`;
}

function updateManagementTray(section) {
  const record = matchRecords.find((candidate) => candidate.match_id === activeMatchId);
  if (!record || !content) return;
  const emergency = record.view.pendingDecision?.type === 'forcedSale';
  if (emergency) section = 'briefing';
  const tray = root.querySelector('#online-management-tray');
  const trayContent = root.querySelector('#online-management-content');
  if (section === 'actions') {
    activeManagementSection = null;
    tray?.setAttribute('aria-hidden', 'true');
    root.querySelectorAll('[data-online-section]').forEach((button) => button.setAttribute('aria-pressed', 'false'));
    const rail = root.querySelector('.online-match-rail');
    rail?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    rail?.querySelector('button, input')?.focus();
    return;
  }
  activeManagementSection = activeManagementSection === section ? null : section;
  root.querySelectorAll('.management__actions [data-online-section]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.onlineSection === activeManagementSection));
  });
  tray?.setAttribute('aria-hidden', String(!activeManagementSection));
  if (trayContent) {
    trayContent.innerHTML = activeManagementSection
      ? emergency ? renderEmergencyMeeting(record.view) : renderOnlineManagement(activeManagementSection, record.view, content, selectedOnlineRival)
      : '';
  }
}

function renderMatch(record) {
  stopCampusMotion?.();
  stopCampusMotion = null;
  const view = record.view;
  document.body.dataset.color = view.identity?.color ?? 'pine';
  const emergency = view.pendingDecision?.type === 'forcedSale';
  if (emergency && activeManagementSection !== 'briefing') activeManagementSection = null;
  const status = matchStatus(record) ?? record.status;
  const term = termLabel(view);
  const nextTerm = termLabel(view, true);
  if (!campusRuntime || !characterRuntime || !content) {
    root.className = 'online-shell';
    root.innerHTML = `<span class="startup__seal" aria-hidden="true">SS</span><p class="eyebrow">Online campus</p><h1>${campusAssetError ? 'Campus art unavailable' : 'Opening your campus'}</h1><p>${escapeHtml(campusAssetError || 'Placing buildings, students, and the board for live play…')}</p>${campusAssetError ? '<button class="primary-button" type="button" data-online-action="retry-campus">Try again</button>' : ''}`;
    if (!campusAssetError) void ensureCampusAssets();
    return;
  }

  root.className = 'game-shell online-game-shell';
  document.body.classList.add('online-match-page');
  const campus = campusPresentation(view.own, campusRuntime);
  applyCampusEnvironment(campus.condition);
  const rankingsMarkup = dumpRankings(view).map((school) => `<li class="${school.id === view.own.id ? 'is-player' : ''}"><span>${school.closed ? '×' : school.rank ?? '—'}</span> ${escapeHtml(school.id === view.own.id ? 'You' : school.name.replace(/ (University|College|Institute)$/, ''))}</li>`).join('');
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
  } else if (emergency) {
    action = `<section class="online-card online-match-action online-emergency-card"><p class="eyebrow">Required decision</p><h2>Emergency Board Meeting</h2><p>Your campus is insolvent. Review the exact recovery, upkeep relief, and reputation cost before authorizing a fire sale.</p><button class="primary-button" type="button" data-online-section="briefing">Open board meeting</button></section>`;
  } else if (view.legal?.kind === 'decision') {
    const choices = view.legal.commands.map((command, index) => `<button class="primary-button" type="button" data-online-action="match-decision" data-command-index="${index}">${escapeHtml(command.choice ? titleCase(command.choice) : `Sell ${titleCase(command.department)}`)}</button>`).join('');
    action = `<section class="online-card online-match-action"><p class="eyebrow">Your decision</p><h2>${escapeHtml(titleCase(view.pendingDecision?.type))}</h2><div class="startup-actions">${choices}</div></section>`;
  } else {
    action = `<section class="online-card online-match-action"><p class="eyebrow">Shared turn</p><h2>Waiting for another president</h2><p>The match will update here automatically.</p></section>`;
  }

  root.innerHTML = `
    <header class="topbar online-match-topbar">
      <a class="wordmark" href="/"><span class="wordmark__crest" aria-hidden="true">SS</span><span>Safety School</span></a>
      <div class="rankings" aria-label="Definitive Ultimate Marketing Ploy rankings"><span class="rankings__label"><strong>DUMP</strong><small>Definitive Ultimate Marketing Ploy</small></span><ol>${rankingsMarkup}</ol></div>
      <div class="status-chip" data-tone="active"><small>Your campus · ${escapeHtml(term)}</small><strong>${escapeHtml(view.own.name)}</strong><span>${escapeHtml(campus.condition.label)} · Live multiplayer</span></div>
    </header>
    <main class="playing-area online-playing-area">
      <section class="board-stage online-campus-stage">${renderCampusBoard(view.own, campusRuntime, characterRuntime)}</section>
      <aside class="online-match-rail" aria-label="Current turn and match activity">
        ${renderMessage()}
        ${action}
        <section class="online-card online-match-record"><h2>Campuses</h2><ul class="online-match-list">${rivals}</ul><h2>Latest resolutions</h2><ul class="online-match-list">${events || '<li>The board is convening.</li>'}</ul></section>
      </aside>
    </main>
    <footer class="management online-match-hud">
      <nav class="management__actions" aria-label="Campus management">
        ${managementButton('briefing', 'Briefing', emergency)}
        ${managementButton('actions', 'Actions', emergency)}
        ${managementButton('programs', 'Programs', emergency)}
        ${managementButton('rivals', 'Rivals', emergency)}
        ${managementButton('boardBook', 'Board Book', emergency)}
      </nav>
      <section class="management__summary" aria-label="Campus resources">
        <span><small>Treasury</small><b>${formatMoney(view.own.treasury)}</b></span>
        <span><small>Students</small><b>${formatNumber(view.own.students)}</b></span>
        <span><small>Reputation</small><b>${formatNumber(view.own.reputation)}</b></span>
        <span><small>Alumni</small><b>${formatNumber(view.own.alumni)}</b></span>
      </section>
      <section class="management__tray" id="online-management-tray" aria-hidden="${!activeManagementSection}">
        <button class="tray-handle" type="button" data-online-section="${activeManagementSection ?? 'briefing'}">Close</button>
        <div id="online-management-content">${activeManagementSection ? emergency ? renderEmergencyMeeting(view) : renderOnlineManagement(activeManagementSection, view, content, selectedOnlineRival) : ''}</div>
      </section>
    </footer>`;

  stopCampusMotion = startCampusMotion(root, campusRuntime);
  if (previousDepartmentLevels) {
    for (const [department, level] of Object.entries(view.own.departments)) {
      if (level > previousDepartmentLevels[department]) root.querySelector(`[data-department="${department}"]`)?.classList.add('is-building');
    }
  }
  previousDepartmentLevels = { ...view.own.departments };
  enqueuePresentations(record);
}

function render() {
  const match = matchRecords.find((record) => record.match_id === activeMatchId);
  if (match) return renderMatch(match);
  resetMatchShell();
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
  if (activeMatchId) await ensureCampusAssets();
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
    } else if (event.target.id === 'lobby-setup-form') {
      const total = Object.values(lobbySetupDraft.upgrades).reduce((sum, levels) => sum + levels, 0);
      if (total !== 3) throw new Error('Assign exactly three free founding levels.');
      lobbySetupDraft.schoolName = String(form.get('schoolName') ?? '').trim();
      lobbySetupDraft.mascot = String(form.get('mascot') ?? '');
      lobbySetupDraft.color = String(form.get('color') ?? '');
      const member = await online.saveSetup(activeLobbyId, lobbySetupDraft);
      lobbySetupDraft = structuredClone(member.setup);
      lobbySetupDirty = false;
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

root.addEventListener('input', (event) => {
  if (event.target.form?.id !== 'lobby-setup-form') return;
  lobbySetupDirty = true;
  if (event.target.name === 'schoolName') lobbySetupDraft.schoolName = event.target.value;
  if (event.target.name === 'mascot') lobbySetupDraft.mascot = event.target.value;
  if (event.target.name === 'color') lobbySetupDraft.color = event.target.value;
  root.querySelector('#lobby-setup-form button[type="submit"]').disabled = false;
  root.querySelector('[data-online-action="toggle-ready"]').disabled = true;
});

root.addEventListener('click', (event) => {
  const setupButton = event.target.closest('[data-lobby-setup-department]');
  if (setupButton) {
    const department = setupButton.dataset.lobbySetupDepartment;
    const delta = Number(setupButton.dataset.lobbySetupDelta);
    const total = Object.values(lobbySetupDraft.upgrades).reduce((sum, levels) => sum + levels, 0);
    const next = (lobbySetupDraft.upgrades[department] ?? 0) + delta;
    if (next >= 0 && next <= 2 && (delta < 0 || total < 3)) {
      lobbySetupDraft.upgrades[department] = next;
      lobbySetupDirty = true;
      render();
      root.querySelector(`[data-lobby-setup-department="${department}"][data-lobby-setup-delta="${delta}"]`)?.focus();
    }
    return;
  }
  const rival = event.target.closest('[data-online-rival]');
  if (rival) {
    selectedOnlineRival = rival.dataset.onlineRival;
    const record = matchRecords.find((candidate) => candidate.match_id === activeMatchId);
    const trayContent = root.querySelector('#online-management-content');
    if (record && trayContent) trayContent.innerHTML = renderOnlineManagement('rivals', record.view, content, selectedOnlineRival);
    return;
  }
  const section = event.target.closest('[data-online-section]');
  if (section) {
    updateManagementTray(section.dataset.onlineSection);
    return;
  }
  const button = event.target.closest('[data-online-action]');
  if (!button) return;
  perform(async () => {
    message = '';
    if (button.dataset.onlineAction === 'retry-profile') {
      profile = await online.profile(session.user.id);
      await refresh();
    } else if (button.dataset.onlineAction === 'retry-campus') {
      campusAssetError = '';
      await ensureCampusAssets();
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
      lobbySetupId = null;
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
      lobbySetupId = null;
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
      lobbySetupId = null;
      setOnlineUrl();
      await refresh();
    } else if (button.dataset.onlineAction === 'copy-invite') {
      await navigator.clipboard.writeText(button.dataset.shareUrl);
      message = 'Invite link copied.';
      render();
    }
  });
});

eventActions.addEventListener('click', (event) => {
  if (event.target.closest('[data-continue-online-event]')) completePresentation();
});
eventDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  completePresentation();
});
eventDialog.addEventListener('close', showNextPresentation);

window.addEventListener('pagehide', () => {
  stopSubscription?.();
  stopSubscription = null;
  subscribedKey = null;
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void refresh().catch(showError);
});
boot();

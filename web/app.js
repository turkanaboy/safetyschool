import { canonicalStringify, validateContent } from '/engine/content.js';
import { ENGINE_VERSION } from '/engine/index.js';
import {
  RIVAL_SCHOOLS,
  allocationSummary,
  buildingManagement,
  createSoloController,
  createSoloSession,
  dumpRankings,
  programManagement,
  rivalProfile,
  selectRivals,
  turnGuidance,
} from '/game.js';
import {
  discardSession,
  isStaleStorageEvent,
  loadSession,
  saveSession,
} from '/storage.js';
import {
  annualReport,
  boardBook,
  emergencySaleOptions,
  finalIssue,
  presentationRecords,
} from '/presentation.js';

const DEPARTMENTS = ['academics', 'studentAffairs', 'athletics', 'admissions', 'marketing', 'administration'];
const departmentNames = {
  academics: 'Academics',
  administration: 'Administration',
  admissions: 'Admissions',
  athletics: 'Athletics',
  marketing: 'Marketing',
  studentAffairs: 'Student Affairs',
};
const archetypeNames = {
  steadyHand: 'Steady operator',
  gambler: 'Big bet',
  prestigePlay: 'Prestige builder',
  fortress: 'Student fortress',
  oracle: 'Administrative oracle',
};
const mascots = [
  { id: 'owl', name: 'Night Owl', mark: 'OW' },
  { id: 'fox', name: 'Red Fox', mark: 'FX' },
  { id: 'bison', name: 'Golden Bison', mark: 'BI' },
];
const colors = [
  { id: 'pine', name: 'Pine & Gold' },
  { id: 'brick', name: 'Brick & Cream' },
  { id: 'lake', name: 'Lake & Silver' },
];

const startup = document.querySelector('#startup');
const setupPanel = document.querySelector('#setup-panel');
const gameShell = document.querySelector('.game-shell');
const status = document.querySelector('#game-status');
const trayButton = document.querySelector('.tray-handle');
const tray = document.querySelector('#management-tray');
const trayContent = document.querySelector('#tray-content');
const inspector = document.querySelector('#inspector-content');
const dialog = document.querySelector('#game-dialog');
const dialogTitle = document.querySelector('#dialog-title');
const dialogContent = document.querySelector('#dialog-content');
const dialogActions = document.querySelector('#dialog-actions');
const announcer = document.querySelector('#game-announcer');

let content = null;
let controller = null;
let revision = 0;
let setupDraft = null;
let selectedDepartment = 'academics';
let selectedRival = null;
let activeSection = 'briefing';
let activeSlot = 0;
let actionRegistry = new Map();
let uiMessage = '';
let saveWarning = '';
let pausedForStaleSave = false;
let presentationQueue = [];
let currentPresentation = null;
let presentationReturnFocus = null;
let presentationReturnSelector = null;
const numberFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function formatNumber(value) {
  return numberFormatter.format(value);
}

function formatMoney(value, signed = false) {
  const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  const absolute = Math.abs(value);
  const digits = Number.isInteger(absolute) ? 0 : 1;
  return `${sign}$${absolute.toFixed(digits)}m`;
}

function titleCase(value) {
  return String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase());
}

function shortSchoolName(value) {
  return String(value).replace(/ (University|College|Institute)$/, '');
}

function termLabel(view, next = false) {
  if (next && view.phase === 'ready') {
    return `Year ${Math.floor(view.round / content.config.gameLength.roundsPerYear) + 1} · Term ${(view.round % content.config.gameLength.roundsPerYear) + 1}`;
  }
  if (view.round === 0) return 'Preseason';
  return `Year ${view.year} · Term ${view.roundOfYear}`;
}

function campusFixture(view) {
  if (view.own.enteredAusterity || view.own.treasury < 0) return 'austerity';
  if (view.own.strainedRounds > 0 || view.own.treasury < 10) return 'strained';
  if (view.own.treasury >= 40 && view.own.reputation >= 55) return 'prosperous';
  return 'early';
}

function campusCondition(fixture) {
  return {
    early: 'Building momentum',
    prosperous: 'Campus thriving',
    strained: 'Margins tightening',
    austerity: 'Austerity measures',
  }[fixture];
}

function registerAction(action) {
  const key = `action-${actionRegistry.size}`;
  actionRegistry.set(key, structuredClone(action));
  return key;
}

function schoolName(view, playerId) {
  if (playerId === view.own.id) return view.own.name;
  return view.opponents.find((rival) => rival.id === playerId)?.name ?? playerId;
}

function actionLabel(action, view) {
  if (action.type === 'upgrade') return `Upgrade ${departmentNames[action.department]}`;
  if (action.type === 'sell') return `Sell one ${departmentNames[action.department]} level`;
  if (action.type === 'openProgram') return `Open ${titleCase(action.program)}`;
  if (action.type === 'campaign') return `Run ${formatMoney(action.spend)} campaign`;
  if (action.type === 'poach') return `Recruit from ${schoolName(view, action.targetPlayerId)}`;
  return 'Bank';
}

function actionCost(action, view) {
  const option = view.legal?.kind === 'allocation'
    ? view.legal.actions.find((candidate) => canonicalStringify(candidate.action) === canonicalStringify(action))
    : null;
  if (!option) return '';
  if (option.recovery) return `${formatMoney(option.recovery)} recovery`;
  return option.cost ? `${formatMoney(option.cost)} committed` : 'No spend';
}

function departmentEffect(department, level) {
  const config = content.config;
  if (department === 'admissions') {
    return `${formatNumber(level * config.departments.admissions.pullPerLevelPerRound)} applicant pull each term at ${Math.round(config.departments.admissions.baseYield * 100)}% base yield.`;
  }
  if (department === 'marketing') {
    return `Campaigns can commit up to ${formatMoney(config.departments.marketing.campaignSpendCapByLevel[level])} this term.`;
  }
  if (department === 'academics') {
    const rate = config.departments.academics.graduationRateBase + level * config.departments.academics.graduationRatePerLevel;
    return `${formatNumber(level * config.departments.academics.studentCapacityPerLevel)} student capacity and ${Math.round(rate * 100)}% graduation rate.`;
  }
  if (department === 'studentAffairs') {
    const retention = Math.min(config.departments.studentAffairs.retentionCap,
      config.departments.studentAffairs.retentionBase + level * config.departments.studentAffairs.retentionPerLevel);
    return `${(retention * 100).toFixed(1)}% annual retention before other effects.`;
  }
  if (department === 'athletics') {
    const odds = config.departments.athletics.seasonOddsByLevel[level];
    return `${Math.round(odds.great * 100)}% great season · ${Math.round(odds.good * 100)}% good · ${Math.round(odds.losing * 100)}% losing.`;
  }
  const unlocked = Object.entries(config.departments.administration.tiers)
    .filter(([tier]) => Number(tier) <= level)
    .map(([tier]) => `Level ${tier} policy`);
  return unlocked.length ? `${unlocked.join(' · ')} active.` : 'No Administration modifier is active yet.';
}

function eventDescription(event, view) {
  if (event.type === 'gameCreated') return 'The founding board approved the four-school field.';
  if (event.type === 'roundStarted') return `Year ${event.year}, Term ${event.roundOfYear} opened.`;
  if (event.type === 'headlineRevealed') {
    const card = content.cards.headlines.find((candidate) => candidate.id === event.cardId);
    return `${card?.name ?? event.cardId} set the terms of the round.`;
  }
  if (event.type === 'incomeResolved') {
    const own = event.players?.[view.own.id];
    return own ? `${formatMoney(own.tuition)} tuition less ${formatMoney(own.upkeep)} upkeep settled.` : 'Tuition and upkeep settled before allocation.';
  }
  if (event.type === 'recruitingResolved') {
    const own = event.players?.[view.own.id];
    return own ? `${formatNumber(own.totalConversions)} new students committed.` : 'The shared applicant pool resolved.';
  }
  if (event.type === 'actionResolved') return `${schoolName(view, event.playerId)}: ${actionLabel(event, view)}.`;
  if (event.type === 'cardResolved') {
    const source = event.kind === 'fortune' ? content.cards.fortuneCards : content.cards.crisisCards;
    const card = source.find((candidate) => candidate.id === event.cardId);
    return `${schoolName(view, event.playerId)} resolved ${card?.name ?? event.cardId}.`;
  }
  if (event.type === 'cardCancelled') return `${schoolName(view, event.playerId)} cancelled ${event.cardId}.`;
  if (event.type === 'strainApplied') {
    const penalty = Number.isFinite(event.reputationPenalty) ? ` and lost ${event.reputationPenalty} reputation` : '';
    return `${schoolName(view, event.playerId)} exceeded capacity${penalty}.`;
  }
  if (event.type === 'athleticsSeason') return `${schoolName(view, event.playerId)} had a ${event.outcome} athletics season.`;
  if (event.type === 'forcedSale') return `${schoolName(view, event.playerId)} sold a ${departmentNames[event.department]} level.`;
  if (event.type === 'playersEliminated') return `${event.playerIds.map((id) => schoolName(view, id)).join(', ')} closed.`;
  if (event.type === 'standingsPublished') return 'The DUMP annual standings were published.';
  if (event.type === 'graduationResolved' && event.playerId === view.own.id) return `${formatNumber(event.graduates)} students graduated.`;
  if (event.type === 'donationsResolved' && event.playerId === view.own.id) return `Alumni and grants contributed ${formatMoney(event.total)}.`;
  if (event.type === 'safetyNetAwarded') return `${schoolName(view, event.playerId)} received an emergency safety net.`;
  if (event.type === 'disruptionRevealed') {
    const card = content.cards.annualDisruptions.find((candidate) => candidate.id === event.cardId);
    return `${event.visibility === 'private' ? 'Administration previewed' : 'The field learned'} ${card?.name ?? event.cardId}.`;
  }
  if (event.type === 'gameFinished') return `${schoolName(view, event.winnerId)} won the game.`;
  return null;
}

function activityItems(view, limit = 7) {
  const items = [];
  for (const entry of view.history) {
    for (const event of entry.events) {
      if (event.type === 'actionsResolved') {
        for (const action of event.actions) items.push(eventDescription({ type: 'actionResolved', ...action }, view));
      } else {
        const description = eventDescription(event, view);
        if (description) items.push(description);
      }
    }
  }
  return items.filter(Boolean).slice(-limit).reverse();
}

function announceTransition(events) {
  if (!events.length || !controller) return;
  const view = controller.getView();
  const descriptions = [];
  for (const event of events) {
    if (event.type === 'actionsResolved') {
      for (const action of event.actions.filter((candidate) => candidate.playerId === view.own.id)) {
        descriptions.push(eventDescription({ type: 'actionResolved', ...action }, view));
      }
    } else {
      const description = eventDescription(event, view);
      if (description) descriptions.push(description);
    }
  }
  if (view.pendingDecision?.type === 'forcedSale') descriptions.push('Emergency Board Meeting. A building sale is required.');
  announcer.textContent = `${descriptions.filter(Boolean).slice(-2).join(' ')} Treasury ${formatMoney(view.own.treasury)}. Students ${formatNumber(view.own.students)}. Reputation ${formatNumber(view.own.reputation)}.`;
}

function syncSetupForm() {
  const form = document.querySelector('#new-game-form');
  if (!form || !setupDraft) return;
  const data = new FormData(form);
  setupDraft.name = String(data.get('schoolName') ?? setupDraft.name);
  setupDraft.mascot = String(data.get('mascot') ?? setupDraft.mascot);
  setupDraft.color = String(data.get('color') ?? setupDraft.color);
}

function randomSeed() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0];
}

function showStartup(markup) {
  startup.hidden = false;
  gameShell.inert = true;
  setupPanel.innerHTML = markup;
}

function hideStartup() {
  startup.hidden = true;
  gameShell.inert = false;
}

function renderSetup(error = '') {
  const total = Object.values(setupDraft.upgrades).reduce((sum, level) => sum + level, 0);
  const rivals = setupDraft.rivals.map((rival) => `
    <article class="setup-rival">
      <span>${escapeHtml(rival.name.slice(0, 2).toUpperCase())}</span>
      <div><strong>${escapeHtml(rival.name)}</strong><small>${escapeHtml(archetypeNames[rival.archetype])}</small></div>
    </article>`).join('');
  const upgradeRows = DEPARTMENTS.map((department) => {
    const level = setupDraft.upgrades[department];
    return `<div class="setup-upgrade">
      <span><strong>${escapeHtml(departmentNames[department])}</strong><small>Starts at Level ${level + 1}</small></span>
      <span class="setup-stepper">
        <button type="button" data-setup-department="${department}" data-setup-delta="-1" aria-label="Remove a free ${escapeHtml(departmentNames[department])} level" ${level === 0 ? 'disabled' : ''}>−</button>
        <output aria-label="${escapeHtml(departmentNames[department])} free levels">${level}</output>
        <button type="button" data-setup-department="${department}" data-setup-delta="1" aria-label="Add a free ${escapeHtml(departmentNames[department])} level" ${level === 2 || total === 3 ? 'disabled' : ''}>+</button>
      </span>
    </div>`;
  }).join('');
  showStartup(`
    <div class="setup-heading">
      <span class="startup__seal" aria-hidden="true">SS</span>
      <div><p class="eyebrow">New solo game</p><h1>Found your safety school</h1></div>
    </div>
    ${setupDraft.guideDismissed ? '' : `<aside class="setup-guide" aria-label="Setup guidance">
      <strong>Your first board meeting</strong>
      <p>The three rivals are already seated. Name your school, choose its look, then place exactly three free levels—no department can take more than two.</p>
      <button type="button" data-dismiss-setup-guide>Got it</button>
    </aside>`}
    ${error ? `<p class="form-error" role="alert">${escapeHtml(error)}</p>` : ''}
    <form id="new-game-form" class="setup-form">
      <section class="setup-column">
        <label class="field-label" for="school-name">School name</label>
        <input id="school-name" name="schoolName" maxlength="42" required value="${escapeHtml(setupDraft.name)}" autocomplete="organization">
        <fieldset><legend>Mascot</legend><div class="preset-grid">
          ${mascots.map((mascot) => `<label><input type="radio" name="mascot" value="${mascot.id}" ${setupDraft.mascot === mascot.id ? 'checked' : ''}><span><b>${mascot.mark}</b>${mascot.name}</span></label>`).join('')}
        </div></fieldset>
        <fieldset><legend>Campus colors</legend><div class="preset-grid preset-grid--colors">
          ${colors.map((color) => `<label><input type="radio" name="color" value="${color.id}" ${setupDraft.color === color.id ? 'checked' : ''}><span data-color-swatch="${color.id}">${color.name}</span></label>`).join('')}
        </div></fieldset>
        <div><p class="field-label">Your rivals</p><div class="setup-rivals">${rivals}</div></div>
      </section>
      <section class="setup-column setup-column--levels">
        <div class="setup-level-heading"><div><p class="field-label">Founding investments</p><h2>Assign three free levels</h2></div><output class="level-total">${total}<small>/ 3 placed</small></output></div>
        <div class="setup-upgrades">${upgradeRows}</div>
        <p class="setup-note">Programs are enabled. Every rival uses the same rules and receives no hidden bonus.</p>
        <button class="primary-button" type="submit" ${total !== 3 ? 'disabled' : ''}>Open the campus</button>
      </section>
    </form>`);
}

function openSetup(message = '') {
  const rivals = selectRivals();
  setupDraft = {
    seed: randomSeed(),
    rivals,
    upgrades: Object.fromEntries(DEPARTMENTS.map((department) => [department, 0])),
    name: 'Founders Green',
    mascot: mascots[0].id,
    color: colors[0].id,
    guideDismissed: false,
  };
  renderSetup(message);
  document.querySelector('#school-name')?.focus();
}

function showResume(envelope) {
  const session = envelope.session;
  const round = session.state.round;
  showStartup(`
    <span class="startup__seal" aria-hidden="true">SS</span>
    <p class="eyebrow">Local game found</p>
    <h1>Return to ${escapeHtml(session.human.name)}</h1>
    <p>${round === 0 ? 'The founding board is waiting.' : `Saved after Round ${round}.`} Your three-rival lineup and Board Book are intact.</p>
    <div class="startup-actions">
      <button class="primary-button" type="button" data-resume-game>Resume game</button>
      <button class="secondary-button" type="button" data-request-new-game>New game</button>
    </div>`);
}

function showInvalidSave(result) {
  showStartup(`
    <span class="startup__seal" aria-hidden="true">!</span>
    <p class="eyebrow">Save recovery</p>
    <h1>The Board Book cannot be opened</h1>
    <p>The stored game is ${escapeHtml(result.reason)}. It has not been overwritten or discarded.</p>
    <div class="startup-actions">
      <button class="primary-button" type="button" data-retry-startup>Try again</button>
      <button class="danger-button" type="button" data-discard-invalid-save>Discard and start new</button>
    </div>`);
}

function persist(session) {
  if (pausedForStaleSave) return;
  const result = saveSession(storage, session, content, { expectedRevision: revision });
  if (result.ok) {
    revision = result.envelope.revision;
    saveWarning = '';
    return;
  }
  if (result.reason === 'staleRevision') {
    pauseForStaleSave();
    return;
  }
  saveWarning = 'Autosave unavailable—this tab can continue, but progress may not survive a refresh.';
  status.textContent = 'Autosave warning';
}

function attachController(session) {
  controller = createSoloController({ session, content, onTransition: persist });
  selectedRival = session.rivals[0]?.id ?? null;
}

function resumeGame(envelope) {
  revision = envelope.revision;
  attachController(envelope.session);
  hideStartup();
  const result = controller.resume();
  renderGame();
  announceTransition(result.events);
  enqueuePresentation(result.presentationEvents, controller.getView().pendingDecision ? '[data-answer-decision]' : '[data-start-round]');
}

function openNewGameConfirmation() {
  dialogTitle.textContent = 'Start a new campus?';
  dialogContent.innerHTML = '<p>Your current local game will be discarded. This cannot be undone.</p>';
  dialogActions.innerHTML = `
    <button class="secondary-button" type="button" data-close-dialog>Keep current game</button>
    <button class="danger-button" type="button" data-confirm-new-game>Discard and start new</button>`;
  dialog.dataset.mandatory = 'false';
  dialog.dataset.purpose = 'confirmation';
  dialog.showModal();
  dialogActions.querySelector('[data-close-dialog]').focus();
}

function pauseForStaleSave() {
  if (pausedForStaleSave) return;
  pausedForStaleSave = true;
  if (dialog.open) {
    presentationQueue = [];
    currentPresentation = null;
    presentationReturnSelector = null;
    dialog.close();
  }
  gameShell.inert = true;
  dialogTitle.textContent = 'A newer game is open';
  dialogContent.innerHTML = '<p>Another tab saved a newer revision. This tab has paused so it cannot overwrite that progress.</p>';
  dialogActions.innerHTML = '<button class="primary-button" type="button" data-reload-game>Reload newer game</button>';
  dialog.dataset.mandatory = 'true';
  dialog.dataset.purpose = 'stale-save';
  dialog.showModal();
  dialogActions.querySelector('button').focus();
}

function signedNumber(value) {
  return `${value > 0 ? '+' : ''}${Number(value.toFixed(2))}`;
}

function effectResult(effect) {
  if (effect.skipped) return `${effect.program ? titleCase(effect.program) : 'Required Program'} not held`;
  if (effect.result === null) return effect.scalable ? `Scaled by x${Number(effect.multiplier.toFixed(2))}` : 'Rule modifier applied';
  if (effect.type === 'money') return formatMoney(effect.result, true);
  if (effect.type.includes('Conversions') || effect.type.includes('Capacity') || effect.type === 'extraActionsNextRound') {
    return `${effect.result > 0 ? '+' : ''}${formatNumber(effect.result)}`;
  }
  if (effect.type.includes('retention') || effect.type.includes('YieldFloor') || effect.type === 'upkeepRefundFraction') {
    return `${signedNumber(effect.result * 100)} points`;
  }
  if (effect.type.includes('Multiplier') || effect.type.includes('Penalty')) return `x${Number(effect.result.toFixed(2))}`;
  return signedNumber(effect.result);
}

function presentationCardMarkup(record, view) {
  const isPlayer = record.kind === 'playerCard';
  const school = isPlayer ? view.own.name : schoolName(view, record.playerId);
  const cardType = record.cardKind === 'fortune' ? 'Fortune — helps that campus' : 'Crisis — hurts that campus';
  const target = record.target ? departmentNames[record.target] : 'Campus-wide';
  const guide = isPlayer && !view.tutorial.cardDismissed
    ? '<aside class="ceremony-guide"><strong>How cards scale</strong><p>The targeted building sets the factor. Crisis severity may then fall through Administration. The displayed result is explanatory only; the engine has already resolved it once.</p></aside>'
    : '';
  const effects = record.effects?.map((effect) => `<li class="${effect.skipped ? 'is-skipped' : ''}"><span>${escapeHtml(effect.label)}</span><strong>${escapeHtml(effectResult(effect))}</strong></li>`).join('') ?? '';
  return `<div class="ceremony ceremony--${escapeHtml(record.cardKind)}">
    <p class="eyebrow">Resolved card &middot; Severity ${record.severity}</p>
    <div class="card-orientation">
      <span><small>Applies to</small><strong>${escapeHtml(school)}${isPlayer ? ' (you)' : ''}</strong></span>
      <span><small>Card type</small><strong>${escapeHtml(cardType)}</strong></span>
      <span><small>Target</small><strong>${escapeHtml(target)}</strong></span>
      <span><small>Your action</small><strong>${isPlayer && record.cardKind === 'crisis' ? 'Resolved unless Administration offered a choice' : 'None — already resolved'}</strong></span>
    </div>
    ${record.flavor ? `<blockquote>${escapeHtml(record.flavor)}</blockquote>` : ''}
    ${guide}
    ${isPlayer ? `<div class="calculation-strip"><span><small>${escapeHtml(departmentNames[record.target])} level</small><strong>${record.targetLevel}</strong></span><span><small>Building factor</small><strong>&times;${Number(record.targetFactor.toFixed(2))}</strong></span><span><small>Severity factor</small><strong>&times;${Number(record.severityFactor.toFixed(2))}</strong></span><span><small>Final factor</small><strong>&times;${Number(record.factor.toFixed(2))}</strong></span></div><ul class="effect-list">${effects}</ul>` : '<p>A consequential rival card has changed the competitive field. Its public outcome is recorded in the Board Book.</p>'}
  </div>`;
}

function annualReportMarkup(view) {
  const report = annualReport(view, content, view.year);
  const guide = view.tutorial.reportDismissed
    ? ''
    : '<aside class="ceremony-guide"><strong>Your first annual close</strong><p>This report reconciles the year that just ended and reveals only the disruption information your Administration has earned.</p></aside>';
  return `<div class="ceremony ceremony--report">
    <p class="eyebrow">Mandatory report to the Board</p>
    ${guide}
    <div class="report-grid">
      <span><small>Tuition collected</small><strong>${formatMoney(report.tuition)}</strong></span>
      <span><small>Upkeep paid</small><strong>${formatMoney(report.upkeep)}</strong></span>
      <span><small>Students recruited</small><strong>${formatNumber(report.recruiting)}</strong></span>
      <span><small>Graduates</small><strong>${formatNumber(report.graduates)}</strong></span>
      <span><small>Donations & grants</small><strong>${formatMoney(report.donations)}</strong></span>
      <span><small>Closing treasury</small><strong>${formatMoney(report.endingTreasury)}</strong></span>
      <span><small>DUMP standing</small><strong>${report.dumpRank ? `#${report.dumpRank} ${report.dumpMovement > 0 ? `&uarr;${report.dumpMovement}` : report.dumpMovement < 0 ? `&darr;${Math.abs(report.dumpMovement)}` : '&mdash;'}` : 'Unranked'}</strong></span>
    </div>
    ${report.nextDisruption ? `<section class="disruption-brief"><small>Public outlook &middot; Year ${report.year + 1}</small><strong>${escapeHtml(report.nextDisruption.title)}</strong><p>${escapeHtml(report.nextDisruption.prepHint)}</p></section>` : ''}
    ${report.privateLookahead ? `<section class="disruption-brief disruption-brief--private"><small>Administration foresight &middot; confidential</small><strong>${escapeHtml(report.privateLookahead.title)}</strong><p>${escapeHtml(report.privateLookahead.prepHint)}</p></section>` : ''}
  </div>`;
}

function finalIssueMarkup(view) {
  const issue = finalIssue(view, content);
  const factors = issue.publicFactors;
  return `<div class="ceremony ceremony--final">
    <p class="special-issue">DUMP Rankings Special Issue</p>
    <p class="eyebrow">Definitive Ultimate Marketing Ploy</p>
    <h3>${escapeHtml(issue.winnerName)} wins</h3>
    <p>${escapeHtml(issue.explanation)}</p>
    ${factors ? `<div class="report-grid"><span><small>Students</small><strong>${formatNumber(factors.students)}</strong></span><span><small>Reputation</small><strong>${formatNumber(factors.reputation)}</strong></span><span><small>Department levels</small><strong>${factors.departmentLevels}</strong></span><span><small>Programs</small><strong>${factors.programs}</strong></span><span><small>Alumni</small><strong>${formatNumber(factors.alumni)}</strong></span><span><small>Treasury</small><strong>${escapeHtml(factors.treasuryBand)}</strong></span></div>` : ''}
    ${issue.turningPoints.length ? `<section><h4>Turning points</h4><ol class="history-list">${issue.turningPoints.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ol></section>` : ''}
  </div>`;
}

function showNextPresentation() {
  if (dialog.open || presentationQueue.length === 0 || !controller) return;
  const view = controller.getView();
  currentPresentation = presentationQueue.shift();
  if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
    presentationReturnFocus ??= document.activeElement;
  }
  dialog.dataset.mandatory = 'false';
  dialog.dataset.purpose = 'presentation';
  dialog.classList.add('ceremony-dialog');

  if (currentPresentation.kind === 'headline') {
    dialogTitle.textContent = currentPresentation.title;
    dialogContent.innerHTML = `<div class="ceremony ceremony--headline"><p class="eyebrow">Shared Headline &middot; applies to every active campus</p><div class="card-orientation"><span><small>Who it affects</small><strong>All four campuses</strong></span><span><small>What it does</small><strong>Changes shared rules this term</strong></span><span><small>Your action</small><strong>Review, then allocate</strong></span></div><blockquote>${escapeHtml(currentPresentation.flavor)}</blockquote><p>The policy environment has settled into the live Briefing. Review its actual tuition and upkeep effects before allocating.</p></div>`;
  } else if (currentPresentation.kind === 'playerCard' || currentPresentation.kind === 'rivalCard') {
    dialogTitle.textContent = currentPresentation.title;
    dialogContent.innerHTML = presentationCardMarkup(currentPresentation, view);
  } else if (currentPresentation.kind === 'rivalAusterity') {
    dialogTitle.textContent = `${schoolName(view, currentPresentation.playerId)} enters austerity`;
    dialogContent.innerHTML = `<div class="ceremony ceremony--crisis"><p class="eyebrow">Emergency bulletin</p><p>A rival board has begun selling assets. The exact treasury remains private; the public building change will appear on its campus record.</p></div>`;
  } else if (currentPresentation.kind === 'closure') {
    dialogTitle.textContent = currentPresentation.playerIds.length === 1 ? 'A campus closes' : 'Campuses close';
    dialogContent.innerHTML = `<div class="ceremony ceremony--crisis"><p class="eyebrow">Field update</p><p>${escapeHtml(currentPresentation.playerIds.map((id) => schoolName(view, id)).join(', '))} ${currentPresentation.playerIds.length === 1 ? 'has' : 'have'} left the competition.</p></div>`;
  } else if (currentPresentation.kind === 'annualReport') {
    dialogTitle.textContent = `Year ${view.year} Annual Report`;
    dialogContent.innerHTML = annualReportMarkup(view);
  } else {
    dialogTitle.textContent = 'The final issue';
    dialogContent.innerHTML = finalIssueMarkup(view);
  }

  const final = currentPresentation.kind === 'finalIssue';
  dialogActions.innerHTML = `${presentationQueue.length ? '<button class="text-button" type="button" data-skip-presentations>Send remaining to Board Book</button>' : ''}<button class="primary-button" type="button" data-continue-presentation>${final ? 'Return to final campus' : 'Continue'}</button>`;
  dialog.showModal();
  dialogActions.querySelector('[data-continue-presentation]').focus();
}

function enqueuePresentation(events, returnSelector = null) {
  if (!events.length || !controller) return;
  const view = controller.getView();
  const records = presentationRecords(events, { humanId: view.own.id, content });
  if (records.queue.length && returnSelector) presentationReturnSelector = returnSelector;
  presentationQueue.push(...records.queue);
  showNextPresentation();
}

function completePresentation(skipRemaining = false) {
  if (!currentPresentation) return;
  const view = controller.getView();
  if (currentPresentation.kind === 'playerCard' && !view.tutorial.cardDismissed) controller.dismissTutorial('card');
  if (currentPresentation.kind === 'annualReport' && !view.tutorial.reportDismissed) controller.dismissTutorial('report');
  if (skipRemaining) presentationQueue = [];
  currentPresentation = null;
  dialog.close();
}

function setTrayExpanded(expanded, instant = false) {
  if (instant) tray.classList.add('is-instant');
  trayButton.setAttribute('aria-expanded', String(expanded));
  tray.setAttribute('aria-hidden', String(!expanded));
  tray.inert = !expanded;
  if (instant) requestAnimationFrame(() => tray.classList.remove('is-instant'));
}

function renderRankings(view) {
  const rankings = dumpRankings(view);
  document.querySelector('#rankings-list').innerHTML = rankings.map((school) => `
    <li class="${school.id === view.own.id ? 'is-player' : ''} ${school.closed ? 'is-closed' : ''}">
      <span>${school.closed ? '×' : school.rank ?? '—'}</span> ${escapeHtml(school.id === view.own.id ? 'You' : shortSchoolName(school.name))}
    </li>`).join('');
  const ownRank = rankings.find((school) => school.id === view.own.id)?.rank;
  document.querySelector('#campus-rank-label').textContent = ownRank ? `Your campus · Rank ${ownRank}` : 'Your campus · Preseason';
  return rankings;
}

function renderRivalCampuses(view, rankings) {
  const rankById = new Map(rankings.map((school) => [school.id, school]));
  document.querySelector('#rival-spaces').innerHTML = view.opponents.map((rival, index) => {
    const rank = rankById.get(rival.id);
    return `<button class="rival-campus" type="button" data-rival="${escapeHtml(rival.id)}" aria-pressed="${rival.id === selectedRival}">
      <span class="rival-campus__rank">${rank?.closed ? '×' : rank?.rank ?? '—'}</span>
      <span class="rival-campus__mini ${index === 1 ? 'rival-campus__mini--old' : index === 2 ? 'rival-campus__mini--glass' : ''}" aria-hidden="true"><i></i><i></i><i></i></span>
      <span><strong>${escapeHtml(shortSchoolName(rival.name))}</strong><small>${escapeHtml(rival.treasuryBand)} · Rep ${formatNumber(rival.reputation)}</small></span>
    </button>`;
  }).join('');
}

function renderInspector(view) {
  const management = buildingManagement(view, selectedDepartment, content);
  const upgradeKey = management.upgrade ? registerAction(management.upgrade.action) : null;
  const sellKey = management.sell ? registerAction(management.sell.action) : null;
  const nextEffect = management.nextLevel ? departmentEffect(selectedDepartment, management.nextLevel) : 'This building has reached its final form.';
  inspector.innerHTML = `
    <p class="eyebrow">Selected building</p>
    <h2 id="activity-heading">${escapeHtml(departmentNames[selectedDepartment])} <span>Level ${management.level}</span></h2>
    <p class="atmosphere-note">${escapeHtml(departmentEffect(selectedDepartment, management.level))}</p>
    <div class="building-next">
      <small>${management.nextLevel ? `Level ${management.nextLevel}` : 'Maximum level'}</small>
      <strong>${management.nextLevel ? `${formatMoney(management.upgradeCost)} build · ${formatMoney(management.baseUpkeepChange, true)} base upkeep` : 'Fully developed'}</strong>
      <span>${escapeHtml(nextEffect)}</span>
    </div>
    <div class="inspector-actions">
      ${upgradeKey ? `<button class="primary-button" type="button" data-stage-action="${upgradeKey}">Add upgrade to plan</button>` : `<p class="unavailable-note">${escapeHtml(management.upgradeReason)}</p>`}
      ${sellKey ? `<button class="text-button" type="button" data-stage-action="${sellKey}">Plan voluntary sale</button>` : ''}
    </div>`;
}

function renderActivity(view) {
  const items = activityItems(view);
  document.querySelector('#activity-feed').innerHTML = (items.length ? items : ['The quad is ready for its first term.'])
    .map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderBriefing(view) {
  const capacity = view.own.departments.academics * content.config.departments.academics.studentCapacityPerLevel;
  const activeEffects = Object.entries(view.own.effects).filter(([, value]) => value !== 0 && value !== 1 && value !== null && value !== false);
  const warning = view.own.students > capacity
    ? `${formatNumber(view.own.students - capacity)} students above current Academics capacity.`
    : view.own.treasury < 10 ? 'Treasury margin is narrowing.' : 'No urgent operating warning.';
  let decision = '';
  if (view.pendingDecision?.type === 'adminCrisis' && view.legal?.kind === 'decision') {
    decision = `<section class="decision-panel"><p class="eyebrow">Decision required</p><h3>${view.pendingDecision.type === 'forcedSale' ? 'Emergency sale' : 'Administration review'}</h3>
      <div class="action-grid">${view.legal.commands.map((command) => {
        const key = registerAction(command);
        const label = command.department ? `Sell ${departmentNames[command.department]} · recover ${formatMoney(command.recovery)}` : titleCase(command.choice);
        return `<button type="button" data-answer-decision="${key}">${escapeHtml(label)}</button>`;
      }).join('')}</div></section>`;
  }
  let primary = '';
  if (view.mode === 'eliminationChoice') {
    primary = '<div class="button-row"><button class="primary-button" type="button" data-spectate>Watch next term</button><button class="secondary-button" type="button" data-skip-remaining>Skip to results</button></div>';
  } else if (view.mode === 'spectating') {
    primary = '<div class="button-row"><button class="primary-button" type="button" data-spectate>Watch next term</button><button class="secondary-button" type="button" data-skip-remaining>Skip remaining</button></div>';
  } else if (view.phase === 'ready' && !view.finished) {
    primary = `<button class="primary-button" type="button" data-start-round>Begin ${escapeHtml(termLabel(view, true))}</button>`;
  } else if (view.phase === 'allocation') {
    primary = '<button class="primary-button" type="button" data-open-allocation>Build the allocation plan</button>';
  }
  return `<div class="tray-layout">
    <div class="tray-copy"><p class="eyebrow">President's desk &middot; your planning step</p><h2>Briefing</h2><p>${view.phase === 'ready' ? 'Start the shared term when you are ready. The three rivals are waiting and cannot act until you begin.' : `Headline ${escapeHtml(view.headline ?? 'pending')} has settled. Choose your actions; the three rivals submit only when you confirm your allocation.`}</p>${primary}</div>
    <div class="tray-preview briefing-grid">
      <article><small>Position</small><strong>${formatMoney(view.own.treasury)}</strong><span>${view.own.paidUpkeepThisRound ? `${formatMoney(view.own.paidUpkeepThisRound)} upkeep paid` : 'Preseason treasury'}</span></article>
      <article><small>Capacity</small><strong>${formatNumber(capacity)}</strong><span>${formatNumber(view.own.students)} students enrolled</span></article>
      <article class="${warning.startsWith('No urgent') ? '' : 'is-warning'}"><small>Pressure</small><strong>${warning.startsWith('No urgent') ? 'Stable' : 'Watch'}</strong><span>${escapeHtml(warning)}</span></article>
      <article><small>Active effects</small><strong>${activeEffects.length}</strong><span>${activeEffects.length ? 'Carrying into play' : 'No temporary modifiers'}</span></article>
    </div>${decision}</div>`;
}

function renderEmergency(view) {
  const options = emergencySaleOptions(view, content);
  return `<div class="emergency-layout">
    <section class="emergency-heading"><p class="eyebrow">Required decision</p><h2>Emergency Board Meeting</h2><p>The campus is below the solvency threshold. Sell one eligible building level at a time until the engine clears the emergency.</p><div class="emergency-status"><span><small>Current treasury</small><strong>${formatMoney(view.own.treasury)}</strong></span><span><small>Reputation</small><strong>${formatNumber(view.own.reputation)}</strong></span></div></section>
    <section><h3>Choose the next fire sale</h3><div class="emergency-options">${options.map((option) => {
      const key = registerAction(option.command);
      return `<button type="button" data-answer-decision="${key}"><span><strong>${escapeHtml(departmentNames[option.department])}</strong><small>Level ${view.own.departments[option.department]} &rarr; ${view.own.departments[option.department] - 1}</small></span><span><b>${formatMoney(option.recovery)} recovered</b><small>${formatMoney(option.upkeepSaved)} upkeep saved &middot; &minus;${option.reputationLost} reputation</small></span></button>`;
    }).join('')}</div><p class="projection-note">Every figure is authoritative and comes from the currently legal engine decision. If another sale is required, this meeting stays open.</p></section>
  </div>`;
}

function renderAllocation(view) {
  if (view.phase !== 'allocation' || view.legal?.kind !== 'allocation') {
    return `<div class="tray-copy"><p class="eyebrow">Resource allocation</p><h2>Allocation</h2><p>${view.phase === 'ready' ? 'Begin the next term before making commitments.' : 'Allocation is unavailable while another decision is resolving.'}</p>${view.phase === 'ready' ? `<button class="primary-button" type="button" data-start-round>Begin ${escapeHtml(termLabel(view, true))}</button>` : ''}</div>`;
  }
  const summary = allocationSummary(view, content);
  if (activeSlot >= summary.maxActions) activeSlot = 0;
  const slots = summary.slots.map((slot) => `<article class="allocation-slot ${slot.index === activeSlot ? 'is-active' : ''}">
    <button type="button" data-allocation-slot="${slot.index}" aria-pressed="${slot.index === activeSlot}">
      <small>${slot.bonus ? 'Bonus slot' : `Action ${slot.index + 1}`}</small>
      <strong>${slot.action ? escapeHtml(actionLabel(slot.action, view)) : 'Bank'}</strong>
      <span>${slot.action ? escapeHtml(actionCost(slot.action, view)) : 'Unused by omission'}</span>
    </button>
    ${slot.action ? `<button class="slot-clear" type="button" data-clear-slot="${slot.index}" aria-label="Clear action ${slot.index + 1}">Clear</button>` : ''}
  </article>`).join('');
  const options = view.legal.actions.filter((option) => option.action.type !== 'bank').map((option) => {
    const key = registerAction(option.action);
    return `<button type="button" data-stage-action="${key}"><strong>${escapeHtml(actionLabel(option.action, view))}</strong><span>${escapeHtml(option.recovery ? `${formatMoney(option.recovery)} recovery` : option.cost ? formatMoney(option.cost) : 'No spend')}</span></button>`;
  }).join('');
  const guide = view.tutorial.allocationDismissed ? '' : `<aside class="inline-guide"><div><strong>Your first allocation</strong><p>Choose a slot, then add or replace one legal action. Empty slots become Bank only when you confirm.</p></div><button type="button" data-dismiss-tutorial="allocation">Dismiss</button></aside>`;
  return `${guide}<div class="allocation-layout">
    <section><div class="section-heading"><div><p class="eyebrow">Resource allocation</p><h2>Commit this term</h2></div><span>${summary.bonusSlots ? `${summary.bonusSlots} bonus slot` : `${summary.maxActions} standard slots`}</span></div><div class="allocation-slots">${slots}</div>
      <button class="primary-button" type="button" data-confirm-allocation>Confirm ${summary.bankSlots ? `with ${summary.bankSlots} Bank slot${summary.bankSlots === 1 ? '' : 's'}` : 'allocation'}</button>
      <div class="projection-strip">
        <span><small>Committed spend</small><strong>${formatMoney(summary.committedSpend)}</strong></span>
        <span><small>Sale recovery</small><strong>${formatMoney(summary.saleRecovery)}</strong></span>
        <span><small>After actions</small><strong>${formatMoney(summary.projectedTreasury)}</strong></span>
        <span><small>Base upkeep change</small><strong>${formatMoney(summary.baseUpkeepChange, true)}</strong></span>
      </div><p class="projection-note">Affordability uses the treasury you have now; sale recovery cannot fund same-term spend. Recruiting and cards are not projected.</p>
    </section>
    <section class="action-catalog"><h3>Legal actions</h3><div class="action-grid">${options || '<p>No discretionary action is affordable.</p>'}</div></section>
  </div>`;
}

function renderPrograms(view) {
  const programs = programManagement(view, content);
  const current = programs.current.length ? programs.current.map((program) => `<article><small>Open</small><strong>${escapeHtml(titleCase(program.program))}</strong><span>${formatMoney(program.upkeepPerRound)} base upkeep · ${formatNumber(program.pullPerRound)} pull</span></article>`).join('') : '<p class="empty-state">No Programs are open yet.</p>';
  const available = programs.available.map((option) => {
    const key = registerAction(option.action);
    const details = content.config.programs.catalog[option.action.program];
    return `<article class="program-option"><div><small>${formatMoney(option.cost)} to open</small><strong>${escapeHtml(titleCase(option.action.program))}</strong><span>${formatNumber(details.pullPerRound)} pull · ${formatMoney(details.upkeepPerRound)} upkeep</span></div><button type="button" data-stage-action="${key}">Add to plan</button></article>`;
  }).join('');
  return `<div class="program-layout">
    <section><div class="section-heading"><div><p class="eyebrow">Academic portfolio</p><h2>Programs</h2></div><span>${programs.openSlots} of ${programs.slotCount} slots open</span></div><div class="program-grid">${current}</div></section>
    <section><h3>Eligible openings</h3><p class="projection-note">Slots use committed Academics. A staged Academics upgrade does not create a Program slot until a later term.</p><div class="program-options">${available || '<p class="empty-state">No legal opening is available in the current state.</p>'}</div></section>
  </div>`;
}

function renderRivals(view) {
  if (!selectedRival || !view.opponents.some((rival) => rival.id === selectedRival)) selectedRival = view.opponents[0].id;
  const profile = rivalProfile(view, selectedRival);
  const identities = view.lineup.map((rival) => `<button type="button" data-rival-profile="${escapeHtml(rival.id)}" aria-pressed="${rival.id === selectedRival}">${escapeHtml(rival.name)}</button>`).join('');
  const departments = Object.entries(profile.departments).map(([department, level]) => `<span><small>${escapeHtml(departmentNames[department])}</small><strong>Level ${level}</strong></span>`).join('');
  const events = profile.recentEvents.map((event) => eventDescription(event, view)).filter(Boolean).slice(-5).reverse();
  return `<div class="rival-layout">
    <section><p class="eyebrow">Competitive field</p><h2>Rivals</h2><div class="rival-tabs">${identities}</div>
      <div class="rival-profile-heading"><div><small>${escapeHtml(archetypeNames[profile.archetype])}</small><h3>${escapeHtml(profile.name)}</h3></div><span>${profile.active ? 'Active' : 'Closed'}</span></div>
      <div class="rival-metrics"><span><small>Students</small><strong>${formatNumber(profile.students)}</strong></span><span><small>Reputation</small><strong>${formatNumber(profile.reputation)}</strong></span><span><small>Treasury</small><strong>${Object.hasOwn(profile, 'treasury') ? formatMoney(profile.treasury) : escapeHtml(profile.treasuryBand)}</strong></span><span><small>Programs</small><strong>${profile.programs.length}</strong></span></div>
      <div class="department-grid">${departments}</div>
    </section>
    <section><h3>Recent public activity</h3><ol class="history-list">${(events.length ? events : ['No public action recorded yet.']).map((event) => `<li>${escapeHtml(event)}</li>`).join('')}</ol><p class="privacy-note">Exact treasury and private disruption foresight remain confidential unless a public effect reveals them.</p></section>
  </div>`;
}

function renderBoardBook(view) {
  const book = boardBook(view, content);
  const cards = book.cards.map((card, index) => ({ card, index })).slice(-8).reverse().map(({ card, index }) => {
    const own = card.playerId === view.own.id;
    const meaning = card.cardKind === 'fortune' ? 'Advantage' : 'Setback';
    return `<li><button type="button" data-history-card="${index}"><span><small><b class="record-owner ${own ? 'is-own' : ''}">${own ? 'YOU' : 'RIVAL'}</b> ${escapeHtml(own ? view.own.name : schoolName(view, card.playerId))}</small><strong>${escapeHtml(card.title)}</strong><em>${escapeHtml(titleCase(card.cardKind))} &middot; ${meaning} &middot; applies to this campus</em></span><b>${card.target ? escapeHtml(departmentNames[card.target]) : 'Campus-wide'}</b></button></li>`;
  }).join('');
  const reports = book.reports.slice().reverse().map((report) => `<li><span><small>Year ${report.year}</small><strong>${formatNumber(report.recruiting)} recruited &middot; ${formatNumber(report.graduates)} graduates</strong></span><b>${formatMoney(report.endingTreasury)}</b></li>`).join('');
  const trends = book.trends.slice().reverse().map((trend, index, reversed) => {
    const prior = reversed[index + 1];
    const movement = trend.ownRank && prior?.ownRank ? prior.ownRank - trend.ownRank : 0;
    return `<li><span><small>Round ${trend.round} public standing</small><strong>DUMP ${trend.ownRank ? `#${trend.ownRank}` : 'unranked'} &middot; ${formatNumber(trend.students ?? 0)} students</strong></span><b>${movement > 0 ? `&uarr;${movement}` : movement < 0 ? `&darr;${Math.abs(movement)}` : '&mdash;'}</b></li>`;
  }).join('');
  return `<div class="board-book-layout">
    <section><p class="eyebrow">Permanent reference</p><h2>Board Book</h2><div class="help-card"><strong>How a term works</strong><p>Begin the shared term, review income and warnings, then commit up to two different action types. Rivals submit simultaneously only after you confirm. Cards and recruiting then resolve automatically.</p></div><div class="help-card"><strong>How cards work</strong><p>Fortune means an advantage; Crisis means a setback. Each card applies to the campus named on it. The targeted department sets the factor, and Administration may reduce Crisis severity.</p></div><div class="help-card"><strong>What DUMP means</strong><p>Definitive Ultimate Marketing Ploy rankings use published students, reputation, departments, Programs, and alumni. Treasury is excluded and DUMP never changes the rules.</p></div><button class="danger-link" type="button" data-request-new-game>Start a different game</button></section>
    <section class="book-records"><div><h3>Cards</h3><p class="record-hint">Select a card for who it applied to and what it meant. Your cards include exact math; rival cards show public facts.</p><ol class="record-list record-list--interactive">${cards || '<li>No cards recorded yet.</li>'}</ol></div><div><h3>Annual reports</h3><ol class="record-list">${reports || '<li>The first report arrives after Term 5.</li>'}</ol></div><div><h3>DUMP trend</h3><ol class="record-list">${trends || '<li>No published ranking yet.</li>'}</ol></div></section>
  </div>`;
}

function openCardReference(index, trigger) {
  const view = controller.getView();
  const record = boardBook(view, content).cards[index];
  if (!record) throw new Error('That card is no longer in the Board Book.');
  presentationReturnFocus = trigger;
  dialog.dataset.mandatory = 'false';
  dialog.dataset.purpose = 'reference';
  dialog.classList.add('ceremony-dialog');
  dialogTitle.textContent = record.title;
  dialogContent.innerHTML = presentationCardMarkup(record, view);
  dialogActions.innerHTML = '<button class="primary-button" type="button" data-close-reference>Back to Board Book</button>';
  dialog.showModal();
  dialogActions.querySelector('button').focus();
}

function renderTray(view) {
  const emergency = view.pendingDecision?.type === 'forcedSale';
  document.querySelectorAll('[data-management-section]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.managementSection === activeSection));
    button.disabled = emergency;
  });
  if (emergency) trayContent.innerHTML = renderEmergency(view);
  else if (activeSection === 'allocate') trayContent.innerHTML = renderAllocation(view);
  else if (activeSection === 'programs') trayContent.innerHTML = renderPrograms(view);
  else if (activeSection === 'rivals') trayContent.innerHTML = renderRivals(view);
  else if (activeSection === 'boardBook') trayContent.innerHTML = renderBoardBook(view);
  else trayContent.innerHTML = renderBriefing(view);
  if (uiMessage) trayContent.insertAdjacentHTML('afterbegin', `<p class="ui-message" role="status">${escapeHtml(uiMessage)}</p>`);
}

function renderGame({ animateBuildings = false } = {}) {
  if (!controller) return;
  const view = controller.getView();
  actionRegistry = new Map();
  const fixture = campusFixture(view);
  const emergency = view.pendingDecision?.type === 'forcedSale';
  document.body.dataset.gameState = emergency ? 'emergency' : view.finished ? 'complete' : view.mode;
  document.body.dataset.fixture = fixture;
  document.body.dataset.population = view.own.students < 5000 ? 'low' : view.own.students > 11000 ? 'high' : 'medium';
  document.body.dataset.color = view.identity.color;
  document.querySelector('#campus-condition').textContent = campusCondition(fixture);
  document.querySelector('#campus-heading').textContent = view.own.name;
  document.querySelector('#campus-edge-name').textContent = `${view.own.name.toUpperCase()} UNIVERSITY`;
  document.querySelector('#campus-edge-term').textContent = termLabel(view);
  document.querySelector('#campus-seal').textContent = mascots.find((mascot) => mascot.id === view.identity.mascot)?.mark ?? 'SS';
  document.querySelector('#treasury-value').textContent = formatMoney(view.own.treasury);
  document.querySelector('#students-value').textContent = formatNumber(view.own.students);
  document.querySelector('#reputation-value').textContent = formatNumber(view.own.reputation);
  document.querySelector('#alumni-value').textContent = formatNumber(view.own.alumni);

  const rankings = renderRankings(view);
  renderRivalCampuses(view, rankings);
  document.querySelectorAll('.building').forEach((building) => {
    const department = building.dataset.department;
    const level = view.own.departments[department];
    const prior = Number(building.dataset.level);
    building.dataset.level = String(level);
    building.setAttribute('aria-label', `${departmentNames[department]}, Level ${level}`);
    building.setAttribute('aria-pressed', String(department === selectedDepartment));
    building.disabled = emergency || view.finished;
    building.querySelector('.building__caption b').textContent = String(level);
    if (animateBuildings && level > prior && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      building.classList.remove('is-building');
      void building.offsetWidth;
      building.classList.add('is-building');
      setTimeout(() => building.classList.remove('is-building'), 900);
    }
  });

  const guidance = turnGuidance(view, content.config.gameLength.roundsPerYear);
  status.dataset.tone = guidance.tone;
  status.innerHTML = saveWarning
    ? `<small>Save warning</small><strong>${escapeHtml(saveWarning)}</strong>`
    : `<small>${escapeHtml(guidance.eyebrow)}</small><strong>${escapeHtml(guidance.title)}</strong><span>${escapeHtml(guidance.detail)}</span>`;
  renderInspector(view);
  renderActivity(view);
  if (emergency || ['eliminationChoice', 'spectating'].includes(view.mode)) {
    activeSection = 'briefing';
    setTrayExpanded(true, true);
  }
  renderTray(view);
}

function stageRegisteredAction(key) {
  const action = actionRegistry.get(key);
  if (!action) throw new Error('That action is no longer available.');
  const view = controller.getView();
  if (view.phase !== 'allocation') throw new Error('Begin the term before adding an action.');
  controller.stageAction(activeSlot, action);
  const next = controller.getView();
  activeSlot = Array.from({ length: next.legal.maxActions }, (_, index) => index)
    .find((index) => !next.stagedActions[index]) ?? activeSlot;
}

function handleClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    uiMessage = '';
    if (button.matches('[data-retry-startup]') || button.id === 'retry-startup') start();
    else if (button.matches('[data-resume-game]')) {
      const loaded = loadSession(storage, content);
      if (loaded.status === 'ok') resumeGame(loaded.envelope);
      else if (loaded.status === 'invalid') showInvalidSave(loaded);
      else openSetup('No resumable game was found.');
    } else if (button.matches('[data-request-new-game]')) openNewGameConfirmation();
    else if (button.matches('[data-continue-presentation]')) completePresentation();
    else if (button.matches('[data-skip-presentations]')) completePresentation(true);
    else if (button.matches('[data-close-dialog]')) dialog.close();
    else if (button.matches('[data-confirm-new-game]')) {
      discardSession(storage);
      revision = 0;
      controller = null;
      presentationQueue = [];
      currentPresentation = null;
      presentationReturnSelector = null;
      dialog.close();
      openSetup();
    } else if (button.matches('[data-discard-invalid-save]')) {
      discardSession(storage);
      revision = 0;
      openSetup();
    } else if (button.matches('[data-reload-game]')) location.reload();
    else if (button.matches('[data-dismiss-setup-guide]')) {
      syncSetupForm();
      setupDraft.guideDismissed = true;
      renderSetup();
    } else if (button.matches('[data-setup-department]')) {
      syncSetupForm();
      const department = button.dataset.setupDepartment;
      const delta = Number(button.dataset.setupDelta);
      const total = Object.values(setupDraft.upgrades).reduce((sum, level) => sum + level, 0);
      const next = setupDraft.upgrades[department] + delta;
      if (next >= 0 && next <= 2 && (delta < 0 || total < 3)) setupDraft.upgrades[department] = next;
      renderSetup();
      document.querySelector(`[data-setup-department="${department}"][data-setup-delta="${delta}"]`)?.focus();
    } else if (button === trayButton) {
      const expanded = trayButton.getAttribute('aria-expanded') === 'true';
      setTrayExpanded(!expanded, event.detail === 0);
    } else if (button.matches('[data-management-section]')) {
      activeSection = button.dataset.managementSection;
      setTrayExpanded(true, true);
      renderGame();
    } else if (button.matches('[data-history-card]')) {
      openCardReference(Number(button.dataset.historyCard), button);
    } else if (button.matches('[data-close-reference]')) {
      dialog.close();
    } else if (button.matches('[data-rival]')) {
      selectedRival = button.dataset.rival;
      activeSection = 'rivals';
      setTrayExpanded(true, event.detail === 0);
      renderGame();
    } else if (button.matches('[data-rival-profile]')) {
      selectedRival = button.dataset.rivalProfile;
      renderGame();
    } else if (button.matches('.building')) {
      selectedDepartment = button.dataset.department;
      renderGame();
    } else if (button.matches('[data-open-allocation]')) {
      activeSection = 'allocate';
      renderGame();
    } else if (button.matches('[data-start-round]')) {
      const result = controller.startRound();
      activeSection = 'briefing';
      activeSlot = 0;
      renderGame();
      announceTransition(result.events);
      enqueuePresentation(result.presentationEvents, '[data-management-section="allocate"]');
    } else if (button.matches('[data-allocation-slot]')) {
      activeSlot = Number(button.dataset.allocationSlot);
      renderGame();
    } else if (button.matches('[data-stage-action]')) {
      stageRegisteredAction(button.dataset.stageAction);
      renderGame();
    } else if (button.matches('[data-clear-slot]')) {
      controller.clearAction(Number(button.dataset.clearSlot));
      activeSlot = Number(button.dataset.clearSlot);
      renderGame();
    } else if (button.matches('[data-confirm-allocation]')) {
      const result = controller.confirmAllocation();
      activeSection = 'briefing';
      activeSlot = 0;
      renderGame({ animateBuildings: event.detail !== 0 });
      announceTransition(result.events);
      enqueuePresentation(result.presentationEvents, controller.getView().pendingDecision ? '[data-answer-decision]' : '[data-start-round]');
    } else if (button.matches('[data-answer-decision]')) {
      const result = controller.answerDecision(actionRegistry.get(button.dataset.answerDecision));
      renderGame();
      announceTransition(result.events);
      enqueuePresentation(result.presentationEvents, controller.getView().pendingDecision ? '[data-answer-decision]' : '[data-start-round]');
      if (event.detail === 0 && controller.getView().pendingDecision?.type === 'forcedSale' && !dialog.open) {
        document.querySelector('[data-answer-decision]')?.focus();
      }
    } else if (button.matches('[data-dismiss-tutorial]')) {
      controller.dismissTutorial(button.dataset.dismissTutorial);
      renderGame();
    } else if (button.matches('[data-spectate]')) {
      const result = controller.spectateNext();
      renderGame();
      announceTransition(result.events);
      enqueuePresentation(result.presentationEvents, '[data-spectate], [data-skip-remaining]');
    } else if (button.matches('[data-skip-remaining]')) {
      controller.skipRemaining();
      renderGame();
      announcer.textContent = `${schoolName(controller.getView(), controller.getView().winnerId)} won the game. Final issue ready.`;
      presentationReturnSelector = '.tray-handle';
      presentationQueue.push({ kind: 'finalIssue' });
      showNextPresentation();
    }
  } catch (error) {
    uiMessage = error.message;
    if (controller) renderGame();
  }
}

function handleSubmit(event) {
  if (event.target.id !== 'new-game-form') return;
  event.preventDefault();
  syncSetupForm();
  const total = Object.values(setupDraft.upgrades).reduce((sum, level) => sum + level, 0);
  if (total !== 3) {
    renderSetup('Place exactly three free levels before opening the campus.');
    return;
  }
  const name = setupDraft.name.trim();
  if (!name) {
    renderSetup('Give the school a name.');
    return;
  }
  try {
    const session = createSoloSession({
      seed: setupDraft.seed,
      human: {
        id: 'human',
        name,
        mascot: setupDraft.mascot,
        color: setupDraft.color,
        upgrades: structuredClone(setupDraft.upgrades),
      },
      rivalIds: setupDraft.rivals.map((rival) => rival.id),
    }, content);
    session.tutorial.setupDismissed = true;
    const saved = saveSession(storage, session, content, { expectedRevision: 0 });
    if (saved.ok) revision = saved.envelope.revision;
    else if (saved.reason === 'staleRevision' || saved.reason === 'invalidExisting') {
      renderSetup('A saved game still occupies this browser. Return and confirm before replacing it.');
      return;
    } else {
      revision = 0;
      saveWarning = 'Autosave unavailable—playing in memory only.';
    }
    attachController(session);
    hideStartup();
    setupDraft = null;
    activeSection = 'briefing';
    selectedDepartment = 'academics';
    setTrayExpanded(true);
    renderGame();
  } catch (error) {
    renderSetup(error.message);
  }
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function start() {
  showStartup('<span class="startup__seal" aria-hidden="true">SS</span><h1>Opening the gates</h1><p>Validating the official campus records…</p>');
  status.textContent = 'Loading campus…';
  try {
    const [config, cards] = await Promise.all([fetchJson('/balance-config.json'), fetchJson('/cards.json')]);
    content = validateContent(config, cards);
    status.textContent = `Engine ${ENGINE_VERSION} · ${RIVAL_SCHOOLS.length} rival schools ready`;
    const loaded = loadSession(storage, content);
    if (loaded.status === 'ok') showResume(loaded.envelope);
    else if (loaded.status === 'invalid') showInvalidSave(loaded);
    else if (loaded.status === 'unavailable') openSetup('Local autosave is unavailable; this game will continue in memory.');
    else openSetup();
  } catch (error) {
    showStartup(`<span class="startup__seal" aria-hidden="true">!</span><h1>The campus could not open</h1><p>Check the local server and try again. ${escapeHtml(error.message)}</p><button class="primary-button" type="button" data-retry-startup>Retry</button>`);
    status.textContent = 'Startup error';
  }
}

document.addEventListener('click', handleClick);
document.addEventListener('submit', handleSubmit);
document.addEventListener('keydown', () => {
  if (document.body.dataset.input !== 'keyboard') document.body.dataset.input = 'keyboard';
}, true);
document.addEventListener('pointerdown', () => {
  if (document.body.dataset.input !== 'pointer') document.body.dataset.input = 'pointer';
}, true);
dialog.addEventListener('cancel', (event) => {
  if (dialog.dataset.mandatory === 'true') event.preventDefault();
  else if (dialog.dataset.purpose === 'presentation') {
    event.preventDefault();
    completePresentation();
  }
});
dialog.addEventListener('close', () => {
  dialog.classList.remove('ceremony-dialog');
  if (dialog.dataset.purpose === 'reference') {
    presentationReturnFocus?.focus();
    presentationReturnFocus = null;
    dialog.dataset.purpose = '';
    return;
  }
  if (dialog.dataset.purpose !== 'presentation') return;
  if (presentationQueue.length) showNextPresentation();
  else {
    const selectorTarget = presentationReturnSelector ? document.querySelector(presentationReturnSelector) : null;
    const focusTarget = presentationReturnFocus?.isConnected ? presentationReturnFocus : selectorTarget ?? trayButton;
    focusTarget?.focus();
    presentationReturnFocus = null;
    presentationReturnSelector = null;
    dialog.dataset.purpose = '';
  }
});
window.addEventListener('storage', (event) => {
  if (controller && content && isStaleStorageEvent(event, revision, content)) pauseForStaleSave();
});

start();

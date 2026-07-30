import { operatingBudget, programManagement, rivalProfile } from './game.js';
import { boardBook } from './presentation.js';

const departments = {
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

function titleCase(value) {
  return String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase());
}

function money(value, signed = false) {
  const sign = value < 0 ? '&minus;' : signed && value > 0 ? '+' : '';
  return `${sign}$${Math.abs(value).toFixed(1)}m`;
}

function number(value) {
  return Math.round(value).toLocaleString();
}

function briefing(view, content) {
  const budget = operatingBudget({ ...view, stagedActions: [] }, content);
  const capacity = view.own.departments.academics * content.config.departments.academics.studentCapacityPerLevel;
  const expenses = [
    ...budget.departmentExpenses.map((item) => ({ label: departments[item.department], value: item.value })),
    ...budget.programExpenses.map((item) => ({ label: titleCase(item.program), value: item.value })),
  ];
  const effects = Object.values(view.own.effects).filter((value) => value !== 0 && value !== 1 && value !== null && value !== false).length;
  const pressure = Math.max(0, view.own.students - capacity);
  return `<div class="tray-layout">
    <section class="tray-copy"><p class="eyebrow">President&rsquo;s desk</p><h2>Briefing</h2><p>This forecast separates recurring tuition and upkeep from support that arrives only at year end.</p>
      <div class="tray-preview briefing-grid">
        <article><small>Treasury</small><strong>${money(view.own.treasury)}</strong><span>Current position</span></article>
        <article><small>Capacity</small><strong>${number(capacity)}</strong><span>${number(view.own.students)} enrolled</span></article>
        <article class="${pressure ? 'is-warning' : ''}"><small>Pressure</small><strong>${pressure ? 'Watch' : 'Stable'}</strong><span>${pressure ? `${number(pressure)} above capacity` : 'Within Academics capacity'}</span></article>
        <article><small>Active effects</small><strong>${effects}</strong><span>${effects ? 'Carrying into play' : 'No temporary modifiers'}</span></article>
      </div>
    </section>
    <section class="budget-panel"><header><div><p class="eyebrow">Budget &amp; cash flow</p><h3>Next-term operating forecast &middot; Year ${budget.forecastYear}</h3></div><span class="budget-margin ${budget.termBalance < 0 ? 'is-negative' : 'is-positive'}"><small>Projected per-term margin</small><strong>${money(budget.termBalance, true)}</strong></span></header>
      <div class="budget-ledger">
        <section><h4>Recurring income</h4><ul><li><span>Tuition</span><strong>${money(budget.termIncome)}</strong></li></ul><h4>Year-end-only income</h4><ul><li><span>Estimated alumni donations</span><strong>${money(budget.annualDonations)}</strong></li><li><span>Estimated state grants</span><strong>${money(budget.annualGrants)}</strong></li></ul></section>
        <section><h4>Recurring spending</h4><ul>${expenses.map((item) => `<li><span>${escapeHtml(item.label)}</span><strong>${money(item.value)}</strong></li>`).join('')}</ul></section>
        <section class="budget-reconciliation"><h4>Annualized reconciliation</h4><ul><li><span>Recurring margin</span><strong class="${budget.annualOperatingMargin < 0 ? 'is-negative' : 'is-positive'}">${money(budget.annualOperatingMargin, true)}</strong></li><li><span>Donations &amp; grants</span><strong class="is-positive">${money(budget.annualSupport, true)}</strong></li><li><span>Projected annual result</span><strong class="${budget.annualResult < 0 ? 'is-negative' : 'is-positive'}">${money(budget.annualResult, true)}</strong></li></ul></section>
      </div>
    </section>
  </div>`;
}

function programs(view, content) {
  const portfolio = programManagement(view, content);
  const current = portfolio.current.map((program) => `<article><small>Open</small><strong>${escapeHtml(titleCase(program.program))}</strong><span>${money(program.upkeepPerRound)} upkeep &middot; ${number(program.pullPerRound)} pull</span></article>`).join('');
  const available = portfolio.available.map((option) => `<article class="program-option"><div><small>${money(option.cost)} to open</small><strong>${escapeHtml(titleCase(option.action.program))}</strong><span>Uses one committed Academics slot.</span></div><button type="button" data-online-section="actions">Choose in Actions</button></article>`).join('');
  return `<div class="program-layout">
    <section><div class="section-heading"><div><p class="eyebrow">Academic portfolio</p><h2>Programs</h2></div><span>${portfolio.openSlots} of ${portfolio.slotCount} slots open</span></div><div class="program-grid">${current || '<p class="empty-state">No Programs are open yet.</p>'}</div></section>
    <section><h3>Eligible openings</h3><p class="projection-note">A Program must be selected as one of this term&rsquo;s Actions.</p><div class="program-options">${available || '<p class="empty-state">No legal opening is available right now.</p>'}</div></section>
  </div>`;
}

function rivals(view, selectedRivalId) {
  const selected = view.opponents.some(({ id }) => id === selectedRivalId) ? selectedRivalId : view.opponents[0]?.id;
  if (!selected) return '<div class="tray-copy"><h2>Rivals</h2><p>No rival campuses remain.</p></div>';
  const profile = rivalProfile(view, selected);
  const tabs = view.opponents.map((rival) => `<button type="button" data-online-rival="${escapeHtml(rival.id)}" aria-pressed="${rival.id === selected}">${escapeHtml(rival.name)}</button>`).join('');
  const levels = Object.entries(profile.departments).map(([department, level]) => `<span><small>${escapeHtml(departments[department])}</small><strong>Level ${level}</strong></span>`).join('');
  const events = profile.recentEvents.slice(-5).reverse().map((event) => `<li>${escapeHtml(titleCase(event.type))}</li>`).join('');
  const identity = view.lineup.find(({ id }) => id === selected);
  const president = identity ? (identity.archetype === 'human' ? 'Human president' : 'AI president') : 'President';
  return `<div class="rival-layout">
    <section><p class="eyebrow">Competitive field</p><h2>Rivals</h2><div class="rival-tabs">${tabs}</div>
      <div class="rival-profile-heading"><div><small>${president}</small><h3>${escapeHtml(profile.name)}</h3></div><span>${profile.active ? 'Active' : 'Closed'}</span></div>
      <div class="rival-metrics"><span><small>Students</small><strong>${number(profile.students)}</strong></span><span><small>Reputation</small><strong>${number(profile.reputation)}</strong></span><span><small>Treasury</small><strong>${Object.hasOwn(profile, 'treasury') ? money(profile.treasury) : escapeHtml(profile.treasuryBand)}</strong></span><span><small>Programs</small><strong>${profile.programs.length}</strong></span></div>
      <div class="department-grid">${levels}</div>
    </section>
    <section><h3>Recent public activity</h3><ol class="history-list">${events || '<li>No public action recorded yet.</li>'}</ol><p class="privacy-note">Exact treasury and private disruption foresight remain confidential unless a public effect reveals them.</p></section>
  </div>`;
}

function book(view, content) {
  const record = boardBook(view, content);
  const cards = record.cards.slice(-8).reverse().map((card) => `<li><span><small>${card.playerId === view.own.id ? 'YOU' : 'RIVAL'}</small><strong>${escapeHtml(card.title)}</strong></span><b>${escapeHtml(titleCase(card.cardKind))}</b></li>`).join('');
  const reports = record.reports.slice().reverse().map((report) => `<li><span><small>Year ${report.year}</small><strong>${number(report.recruiting)} recruited &middot; ${number(report.graduates)} graduates</strong></span><b>${money(report.endingTreasury)}</b></li>`).join('');
  const trends = record.trends.slice().reverse().map((trend) => `<li><span><small>Round ${trend.round}</small><strong>DUMP ${trend.ownRank ? `#${trend.ownRank}` : 'unranked'} &middot; ${number(trend.students ?? 0)} students</strong></span></li>`).join('');
  return `<div class="board-book-layout">
    <section><p class="eyebrow">Permanent reference</p><h2>Board Book</h2><div class="help-card"><strong>How a term works</strong><p>Begin the shared term, then every active president submits up to two different action types. The term resolves when all human allocations are in.</p></div><div class="help-card"><strong>What DUMP means</strong><p>Definitive Ultimate Marketing Ploy rankings use published campus factors. Treasury stays out of the formula.</p></div></section>
    <section class="book-records"><div><h3>Cards</h3><ol class="record-list">${cards || '<li>No cards recorded yet.</li>'}</ol></div><div><h3>Annual reports</h3><ol class="record-list">${reports || '<li>The first report arrives after Term 5.</li>'}</ol></div><div><h3>DUMP trend</h3><ol class="record-list">${trends || '<li>No published ranking yet.</li>'}</ol></div></section>
  </div>`;
}

export function renderOnlineManagement(section, view, content, selectedRivalId) {
  view = { ...view, history: view.history ?? [], lineup: view.lineup ?? [], standings: view.standings ?? [] };
  if (section === 'briefing') return briefing(view, content);
  if (section === 'programs') return programs(view, content);
  if (section === 'rivals') return rivals(view, selectedRivalId);
  if (section === 'boardBook') return book(view, content);
  throw new TypeError(`section: unknown ${section}`);
}

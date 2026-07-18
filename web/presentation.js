import { dumpScore } from './game.js';

const effectNames = Object.freeze({
  bonusConversionsNextRound: 'Students next term',
  bonusConversionsThisRound: 'Students now',
  campaignBlockedNextRound: 'Campaign access next term',
  campaignPullMultiplierNext: 'Next campaign pull',
  campaignYieldFloorBonusNext: 'Next campaign yield floor',
  campaignYieldLockNext: 'Next campaign yield',
  donationMultiplierThisYearEnd: 'Year-end donations',
  extraActionsNextRound: 'Actions next term',
  money: 'Treasury',
  nextCrisisSeverityReduction: 'Next Crisis severity',
  programRider: 'Program rider',
  recruitingPenaltyNextRound: 'Recruiting next term',
  reputation: 'Reputation',
  retentionDeltaThisYear: 'Retention this year',
  temporaryCapacityThisYear: 'Capacity this year',
  treasuryRevealedRounds: 'Treasury visibility',
  upkeepRefundFraction: 'Upkeep refund',
});

function cardById(content, kind, cardId) {
  const source = kind === 'fortune' ? content.cards.fortuneCards : content.cards.crisisCards;
  const card = source.find((candidate) => candidate.id === cardId);
  if (!card) throw new TypeError(`cardId: unknown ${cardId}`);
  return card;
}

function disruptionById(content, cardId) {
  if (!cardId) return null;
  const card = content.cards.annualDisruptions.find((candidate) => candidate.id === cardId);
  if (!card) throw new TypeError(`disruption cardId: unknown ${cardId}`);
  return { cardId, title: card.name, flavor: card.flavor, prepHint: card.prepHint };
}

function headlineById(content, cardId) {
  const card = content.cards.headlines.find((candidate) => candidate.id === cardId);
  if (!card) throw new TypeError(`headline cardId: unknown ${cardId}`);
  return card;
}

function numericEffectValue(effect) {
  return typeof effect.value === 'number' ? effect.value : null;
}

function explainEffect(effect, factor, skippedTypes) {
  const skipped = skippedTypes.includes(effect.type);
  const base = numericEffectValue(effect);
  const multiplier = effect.scalable ? factor : 1;
  return {
    type: effect.type,
    label: effectNames[effect.type] ?? effect.type,
    base,
    multiplier,
    result: base === null || skipped ? null : base * multiplier,
    scalable: effect.scalable === true,
    skipped,
    ...(effect.program ? { program: effect.program } : {}),
  };
}

function explainCard(event, content, kind) {
  const card = cardById(content, event.kind, event.cardId);
  const targetFactor = event.kind === 'fortune'
    ? (event.targetLevel + 1) / 3
    : (6 - event.targetLevel) / 5;
  const severityFactor = event.kind === 'crisis' ? event.effectiveSeverity / card.severity : 1;
  const factor = event.factor ?? targetFactor * severityFactor;
  return {
    kind,
    cardId: card.id,
    cardKind: event.kind,
    title: card.name,
    flavor: card.flavor,
    severity: card.severity,
    effectiveSeverity: event.effectiveSeverity,
    target: event.target,
    targetLevel: event.targetLevel,
    targetFactor,
    severityFactor,
    factor,
    effects: card.effects.map((effect) => explainEffect(effect, factor, event.skippedEffects ?? [])),
    playerId: event.playerId,
  };
}

function feedCard(event, content) {
  const card = cardById(content, event.kind, event.cardId);
  return {
    kind: 'rivalCard',
    playerId: event.playerId,
    cardId: event.cardId,
    cardKind: event.kind,
    title: card.name,
    severity: card.severity,
    target: event.target,
  };
}

export function presentationRecords(events, { humanId, content }) {
  const queue = [];
  const feed = [];
  const stagedAusterity = new Set();

  for (const event of events) {
    if (event.type === 'headlineRevealed') {
      const card = headlineById(content, event.cardId);
      queue.push({
        kind: 'headline',
        cardId: card.id,
        title: card.name,
        flavor: card.flavor,
        effects: structuredClone(card.effects),
      });
    } else if (event.type === 'cardResolved' && event.playerId === humanId) {
      queue.push(explainCard(event, content, 'playerCard'));
    } else if (event.type === 'cardResolved') {
      const record = feedCard(event, content);
      feed.push(record);
      if (record.severity === 3) queue.push(structuredClone(record));
    } else if (event.type === 'forcedSale' && event.playerId !== humanId) {
      if (!stagedAusterity.has(event.playerId)) {
        stagedAusterity.add(event.playerId);
        queue.push({ kind: 'rivalAusterity', playerId: event.playerId, department: event.department });
      }
    } else if (event.type === 'playersEliminated') {
      queue.push({ kind: 'closure', playerIds: [...event.playerIds], stage: event.stage });
    } else if (event.type === 'graduationResolved' && event.playerId === humanId) {
      if (!queue.some((record) => record.kind === 'annualReport')) queue.push({ kind: 'annualReport' });
    } else if (event.type === 'gameFinished') {
      queue.push({ kind: 'finalIssue', winnerId: event.winnerId, reason: event.reason });
    }
  }
  return { queue, feed };
}

function yearEntries(view, content, year) {
  const roundsPerYear = content.config.gameLength.roundsPerYear;
  const firstRound = (year - 1) * roundsPerYear + 1;
  const lastRound = year * roundsPerYear;
  return view.history.filter((entry) => entry.round >= firstRound && entry.round <= lastRound);
}

function firstEvent(events, type, humanId) {
  return events.find((event) => event.type === type && (!event.playerId || event.playerId === humanId));
}

export function annualReport(view, content, year = view.year) {
  const entries = yearEntries(view, content, year);
  const events = entries.flatMap((entry) => entry.events);
  const humanId = view.own.id;
  const income = events.filter((event) => event.type === 'incomeResolved')
    .map((event) => event.players?.[humanId]).filter(Boolean);
  const recruiting = events.filter((event) => event.type === 'recruitingResolved')
    .map((event) => event.players?.[humanId]).filter(Boolean);
  const graduation = firstEvent(events, 'graduationResolved', humanId);
  const donations = firstEvent(events, 'donationsResolved', humanId);
  const publicReveal = events.find((event) => event.type === 'disruptionRevealed' && event.visibility === 'public');
  const privateReveal = events.find((event) => event.type === 'disruptionRevealed' && event.visibility === 'private');
  const standings = view.history.flatMap((entry) => entry.events)
    .filter((event) => event.type === 'standingsPublished' && event.round <= year * content.config.gameLength.roundsPerYear)
    .map((event) => ownTrend(event, humanId));
  const currentStanding = standings.at(-1);
  const priorStanding = standings.at(-2);
  const ending = [...entries].reverse().find((entry) => entry.own)?.own ?? view.own;
  return {
    kind: 'annualReport',
    year,
    tuition: income.reduce((total, record) => total + (record.tuition ?? 0), 0),
    upkeep: income.reduce((total, record) => total + (record.upkeep ?? 0), 0),
    recruiting: recruiting.reduce((total, record) => total + (record.totalConversions ?? record.converted ?? 0), 0),
    graduates: graduation?.graduates ?? 0,
    attrition: graduation ? graduation.studentsBefore - graduation.graduates - graduation.studentsAfter : 0,
    donations: donations?.total ?? 0,
    endingTreasury: ending.treasury,
    endingStudents: ending.students,
    endingReputation: ending.reputation,
    endingAlumni: ending.alumni,
    dumpRank: currentStanding?.ownRank ?? null,
    dumpMovement: currentStanding?.ownRank && priorStanding?.ownRank
      ? priorStanding.ownRank - currentStanding.ownRank
      : 0,
    nextDisruption: disruptionById(content, publicReveal?.cardId),
    privateLookahead: disruptionById(content, privateReveal?.cardId),
  };
}

export function emergencySaleOptions(view, content) {
  if (view.pendingDecision?.type !== 'forcedSale' || view.legal?.kind !== 'decision') return [];
  const reputationLost = content.config.insolvencyAndElimination.forcedFireSaleReputationPenalty;
  return view.legal.commands.map((command) => ({
    command: structuredClone(command),
    department: command.department,
    recovery: command.recovery,
    upkeepSaved: command.upkeepSaved,
    reputationLost,
  }));
}

function ownTrend(event, humanId) {
  const active = event.players.filter((standing) => standing.active)
    .map((standing, order) => ({ ...standing, score: dumpScore(standing), order }))
    .sort((left, right) => right.score - left.score || left.order - right.order);
  let priorScore = null;
  let priorRank = null;
  active.forEach((standing, index) => {
    standing.rank = standing.score === priorScore ? priorRank : index + 1;
    priorScore = standing.score;
    priorRank = standing.rank;
  });
  const own = event.players.find((standing) => standing.playerId === humanId);
  const ranked = active.find((standing) => standing.playerId === humanId);
  return {
    round: event.round,
    ownRank: ranked?.rank ?? null,
    active: own?.active ?? false,
    students: own?.students ?? null,
    reputation: own?.reputation ?? null,
    alumni: own?.alumni ?? null,
    treasuryBand: own?.treasuryBand ?? null,
  };
}

export function boardBook(view, content) {
  const events = view.history.flatMap((entry) => entry.events);
  const cards = events.filter((event) => event.type === 'cardResolved').map((event) => (
    event.playerId === view.own.id
      ? explainCard(event, content, 'playerCard')
      : feedCard(event, content)
  ));
  const reportYears = [...new Set(view.history
    .filter((entry) => entry.events.some((event) => event.type === 'graduationResolved' && event.playerId === view.own.id))
    .map((entry) => Math.ceil(entry.round / content.config.gameLength.roundsPerYear)))];
  const trends = events.filter((event) => event.type === 'standingsPublished')
    .map((event) => ownTrend(event, view.own.id));
  const publicEvents = events.filter((event) => (
    (event.type === 'forcedSale' && event.playerId !== view.own.id)
    || event.type === 'playersEliminated'
    || event.type === 'gameFinished'
  )).map((event) => structuredClone(event));
  return {
    cards,
    reports: reportYears.map((year) => annualReport(view, content, year)),
    trends,
    publicEvents,
  };
}

function finalEvent(view) {
  for (const entry of [...view.history].reverse()) {
    const event = [...entry.events].reverse().find((candidate) => candidate.type === 'gameFinished');
    if (event) return event;
  }
  return null;
}

function turningPoint(event, winnerId, content) {
  if (event.type === 'playersEliminated') return `${event.playerIds.length} campus${event.playerIds.length === 1 ? '' : 'es'} closed during ${event.stage === 'postYearEnd' ? 'the annual close' : 'term resolution'}.`;
  if (event.type === 'forcedSale' && event.playerId === winnerId) return `The winner survived austerity by selling ${event.department}.`;
  if (event.type === 'cardResolved' && event.playerId === winnerId) {
    const card = content ? cardById(content, event.kind, event.cardId) : null;
    return `A ${event.kind}, ${card?.name ?? event.cardId}, reshaped the winner's position.`;
  }
  if (event.type === 'actionsResolved') {
    const action = event.actions.find((candidate) => candidate.playerId === winnerId && candidate.type !== 'bank');
    if (action?.department) return `A late ${action.department} ${action.type} changed the winning campus.`;
    if (action?.program) return `Opening ${action.program} became part of the winning portfolio.`;
  }
  return null;
}

export function finalIssue(view, content = null) {
  const event = finalEvent(view);
  const winnerId = view.winnerId ?? event?.winnerId;
  const schools = [view.own, ...view.opponents];
  const winnerName = schools.find((school) => school.id === winnerId)?.name ?? winnerId;
  const standing = view.standings?.find((candidate) => candidate.playerId === winnerId);
  const turningPoints = view.history.flatMap((entry) => entry.events)
    .map((event) => turningPoint(event, winnerId, content))
    .filter(Boolean).slice(-3);
  return {
    kind: 'finalIssue',
    winnerId,
    winnerName,
    reason: event?.reason ?? 'complete',
    explanation: 'The engine result decides the winner; DUMP remains a public marketing ranking, not a victory rule.',
    turningPoints,
    publicFactors: standing ? {
      students: standing.students,
      reputation: standing.reputation,
      departmentLevels: Object.values(standing.departments).reduce((total, level) => total + level, 0),
      programs: standing.programs.length,
      alumni: standing.alumni,
      treasuryBand: standing.treasuryBand,
    } : null,
  };
}

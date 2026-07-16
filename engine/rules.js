import { canonicalStringify, DEPARTMENTS, digest } from './content.js';
import { nextRng, shuffle } from './rng.js';

export function roundMoney(value) {
  if (!Number.isFinite(value)) throw new TypeError('money: must be finite');
  const scaled = value * 100;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  const epsilon = 1e-9;
  const rounded = fraction < 0.5 - epsilon
    ? lower
    : fraction > 0.5 + epsilon
      ? lower + 1
      : Math.abs(lower % 2) === 0 ? lower : lower + 1;
  return rounded / 100;
}

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const activePlayers = (state) => state.players.filter((player) => player.active);

function requireValue(condition, path, message) {
  if (!condition) throw new TypeError(`${path}: ${message}`);
}

function cardById(cards, id) {
  return cards.find((card) => card.id === id);
}

function effects(card, type) {
  return card?.effects.filter((effect) => effect.type === type) ?? [];
}

function product(card, type, fallback = 1) {
  return effects(card, type).reduce((value, effect) => value * effect.value, fallback);
}

function drawDeck(state, name, sourceCards) {
  const deck = state.decks[name];
  if (deck.draw.length === 0) {
    const reshuffled = shuffle(deck.discard, state.rng);
    deck.draw = reshuffled.items;
    deck.discard = [];
    state.rng = reshuffled.rng;
  }
  requireValue(deck.draw.length > 0, `state.decks.${name}`, 'cannot draw from an empty deck');
  const id = deck.draw.shift();
  deck.discard.push(id);
  return cardById(sourceCards, id);
}

function upgradeCost(player, department, config) {
  const current = player.departments[department];
  const next = current + 1;
  const cumulative = config.departmentCostCurve.buildCostToReachLevel;
  const currentCost = current === config.startingState.allDepartmentsLevel ? 0 : cumulative[current];
  const multiplier = config.departmentCostCurve.costMultipliers[department]
    ?? config.departmentCostCurve.costMultipliers.default;
  return (cumulative[next] - currentCost) * multiplier;
}

function saleRecovery(player, department, config) {
  const current = player.departments[department];
  const cumulative = config.departmentCostCurve.buildCostToReachLevel;
  const currentCost = cumulative[current];
  const priorCost = current - 1 === config.startingState.allDepartmentsLevel ? 0 : cumulative[current - 1];
  const multiplier = config.departmentCostCurve.costMultipliers[department]
    ?? config.departmentCostCurve.costMultipliers.default;
  return (currentCost - priorCost) * multiplier * config.insolvencyAndElimination.fireSaleRecoveryFraction;
}

function disruptionCard(state, content) {
  return state.disruptions.active
    ? cardById(content.cards.annualDisruptions, state.disruptions.active)
    : null;
}

function headlineCard(state, content) {
  return state.headline ? cardById(content.cards.headlines, state.headline) : null;
}

function programDefinition(config, program) {
  return { ...config.programs.defaults, ...config.programs.catalog[program] };
}

function programRider(disruption, program) {
  return effects(disruption, 'programRider').find((effect) => effect.program === program)?.modifier ?? {};
}

function openProgramCost(program, disruption, config) {
  const base = config.programs.catalog[program].openCost;
  const modifier = effects(disruption, 'programOpenCostMultiplier')
    .find((effect) => effect.program === program)?.value ?? 1;
  return base * modifier;
}

function poachTerms(disruption, headline, config) {
  const modifier = effects(disruption, 'poachModifier')[0] ?? {};
  const headlineDelta = effects(headline, 'poachCostDelta')[0]?.value ?? 0;
  return {
    cost: config.poaching.cost * (modifier.costMultiplier ?? 1) + headlineDelta,
    fraction: config.poaching.fractionOfTargetYearLossesGained * (modifier.fractionMultiplier ?? 1),
  };
}

function actionCost(action, player, content, disruption, headline) {
  const config = content.config;
  if (action.type === 'upgrade') return upgradeCost(player, action.department, config);
  if (action.type === 'openProgram') return openProgramCost(action.program, disruption, config);
  if (action.type === 'campaign') return action.spend;
  if (action.type === 'poach') return poachTerms(disruption, headline, config).cost;
  return 0;
}

function validateAllocations(state, command, content, disruption, headline) {
  requireValue(['round', 'allocate'].includes(command?.type), 'command.type', 'expected round or allocate');
  requireValue(command.allocations && typeof command.allocations === 'object', 'command.allocations', 'must be an object');
  const activeIds = new Set(activePlayers(state).map((player) => player.id));
  for (const id of Object.keys(command.allocations)) {
    requireValue(activeIds.has(id), `command.allocations.${id}`, 'player is not active');
  }

  const normalized = {};
  for (const player of activePlayers(state)) {
    const path = `allocations.${player.id}`;
    const supplied = command.allocations[player.id] ?? [];
    requireValue(Array.isArray(supplied), path, 'must be an array');
    const actions = supplied.length === 0 ? [{ type: 'bank' }] : structuredClone(supplied);
    const maxActions = content.config.allocation.maxActionsPerRound + player.effects.extraActionsNextRound;
    requireValue(actions.length <= maxActions, path, `maximum ${maxActions} actions`);
    const types = new Set();
    let spend = 0;

    actions.forEach((action, index) => {
      const actionPath = `${path}[${index}]`;
      requireValue(action && typeof action === 'object', actionPath, 'must be an object');
      requireValue(['sell', 'upgrade', 'openProgram', 'poach', 'campaign', 'bank'].includes(action.type), `${actionPath}.type`, 'unknown action');
      requireValue(!types.has(action.type), path, `duplicate ${action.type} action`);
      types.add(action.type);

      if (action.type === 'sell' || action.type === 'upgrade') {
        requireValue(DEPARTMENTS.includes(action.department), `${actionPath}.department`, 'unknown department');
      }
      if (action.type === 'sell') {
        requireValue(player.departments[action.department] > content.config.startingState.allDepartmentsLevel, actionPath, 'department is already at its floor');
      }
      if (action.type === 'upgrade') {
        const maxLevel = Math.max(...Object.keys(content.config.departmentCostCurve.buildCostToReachLevel).map(Number));
        requireValue(player.departments[action.department] < maxLevel, actionPath, 'department is already at maximum level');
        if (action.department === 'admissions') {
          requireValue(state.roundOfYear === content.config.gameLength.yearEndRound, path, 'Admissions upgrades are only legal in round 5');
        }
      }
      if (action.type === 'openProgram') {
        requireValue(state.programsEnabled, path, 'programs are disabled');
        requireValue(action.program in content.config.programs.catalog, `${actionPath}.program`, 'unknown program');
        requireValue(!player.programs.includes(action.program), actionPath, 'program is already open');
        const slots = content.config.programs.slotsByAcademicsLevel[player.departments.academics];
        requireValue(player.programs.length < slots, path, 'no commit-time program slot is available');
      }
      if (action.type === 'campaign') {
        requireValue(Number.isFinite(action.spend) && action.spend >= 0, `${actionPath}.spend`, 'must be a non-negative number');
        requireValue(!player.effects.campaignBlockedNextRound, path, 'campaign is blocked this round');
        const levelCap = content.config.departments.marketing.campaignSpendCapByLevel[player.departments.marketing];
        const disruptionCap = effects(disruption, 'campaignSpendCap')[0]?.value ?? levelCap;
        requireValue(action.spend <= Math.min(levelCap, disruptionCap), `${actionPath}.spend`, 'exceeds campaign cap');
      }
      if (action.type === 'poach') {
        const target = state.players.find((candidate) => candidate.id === action.targetPlayerId);
        requireValue(target?.active && target.id !== player.id, `${actionPath}.targetPlayerId`, 'must identify another active player');
      }
      spend += actionCost(action, player, content, disruption, headline);
    });

    requireValue(spend === 0 || spend <= player.treasury + 1e-9, path, 'committed spend exceeds treasury before sale proceeds');
    normalized[player.id] = actions;
  }
  return normalized;
}

function applyHeadlineImmediate(player, headline, config) {
  for (const effect of headline.effects) {
    if (effect.type === 'reputationDeltaAll') {
      player.reputation = clamp(player.reputation + effect.value, config.resourceBounds.reputationMin, config.resourceBounds.reputationMax);
    }
    if (effect.type === 'moneyDeltaAll') player.treasury = roundMoney(player.treasury + effect.value);
    if (effect.type === 'programMoneyDelta' && player.programs.includes(effect.program)) {
      player.treasury = roundMoney(player.treasury + effect.value);
    }
  }
}

function resolveIncome(state, content, disruption, headline, events) {
  const config = content.config;
  const allUpkeep = product(headline, 'allUpkeepMultiplier') * product(disruption, 'upkeepMultiplier');
  const tuitionMultiplier = product(headline, 'tuitionMultiplier') * product(disruption, 'tuitionMultiplier');
  const disease = config.economy.costDiseaseUpkeepMultiplierPerYear ** (state.year - 1);
  const records = {};

  for (const player of activePlayers(state)) {
    applyHeadlineImmediate(player, headline, config);
    const tuition = player.students * config.economy.tuitionPerStudentPerRound * tuitionMultiplier;
    let upkeepBase = 0;
    for (const department of DEPARTMENTS) {
      const level = player.departments[department];
      const costMultiplier = config.departmentCostCurve.costMultipliers[department]
        ?? config.departmentCostCurve.costMultipliers.default;
      const headlineMultiplier = effects(headline, 'departmentUpkeepMultiplier')
        .filter((effect) => effect.department === department)
        .reduce((value, effect) => value * effect.value, 1);
      upkeepBase += config.departmentCostCurve.upkeepAtLevel[level] * costMultiplier * headlineMultiplier;
    }
    for (const program of player.programs) upkeepBase += config.programs.catalog[program].upkeepPerRound;
    const adminDiscount = player.departments.administration >= 4
      ? config.departments.administration.tiers['4'].totalUpkeepDiscount
      : 0;
    const upkeep = upkeepBase * disease * allUpkeep * (1 - adminDiscount);
    player.treasury = roundMoney(player.treasury + tuition - upkeep);
    player.paidUpkeepThisRound = upkeep;
    records[player.id] = { tuition, upkeep, treasury: player.treasury };
  }
  events.push({ type: 'incomeResolved', players: records });
}

function resolveActions(state, allocations, content, disruption, headline, events) {
  const config = content.config;
  const records = [];
  const order = ['sell', 'upgrade', 'openProgram', 'poach', 'campaign', 'bank'];

  for (const type of order) {
    for (const player of activePlayers(state)) {
      const action = allocations[player.id].find((candidate) => candidate.type === type);
      if (!action) continue;

      if (type === 'sell') {
        const recovery = saleRecovery(player, action.department, config);
        player.departments[action.department] -= 1;
        player.treasury = roundMoney(player.treasury + recovery);
        records.push({ playerId: player.id, type, department: action.department, recovery });
      } else if (type === 'upgrade') {
        const cost = upgradeCost(player, action.department, config);
        player.treasury = roundMoney(player.treasury - cost);
        player.departments[action.department] += 1;
        records.push({ playerId: player.id, type, department: action.department, cost });
      } else if (type === 'openProgram') {
        const cost = openProgramCost(action.program, disruption, config);
        player.treasury = roundMoney(player.treasury - cost);
        player.programs.push(action.program);
        records.push({ playerId: player.id, type, program: action.program, cost });
      } else if (type === 'poach') {
        const target = state.players.find((candidate) => candidate.id === action.targetPlayerId);
        requireValue(target.yearLosses >= config.poaching.targetEligibilityMinStudentsLostThisYear, `allocations.${player.id}`, 'poach target is not eligible');
        const terms = poachTerms(disruption, headline, config);
        const students = Math.floor(target.yearLosses * terms.fraction);
        player.treasury = roundMoney(player.treasury - terms.cost);
        player.students += students;
        records.push({ playerId: player.id, type, targetPlayerId: target.id, students, cost: terms.cost });
      } else if (type === 'campaign') {
        player.treasury = roundMoney(player.treasury - action.spend);
        records.push({ playerId: player.id, type, spend: action.spend });
      } else {
        records.push({ playerId: player.id, type });
      }
    }
  }
  events.push({ type: 'actionsResolved', actions: records });
  return records;
}

function reputationMultiplier(player, exponent = 1) {
  return (player.reputation / 50) ** exponent;
}

function resolveRecruiting(state, allocations, content, disruption, headline, events) {
  const config = content.config;
  const poolMultiplier = product(disruption, 'poolMultiplier') * product(headline, 'poolAllotmentMultiplier');
  const allotment = config.recruiting.annualApplicantPoolByYear[state.year]
    / config.gameLength.roundsPerYear * poolMultiplier;
  const allPullMultiplier = product(headline, 'allPullMultiplier');
  const yieldMultiplier = product(disruption, 'yieldMultiplier') * product(headline, 'yieldMultiplier');
  const exponentDelta = effects(disruption, 'reputationPullExponentDelta')[0]?.value ?? 0;
  const classesByPlayer = {};
  let reservedPull = 0;
  let scalablePull = 0;

  for (const player of activePlayers(state)) {
    const classes = [];
    const admissionsPull = player.departments.admissions
      * config.departments.admissions.pullPerLevelPerRound
      * reputationMultiplier(player, 1 + exponentDelta)
      * allPullMultiplier;
    classes.push({ name: 'admissions', pull: admissionsPull, yield: config.departments.admissions.baseYield, scalable: true });
    if (player.effects.bonusConversionsPending > 0) {
      classes.push({ name: 'bonus', pull: player.effects.bonusConversionsPending * allPullMultiplier, yield: 1, scalable: true });
    }

    const campaign = allocations[player.id].find((action) => action.type === 'campaign');
    if (campaign) {
      const headlineCampaign = product(headline, 'campaignPullMultiplier');
      const pull = campaign.spend * config.departments.marketing.pullPerMillionSpent
        * player.effects.campaignPullMultiplierNext * headlineCampaign
        * reputationMultiplier(player, 1 + exponentDelta) * allPullMultiplier;
      classes.push({ name: 'campaign', pull, yield: null, scalable: true });
    }

    if (state.programsEnabled) {
      for (const program of player.programs) {
        const definition = programDefinition(config, program);
        const rider = programRider(disruption, program);
        const headlineProgram = effects(headline, 'programPullMultiplier')
          .filter((effect) => effect.program === program)
          .reduce((value, effect) => value * effect.value, 1);
        const exponent = program === 'business' ? 2 : 1 + exponentDelta;
        const rep = definition.subjectToReputationMultiplier === false ? 1 : reputationMultiplier(player, exponent);
        const pull = (definition.pullPerRound + (rider.pullPerRoundBonus ?? 0))
          * (rider.pullMultiplier ?? 1) * headlineProgram * allPullMultiplier * rep;
        classes.push({ name: program, pull, yield: definition.yield, scalable: definition.subjectToPoolScaling !== false });
      }
    }

    classesByPlayer[player.id] = classes;
    for (const pullClass of classes) {
      if (pullClass.scalable) scalablePull += pullClass.pull;
      else reservedPull += pullClass.pull;
    }
  }

  const remainingAllotment = Math.max(0, allotment - reservedPull);
  const scale = scalablePull > remainingAllotment && scalablePull > 0 ? remainingAllotment / scalablePull : 1;
  const playerResults = {};

  for (const player of activePlayers(state)) {
    const classResults = {};
    let totalConversions = 0;
    for (const pullClass of classesByPlayer[player.id]) {
      const scaledPull = pullClass.pull * (pullClass.scalable ? scale : 1);
      let classYield = pullClass.yield;
      if (pullClass.name === 'campaign') {
        const next = nextRng(state.rng);
        state.rng = next.rng;
        const marketing = config.departments.marketing;
        const configured = marketing.campaignYieldMin + next.value * (marketing.campaignYieldMax - marketing.campaignYieldMin);
        const floor = marketing.campaignYieldMin
          + player.departments.admissions * marketing.campaignYieldFloorBonusPerAdmissionsLevel
          + player.effects.campaignYieldFloorBonusNext;
        classYield = player.effects.campaignYieldLockNext ?? Math.max(configured, floor);
      }
      classYield = Math.min(1, classYield * yieldMultiplier);
      const conversions = Math.floor(scaledPull * classYield);
      totalConversions += conversions;
      classResults[pullClass.name] = { pull: pullClass.pull, scaledPull, yield: classYield, conversions };
    }
    totalConversions = Math.floor(totalConversions * player.effects.recruitingPenaltyNextRound);
    player.students += totalConversions;
    playerResults[player.id] = { classes: classResults, totalConversions, scale };

    player.effects.bonusConversionsPending = 0;
    player.effects.extraActionsNextRound = 0;
    player.effects.campaignBlockedNextRound = false;
    player.effects.recruitingPenaltyNextRound = 1;
    if (allocations[player.id].some((action) => action.type === 'campaign')) {
      player.effects.campaignYieldFloorBonusNext = 0;
      player.effects.campaignYieldLockNext = null;
      player.effects.campaignPullMultiplierNext = 1;
    }
  }

  events.push({
    type: 'recruitingResolved',
    allotment,
    reservedPull,
    remainingAllotment,
    scalablePull,
    scale,
    players: playerResults,
    cursorAfter: state.rng.cursor,
  });
}

export function startRound(inputState, content) {
  const state = structuredClone(inputState);
  requireValue(!state.finished, 'state.finished', 'game is already complete');
  requireValue(state.round < content.config.simulationAcceptanceCriteria.maxGameRounds, 'state.round', 'maximum game length reached');
  requireValue(state.phase === 'ready', 'state.phase', 'game is awaiting another command');
  state.round += 1;
  state.year = Math.ceil(state.round / content.config.gameLength.roundsPerYear);
  state.roundOfYear = ((state.round - 1) % content.config.gameLength.roundsPerYear) + 1;
  if (state.round > 1) state.prioritySeat = (state.prioritySeat + 1) % state.players.length;
  const events = [{ type: 'roundStarted', round: state.round, year: state.year, roundOfYear: state.roundOfYear, prioritySeat: state.prioritySeat }];

  const headline = drawDeck(state, 'headline', content.cards.headlines);
  state.headline = headline.id;
  events.push({ type: 'headlineRevealed', cardId: headline.id });
  const disruption = disruptionCard(state, content);
  resolveIncome(state, content, disruption, headline, events);
  state.phase = 'allocation';
  return { state, events, rng: state.rng, pendingDecision: null };
}

export function resolveAllocationThroughRecruiting(inputState, command, content) {
  const state = structuredClone(inputState);
  requireValue(state.phase === 'allocation', 'state.phase', 'game is not accepting allocations');
  state.phase = 'resolving';
  const events = [];
  const headline = headlineCard(state, content);
  const disruption = disruptionCard(state, content);
  const normalized = validateAllocations(state, command, content, disruption, headline);
  resolveActions(state, normalized, content, disruption, headline, events);
  resolveRecruiting(state, normalized, content, disruption, headline, events);
  state.phase = 'ready';
  return { state, events, rng: state.rng, pendingDecision: null };
}

export function resolveRoundThroughRecruiting(inputState, command, content) {
  requireValue(command?.type === 'round', 'command.type', 'expected round');
  const started = startRound(inputState, content);
  const allocated = resolveAllocationThroughRecruiting(started.state, { type: 'allocate', allocations: command.allocations }, content);
  return { ...allocated, events: [...started.events, ...allocated.events] };
}

function priorityDistance(state, player) {
  return (player.seat - state.prioritySeat + state.players.length) % state.players.length;
}

function awardRaceReward(state, content, events) {
  const disruption = disruptionCard(state, content);
  const race = effects(disruption, 'raceReward')[0];
  if (!race || state.disruptions.claimedRaceRewards.includes(disruption.id)) return;
  const eligible = activePlayers(state)
    .filter((player) => player.reputation >= (race.condition.reputationAtLeast ?? Infinity))
    .sort((a, b) => priorityDistance(state, a) - priorityDistance(state, b));
  if (eligible.length === 0) return;
  const winner = eligible[0];
  const conversions = race.reward.bonusConversions ?? 0;
  winner.students += Math.floor(conversions);
  state.disruptions.claimedRaceRewards.push(disruption.id);
  events.push({ type: 'raceReward', cardId: disruption.id, playerId: winner.id, bonusConversions: conversions });
}

function resolveAthletics(state, content, events) {
  const extras = new Set();
  if (state.roundOfYear !== content.config.gameLength.athleticsSeasonRound) return extras;
  const disruption = disruptionCard(state, content);
  const payout = effects(disruption, 'athleticsPayoutMultiplier')[0] ?? {};
  const athletics = content.config.departments.athletics;

  for (const player of activePlayers(state)) {
    const next = nextRng(state.rng);
    state.rng = next.rng;
    const odds = athletics.seasonOddsByLevel[player.departments.athletics];
    const outcome = next.value < odds.great
      ? 'great'
      : next.value < odds.great + odds.good ? 'good' : 'losing';
    const configured = athletics[`${outcome}Season`];
    const multiplier = outcome === 'great' ? (payout.great ?? 1) : outcome === 'losing' ? (payout.losing ?? 1) : 1;
    player.treasury = roundMoney(player.treasury + (configured.money ?? 0) * multiplier);
    player.reputation = clamp(
      player.reputation + (configured.reputation ?? 0) * multiplier,
      content.config.resourceBounds.reputationMin,
      content.config.resourceBounds.reputationMax,
    );
    if (configured.bonusConversionsNextRound) player.effects.bonusConversionsPending += configured.bonusConversionsNextRound;
    if (configured.drawExtraCrisisTargetedAtAthletics) extras.add(player.id);
    events.push({ type: 'athleticsSeason', playerId: player.id, outcome, roll: next.value });
  }
  awardRaceReward(state, content, events);
  return extras;
}

function targetCard(state, player, card, kind, content) {
  const next = nextRng(state.rng);
  state.rng = next.rng;
  const weights = DEPARTMENTS.map((department) => {
    if (kind !== 'crisis' || !state.programsEnabled) return 1;
    return player.programs.reduce((weight, program) => (
      weight * (content.config.programs.catalog[program].crisisTargetWeightModifiers?.[department] ?? 1)
    ), 1);
  });
  if (card.target !== 'random') return { target: card.target, weights, value: next.value };
  let needle = next.value * weights.reduce((total, weight) => total + weight, 0);
  for (let index = 0; index < weights.length; index += 1) {
    needle -= weights[index];
    if (needle < 0) return { target: DEPARTMENTS[index], weights, value: next.value };
  }
  return { target: DEPARTMENTS.at(-1), weights, value: next.value };
}

function applyEffect(player, effect, factor, state, content, skippedEffects) {
  const scale = effect.scalable ? factor : 1;
  const value = typeof effect.value === 'number' ? effect.value * scale : effect.value;
  switch (effect.type) {
    case 'money':
      player.treasury = roundMoney(player.treasury + value);
      break;
    case 'reputation':
      player.reputation = clamp(
        player.reputation + value,
        content.config.resourceBounds.reputationMin,
        content.config.resourceBounds.reputationMax,
      );
      break;
    case 'bonusConversionsThisRound':
      player.students += Math.floor(value);
      break;
    case 'bonusConversionsNextRound':
      player.effects.bonusConversionsPending += Math.floor(value);
      break;
    case 'retentionDeltaThisYear':
      player.effects.retentionDeltaThisYear += value;
      break;
    case 'campaignYieldFloorBonusNext':
      player.effects.campaignYieldFloorBonusNext += value;
      break;
    case 'campaignYieldLockNext':
      player.effects.campaignYieldLockNext = value;
      break;
    case 'campaignPullMultiplierNext':
      player.effects.campaignPullMultiplierNext *= value;
      break;
    case 'campaignBlockedNextRound':
      player.effects.campaignBlockedNextRound = Boolean(value);
      break;
    case 'upkeepRefundFraction':
      player.treasury = roundMoney(player.treasury + player.paidUpkeepThisRound * value);
      break;
    case 'temporaryCapacityThisYear':
      player.effects.temporaryCapacityThisYear += Math.floor(value);
      break;
    case 'donationMultiplierThisYearEnd':
      player.effects.donationMultiplierThisYearEnd *= value;
      break;
    case 'nextCrisisSeverityReduction':
      player.effects.nextCrisisSeverityReduction += value;
      break;
    case 'extraActionsNextRound':
      player.effects.extraActionsNextRound += value;
      break;
    case 'treasuryRevealedRounds':
      player.effects.treasuryRevealedRounds = Math.max(player.effects.treasuryRevealedRounds, value);
      break;
    case 'recruitingPenaltyNextRound':
      player.effects.recruitingPenaltyNextRound *= value;
      break;
    case 'programRider':
      if (!state.programsEnabled || !player.programs.includes(effect.program)) {
        skippedEffects.push(effect.type);
      } else {
        applyEffect(player, effect.bonus, 1, state, content, skippedEffects);
      }
      break;
    default:
      throw new TypeError(`card effect: unhandled type ${effect.type}`);
  }
}

function applyCard(state, context, content, events) {
  const player = state.players.find((candidate) => candidate.id === context.playerId);
  const source = context.kind === 'fortune' ? content.cards.fortuneCards : content.cards.crisisCards;
  const card = cardById(source, context.cardId);
  const targetLevel = player.departments[context.target];
  const targetFactor = context.kind === 'fortune'
    ? (targetLevel + 1) / 3
    : (6 - targetLevel) / 5;
  const severityFactor = context.kind === 'crisis' ? context.effectiveSeverity / card.severity : 1;
  const factor = targetFactor * severityFactor;
  const skippedEffects = [];
  for (const effect of card.effects) applyEffect(player, effect, factor, state, content, skippedEffects);
  events.push({
    type: 'cardResolved',
    kind: context.kind,
    cardId: card.id,
    playerId: player.id,
    target: context.target,
    targetLevel,
    targetWeights: context.targetWeights,
    targetRngValue: context.targetRngValue,
    targetRngConsumed: 1,
    effectiveSeverity: context.effectiveSeverity,
    factor,
    extra: context.extra,
    effectTypes: card.effects.map((effect) => effect.type),
    skippedEffects,
  });
  awardRaceReward(state, content, events);
}

function nextCardContext(state, entry, content) {
  const player = state.players.find((candidate) => candidate.id === entry.playerId);
  const source = entry.kind === 'fortune' ? content.cards.fortuneCards : content.cards.crisisCards;
  const card = drawDeck(state, entry.kind, source);
  const targetResult = entry.extra
    ? (() => {
      const next = nextRng(state.rng);
      state.rng = next.rng;
      return { target: 'athletics', weights: DEPARTMENTS.map(() => 1), value: next.value };
    })()
    : targetCard(state, player, card, entry.kind, content);
  let effectiveSeverity = card.severity;
  if (entry.kind === 'crisis') {
    if (player.departments.administration >= 2) {
      effectiveSeverity -= content.config.departments.administration.tiers['2'].crisisSeverityReduction;
    }
    effectiveSeverity -= player.effects.nextCrisisSeverityReduction;
    player.effects.nextCrisisSeverityReduction = 0;
    effectiveSeverity = Math.max(1, effectiveSeverity);
  }
  return {
    ...entry,
    cardId: card.id,
    target: targetResult.target,
    targetWeights: targetResult.weights,
    targetRngValue: targetResult.value,
    effectiveSeverity,
  };
}

function beginAusterity(state, content, events) {
  state.resolution = { step: 'austerity', playerIndex: 0 };
  return continueAusterity(state, content, events);
}

function continueAusterity(state, content, events) {
  while (state.resolution.playerIndex < state.players.length) {
    const player = state.players[state.resolution.playerIndex];
    if (!player.active || player.treasury >= content.config.insolvencyAndElimination.austerityTreasuryThreshold) {
      state.resolution.playerIndex += 1;
      continue;
    }
    player.enteredAusterity = true;
    const choices = DEPARTMENTS.filter((department) => player.departments[department] > 1);
    if (choices.length === 0) {
      state.resolution.playerIndex += 1;
      continue;
    }
    state.pendingDecision = { type: 'forcedSale', playerId: player.id, choices };
    state.phase = 'pending';
    return { state, events, rng: state.rng, pendingDecision: structuredClone(state.pendingDecision) };
  }
  return finishRound(state, content, events);
}

function resolveStrain(state, content, events) {
  const disruption = disruptionCard(state, content);
  const firstOffense = effects(disruption, 'strainFirstOffensePenalty')[0]?.value ?? 0;
  for (const player of activePlayers(state)) {
    const programCapacity = state.programsEnabled
      ? player.programs.reduce((total, program) => total + (content.config.programs.catalog[program].academicsCapacityBonus ?? 0), 0)
      : 0;
    const capacity = player.departments.academics * content.config.departments.academics.studentCapacityPerLevel
      + programCapacity + player.effects.temporaryCapacityThisYear;
    if (player.students <= capacity) continue;
    const penalty = content.config.departments.academics.strainReputationPenaltyPerRound
      + (player.strainedRounds === 0 ? firstOffense : 0);
    player.reputation = clamp(
      player.reputation - penalty,
      content.config.resourceBounds.reputationMin,
      content.config.resourceBounds.reputationMax,
    );
    player.strainedRounds += 1;
    events.push({ type: 'strainApplied', playerId: player.id, capacity, students: player.students, reputationPenalty: penalty });
  }
}

function continueChance(state, queue, content, events) {
  while (queue.length) {
    const context = nextCardContext(state, queue.shift(), content);
    const player = state.players.find((candidate) => candidate.id === context.playerId);
    const canCancel = context.kind === 'crisis'
      && player.departments.administration >= 5
      && player.adminCancelsUsed < content.config.departments.administration.tiers['5'].crisisCancelsPerYear;
    if (canCancel) {
      state.resolution = { step: 'chance', queue, current: context };
      state.pendingDecision = {
        type: 'adminCrisis',
        playerId: player.id,
        cardId: context.cardId,
        target: context.target,
        effectiveSeverity: context.effectiveSeverity,
        choices: ['cancel', 'keep'],
      };
      state.phase = 'pending';
      events.push({ ...state.pendingDecision, type: 'cardAwaitingDecision' });
      return { state, events, rng: state.rng, pendingDecision: structuredClone(state.pendingDecision) };
    }
    applyCard(state, context, content, events);
  }
  resolveStrain(state, content, events);
  return beginAusterity(state, content, events);
}

function continueAfterRecruiting(state, content, events) {
  awardRaceReward(state, content, events);
  const extraCrises = resolveAthletics(state, content, events);
  const queue = [];
  for (const player of activePlayers(state)) {
    queue.push({ playerId: player.id, kind: 'fortune', extra: false });
    queue.push({ playerId: player.id, kind: 'crisis', extra: false });
    if (extraCrises.has(player.id)) queue.push({ playerId: player.id, kind: 'crisis', extra: true });
  }
  return continueChance(state, queue, content, events);
}

export function resolveRound(inputState, command, content) {
  const recruiting = resolveRoundThroughRecruiting(inputState, command, content);
  return continueAfterRecruiting(recruiting.state, content, recruiting.events);
}

export function resolveAllocation(inputState, command, content) {
  const recruiting = resolveAllocationThroughRecruiting(inputState, command, content);
  return continueAfterRecruiting(recruiting.state, content, recruiting.events);
}

export function resumeDecision(inputState, command, content) {
  const state = structuredClone(inputState);
  const pending = state.pendingDecision;
  requireValue(state.phase === 'pending' && pending, 'state.pendingDecision', 'no decision is pending');
  requireValue(command?.type === 'decision', 'command.type', 'expected decision');
  requireValue(command.decision === pending.type, 'command.decision', `expected ${pending.type}`);
  requireValue(command.playerId === pending.playerId, 'command.playerId', `expected ${pending.playerId}`);
  const events = [];

  if (pending.type === 'adminCrisis') {
    requireValue(pending.choices.includes(command.choice), 'command.choice', 'must be cancel or keep');
    const player = state.players.find((candidate) => candidate.id === pending.playerId);
    const context = state.resolution.current;
    if (command.choice === 'cancel') {
      player.adminCancelsUsed += 1;
      events.push({ type: 'cardCancelled', kind: 'crisis', cardId: context.cardId, playerId: player.id, target: context.target });
    } else {
      applyCard(state, context, content, events);
    }
    const queue = state.resolution.queue;
    state.pendingDecision = null;
    state.phase = 'resolving';
    return continueChance(state, queue, content, events);
  }

  requireValue(pending.choices.includes(command.department), 'command.department', 'department is not eligible for forced sale');
  const player = state.players.find((candidate) => candidate.id === pending.playerId);
  const recovery = saleRecovery(player, command.department, content.config);
  player.departments[command.department] -= 1;
  player.treasury = roundMoney(player.treasury + recovery);
  player.reputation = clamp(
    player.reputation - content.config.insolvencyAndElimination.forcedFireSaleReputationPenalty,
    content.config.resourceBounds.reputationMin,
    content.config.resourceBounds.reputationMax,
  );
  events.push({ type: 'forcedSale', playerId: player.id, department: command.department, recovery });
  state.pendingDecision = null;
  state.phase = 'resolving';
  return continueAusterity(state, content, events);
}

export function healthScore(player, config) {
  const weights = config.victory.tiebreakAtYear6.weights;
  const departmentLevels = Object.values(player.departments).reduce((total, level) => total + level, 0);
  return player.treasury * weights.treasury
    + player.students * weights.students
    + player.reputation * weights.reputation
    + departmentLevels * weights.departmentLevel
    + player.programs.length * weights.program
    + player.alumni * weights.alumni;
}

function chooseHealthWinner(players, state, config) {
  return [...players].sort((a, b) => (
    healthScore(b, config) - healthScore(a, config)
    || b.students - a.students
    || b.alumni - a.alumni
    || priorityDistance(state, a) - priorityDistance(state, b)
  ))[0];
}

function finishGame(state, winner, reason, events) {
  state.finished = true;
  state.winnerId = winner.id;
  state.endReason = reason;
  events.push({ type: 'gameFinished', winnerId: winner.id, reason, round: state.round });
}

function resolveEliminations(state, candidates, content, events, stage) {
  const unique = [...new Map(candidates.filter((player) => player.active).map((player) => [player.id, player])).values()];
  if (unique.length === 0) return;
  const eliminatedIds = new Set(unique.map((player) => player.id));
  const survivors = activePlayers(state).filter((player) => !eliminatedIds.has(player.id));
  const fraction = content.config.recruiting.eliminatedPlayerInheritance.fractionRedistributedToSurvivors;
  const inheritancePool = unique.reduce((total, player) => total + Math.floor(player.students * fraction), 0);
  const inheritances = {};

  if (survivors.length > 0 && inheritancePool > 0) {
    const reputationTotal = survivors.reduce((total, player) => total + player.reputation, 0);
    for (const survivor of survivors) {
      const share = reputationTotal > 0 ? survivor.reputation / reputationTotal : 1 / survivors.length;
      const inherited = Math.floor(inheritancePool * share);
      survivor.students += inherited;
      inheritances[survivor.id] = inherited;
    }
  }

  for (const player of unique) {
    player.active = false;
    player.eliminatedRound = state.round;
  }
  events.push({
    type: 'playersEliminated',
    stage,
    playerIds: unique.map((player) => player.id),
    inheritancePool,
    inheritances,
    inheritanceRemainder: inheritancePool - Object.values(inheritances).reduce((total, value) => total + value, 0),
  });

  if (survivors.length === 1) finishGame(state, survivors[0], 'soleSurvivor', events);
  else if (survivors.length === 0) finishGame(state, chooseHealthWinner(unique, state, content.config), 'simultaneousElimination', events);
}

function treasuryBand(treasury, config) {
  return config.standings.treasuryBands.find((band) => band.maxExclusive === null || treasury < band.maxExclusive).name;
}

function publishStandings(state, content, events) {
  const standings = state.players.map((player) => ({
    playerId: player.id,
    active: player.active,
    students: player.students,
    reputation: player.reputation,
    treasuryBand: treasuryBand(player.treasury, content.config),
    ...(player.effects.treasuryRevealedRounds > 0 ? { treasury: player.treasury } : {}),
    departments: structuredClone(player.departments),
    programs: [...player.programs],
    alumni: player.alumni,
  }));
  state.standings = standings;
  events.push({ type: 'standingsPublished', round: state.round, players: structuredClone(standings) });
  for (const player of state.players) {
    if (player.effects.treasuryRevealedRounds > 0) player.effects.treasuryRevealedRounds -= 1;
  }
}

function resolveGraduationAndAttrition(state, content, events) {
  const config = content.config;
  for (const player of activePlayers(state)) {
    const yearStartStudents = player.students;
    const seniors = Math.floor(player.students * config.economy.seniorCohortFractionOfStudents);
    const graduationRate = config.departments.academics.graduationRateBase
      + config.departments.academics.graduationRatePerLevel * player.departments.academics;
    const graduates = Math.floor(seniors * graduationRate);
    const studentsBefore = player.students;
    player.students -= graduates;
    player.alumni += graduates;
    events.push({ type: 'graduationResolved', playerId: player.id, studentsBefore, seniors, graduationRate, graduates, studentsAfter: player.students });

    const programRetention = state.programsEnabled
      ? player.programs.reduce((total, program) => total + (config.programs.catalog[program].annualRetentionBonus ?? 0), 0)
      : 0;
    const retentionBeforeStrain = Math.min(
      config.departments.studentAffairs.retentionCap,
      config.departments.studentAffairs.retentionBase
        + config.departments.studentAffairs.retentionPerLevel * player.departments.studentAffairs
        + programRetention
        + player.effects.retentionDeltaThisYear,
    );
    const strainPenalty = player.strainedRounds * config.departments.academics.strainAnnualRetentionPenaltyPerStrainedRound;
    const retention = Math.max(0, retentionBeforeStrain - strainPenalty);
    const attritionStart = player.students;
    player.students = Math.floor(player.students * retention);
    player.yearLosses = yearStartStudents - player.students;
    events.push({
      type: 'attritionResolved',
      playerId: player.id,
      studentsBefore: attritionStart,
      retentionBeforeStrain,
      strainPenalty,
      retention,
      studentsAfter: player.students,
    });
    player.strainedRounds = 0;
  }
}

function resolveDonations(state, content, events) {
  const config = content.config;
  const disruption = disruptionCard(state, content);
  const annualMultiplier = product(disruption, 'donationMultiplier');
  for (const player of activePlayers(state)) {
    let donationPerAlum = config.economy.donationPerAlumPerYearBase * player.departments.academics;
    if (state.programsEnabled) {
      for (const program of player.programs) {
        const definition = config.programs.catalog[program];
        const rider = programRider(disruption, program);
        donationPerAlum += (definition.donationPerAlumBonusPerYear ?? 0) * (rider.donationBonusMultiplier ?? 1);
      }
    }
    const donations = player.alumni * donationPerAlum * player.effects.donationMultiplierThisYearEnd * annualMultiplier;
    const grants = state.programsEnabled
      ? player.programs.reduce((total, program) => (
        total + (config.programs.catalog[program].annualStateGrantPerAdminLevel ?? 0) * player.departments.administration
      ), 0)
      : 0;
    player.treasury = roundMoney(player.treasury + donations + grants);
    events.push({ type: 'donationsResolved', playerId: player.id, alumni: player.alumni, donationPerAlum, donations, grants, total: donations + grants });
  }
}

function drawFutureDisruption(state, year) {
  if (state.disruptions.revealedByYear[year]) return state.disruptions.revealedByYear[year];
  requireValue(state.decks.disruption.draw.length > 0, 'state.decks.disruption', 'no unrevealed disruption remains');
  const cardId = state.decks.disruption.draw.shift();
  state.disruptions.revealedByYear[year] = cardId;
  return cardId;
}

function resolveDisruptionReveals(state, content, events) {
  const nextYear = state.year + 1;
  if (nextYear <= content.config.gameLength.maxYears) {
    const publicCard = drawFutureDisruption(state, nextYear);
    state.disruptions.active = publicCard;
    events.push({ type: 'disruptionActivated', cardId: publicCard, year: nextYear });
    events.push({ type: 'disruptionRevealed', visibility: 'public', cardId: publicCard, year: nextYear });
  }

  const futureYear = state.year + 2;
  if (futureYear <= content.config.gameLength.maxYears) {
    const privateCard = drawFutureDisruption(state, futureYear);
    const playerIds = activePlayers(state)
      .filter((player) => player.departments.administration >= 3)
      .map((player) => player.id);
    state.disruptions.privateByPlayer ??= {};
    for (const playerId of playerIds) {
      state.disruptions.privateByPlayer[playerId] ??= {};
      state.disruptions.privateByPlayer[playerId][futureYear] = privateCard;
    }
    if (playerIds.length) events.push({ type: 'disruptionRevealed', visibility: 'private', cardId: privateCard, year: futureYear, playerIds });
  }
}

function awardSafetyNet(state, content, events) {
  const safetyNet = content.config.insolvencyAndElimination.safetyNet;
  const eligible = activePlayers(state)
    .filter((player) => !player.usedSafetyNet)
    .sort((a, b) => a.treasury - b.treasury || priorityDistance(state, a) - priorityDistance(state, b));
  const recipient = eligible[0];
  if (!recipient || recipient.treasury >= safetyNet.treasuryThreshold) return;
  recipient.treasury = roundMoney(recipient.treasury + safetyNet.amount);
  recipient.usedSafetyNet = true;
  events.push({ type: 'safetyNetAwarded', playerId: recipient.id, amount: safetyNet.amount });
}

function resetYearEffects(state) {
  for (const player of state.players) {
    player.adminCancelsUsed = 0;
    player.effects.retentionDeltaThisYear = 0;
    player.effects.temporaryCapacityThisYear = 0;
    player.effects.donationMultiplierThisYearEnd = 1;
  }
}

function resolveYearEnd(state, content, events) {
  resolveGraduationAndAttrition(state, content, events);
  resolveDonations(state, content, events);
  resolveDisruptionReveals(state, content, events);
  awardSafetyNet(state, content, events);
  const minimum = content.config.insolvencyAndElimination.minimumStudents;
  resolveEliminations(state, activePlayers(state).filter((player) => player.students < minimum), content, events, 'postYearEnd');

  if (!state.finished && state.year === content.config.gameLength.maxYears) {
    const winner = chooseHealthWinner(activePlayers(state), state, content.config);
    events.push({
      type: 'healthScoresComputed',
      scores: Object.fromEntries(activePlayers(state).map((player) => [player.id, healthScore(player, content.config)])),
    });
    finishGame(state, winner, 'year6HealthScore', events);
  }
  resetYearEffects(state);
}

function persistSnapshot(state, events) {
  const payload = structuredClone(state);
  delete payload.lastSnapshot;
  delete payload.resolution;
  payload.pendingDecision = null;
  const bytes = canonicalStringify(payload);
  state.lastSnapshot = { round: state.round, cursor: state.rng.cursor, digest: digest(payload) };
  events.push({ type: 'roundSnapshot', ...state.lastSnapshot, bytes });
}

function finishRound(state, content, events) {
  const rules = content.config.insolvencyAndElimination;
  const casualties = activePlayers(state).filter((player) => (
    player.students < rules.minimumStudents
    || (player.treasury < rules.austerityTreasuryThreshold
      && DEPARTMENTS.every((department) => player.departments[department] === content.config.startingState.allDepartmentsLevel))
  ));
  resolveEliminations(state, casualties, content, events, 'round');
  delete state.resolution;
  state.pendingDecision = null;
  publishStandings(state, content, events);
  if (!state.finished && state.roundOfYear === content.config.gameLength.yearEndRound) resolveYearEnd(state, content, events);
  state.phase = state.finished ? 'complete' : 'ready';
  persistSnapshot(state, events);
  return { state, events, rng: state.rng, pendingDecision: null };
}

export function observeGame(state, playerId, content) {
  const own = state.players.find((player) => player.id === playerId);
  requireValue(own, 'playerId', 'unknown player');
  const publicThroughYear = Math.max(2, state.year + 1);
  const publicDisruptions = Object.fromEntries(Object.entries(state.disruptions.revealedByYear)
    .filter(([year]) => Number(year) <= publicThroughYear));
  const opponents = state.players.filter((player) => player.id !== playerId).map((player) => ({
    id: player.id,
    name: player.name,
    seat: player.seat,
    active: player.active,
    students: player.students,
    reputation: player.reputation,
    alumni: player.alumni,
    departments: structuredClone(player.departments),
    programs: [...player.programs],
    yearLosses: player.yearLosses,
    treasuryBand: treasuryBand(player.treasury, content.config),
    ...(player.effects.treasuryRevealedRounds > 0 ? { treasury: player.treasury } : {}),
  }));
  return {
    schemaVersion: state.schemaVersion,
    phase: state.phase,
    round: state.round,
    year: state.year,
    roundOfYear: state.roundOfYear,
    prioritySeat: state.prioritySeat,
    programsEnabled: state.programsEnabled,
    headline: state.headline,
    activeDisruption: state.disruptions.active,
    publicDisruptions,
    privateDisruptions: structuredClone(state.disruptions.privateByPlayer?.[playerId] ?? {}),
    own: structuredClone(own),
    opponents,
    pendingDecision: state.pendingDecision?.playerId === playerId ? structuredClone(state.pendingDecision) : null,
    finished: state.finished,
    winnerId: state.winnerId,
  };
}

function upkeepSavedBySale(player, department, config) {
  const current = player.departments[department];
  const multiplier = config.departmentCostCurve.costMultipliers[department]
    ?? config.departmentCostCurve.costMultipliers.default;
  return (config.departmentCostCurve.upkeepAtLevel[current]
    - config.departmentCostCurve.upkeepAtLevel[current - 1]) * multiplier;
}

export function legalActions(state, playerId, content) {
  const player = state.players.find((candidate) => candidate.id === playerId);
  requireValue(player?.active, 'playerId', 'player is not active');

  if (state.phase === 'pending') {
    requireValue(state.pendingDecision?.playerId === playerId, 'playerId', 'another player owns the pending decision');
    const pending = state.pendingDecision;
    if (pending.type === 'adminCrisis') {
      return {
        kind: 'decision',
        commands: pending.choices.map((choice) => ({ type: 'decision', decision: pending.type, playerId, choice })),
      };
    }
    return {
      kind: 'decision',
      commands: pending.choices.map((department) => ({
        type: 'decision',
        decision: pending.type,
        playerId,
        department,
        recovery: saleRecovery(player, department, content.config),
        upkeepSaved: upkeepSavedBySale(player, department, content.config),
      })),
    };
  }

  requireValue(state.phase === 'allocation', 'state.phase', 'game is not accepting actions');
  const disruption = disruptionCard(state, content);
  const headline = headlineCard(state, content);
  const actions = [{ action: { type: 'bank' }, cost: 0 }];
  const config = content.config;
  const floor = config.startingState.allDepartmentsLevel;
  const maxLevel = Math.max(...Object.keys(config.departmentCostCurve.buildCostToReachLevel).map(Number));

  for (const department of DEPARTMENTS) {
    if (player.departments[department] > floor) {
      actions.push({
        action: { type: 'sell', department },
        cost: 0,
        recovery: saleRecovery(player, department, config),
        upkeepSaved: upkeepSavedBySale(player, department, config),
      });
    }
    if (player.departments[department] < maxLevel
      && (department !== 'admissions' || state.roundOfYear === config.gameLength.yearEndRound)) {
      const cost = upgradeCost(player, department, config);
      if (cost <= player.treasury) actions.push({ action: { type: 'upgrade', department }, cost });
    }
  }

  if (state.programsEnabled) {
    const slots = config.programs.slotsByAcademicsLevel[player.departments.academics];
    if (player.programs.length < slots) {
      for (const program of Object.keys(config.programs.catalog)) {
        if (player.programs.includes(program)) continue;
        const cost = openProgramCost(program, disruption, config);
        if (cost <= player.treasury) actions.push({ action: { type: 'openProgram', program }, cost });
      }
    }
  }

  if (!player.effects.campaignBlockedNextRound) {
    const levelCap = config.departments.marketing.campaignSpendCapByLevel[player.departments.marketing];
    const disruptionCap = effects(disruption, 'campaignSpendCap')[0]?.value ?? levelCap;
    const spend = Math.min(levelCap, disruptionCap, Math.max(0, player.treasury));
    if (spend > 0) actions.push({ action: { type: 'campaign', spend }, cost: spend });
  }

  const terms = poachTerms(disruption, headline, config);
  if (terms.cost <= player.treasury) {
    for (const target of activePlayers(state)) {
      if (target.id !== player.id && target.yearLosses >= config.poaching.targetEligibilityMinStudentsLostThisYear) {
        actions.push({ action: { type: 'poach', targetPlayerId: target.id }, cost: terms.cost });
      }
    }
  }

  return {
    kind: 'allocation',
    maxActions: config.allocation.maxActionsPerRound + player.effects.extraActionsNextRound,
    actions,
  };
}

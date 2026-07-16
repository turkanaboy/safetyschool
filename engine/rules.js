import { DEPARTMENTS } from './content.js';
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
  requireValue(command?.type === 'round', 'command.type', 'expected round');
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
    const maxActions = 2 + player.effects.extraActionsNextRound;
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

    requireValue(spend <= player.treasury + 1e-9, path, 'committed spend exceeds treasury before sale proceeds');
    normalized[player.id] = actions;
  }
  return normalized;
}

function applyHeadlineImmediate(player, headline) {
  for (const effect of headline.effects) {
    if (effect.type === 'reputationDeltaAll') player.reputation = clamp(player.reputation + effect.value, 0, 100);
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
    applyHeadlineImmediate(player, headline);
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
        const recovery = upgradeCost({ ...player, departments: { ...player.departments, [action.department]: player.departments[action.department] - 1 } }, action.department, config)
          * config.insolvencyAndElimination.fireSaleRecoveryFraction;
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

export function resolveRoundThroughRecruiting(inputState, command, content) {
  const state = structuredClone(inputState);
  requireValue(!state.finished, 'state.finished', 'game is already complete');
  requireValue(state.phase === 'ready', 'state.phase', 'game is awaiting another command');
  state.phase = 'resolving';
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
  const normalized = validateAllocations(state, command, content, disruption, headline);
  resolveActions(state, normalized, content, disruption, headline, events);
  resolveRecruiting(state, normalized, content, disruption, headline, events);
  state.phase = 'ready';
  return { state, events, rng: state.rng, pendingDecision: null };
}

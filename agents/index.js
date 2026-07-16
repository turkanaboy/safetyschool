import { DEPARTMENTS } from '../engine/content.js';
import { createRng, nextRng } from '../engine/rng.js';

export const POLICY_VERSION = '1.5.0';
export const AGENT_TYPES = Object.freeze([
  'steadyHand', 'gambler', 'prestigePlay', 'fortress', 'oracle', 'random',
]);

const CASH_RESERVES = Object.freeze({
  steadyHand: 5,
  gambler: 12,
  prestigePlay: 12,
  fortress: 12,
  oracle: 16,
});

const POLICIES = Object.freeze({
  steadyHand: {
    setup: { admissions: 2, studentAffairs: 1 },
    build: ['admissions', 'studentAffairs', 'academics', 'administration', 'marketing', 'athletics'],
    programs: ['education', 'nursing', 'business'],
  },
  gambler: {
    setup: { athletics: 2, admissions: 1 },
    build: ['admissions', 'studentAffairs', 'administration', 'academics', 'athletics', 'marketing'],
    programs: ['business', 'publicAffairs', 'nursing'],
  },
  prestigePlay: {
    setup: { academics: 2, admissions: 1 },
    build: ['admissions', 'academics', 'administration', 'studentAffairs', 'marketing', 'athletics'],
    programs: ['artsAndSciences', 'engineering', 'education'],
  },
  fortress: {
    setup: { studentAffairs: 2, admissions: 1 },
    build: ['admissions', 'studentAffairs', 'academics', 'administration', 'marketing', 'athletics'],
    programs: ['nursing', 'education', 'publicAffairs'],
  },
  oracle: {
    setup: { administration: 2, admissions: 1 },
    build: ['administration', 'academics', 'studentAffairs', 'admissions', 'marketing', 'athletics'],
    programs: ['publicAffairs', 'artsAndSciences', 'engineering'],
  },
});

function scriptedSetup(type, id, name) {
  return { id, name, upgrades: structuredClone(POLICIES[type].setup) };
}

function chooseScriptedAllocation(type, observation, legal) {
  const policy = POLICIES[type];
  const options = legal.actions.filter((option) => option.action.type !== 'bank');
  const selected = [];
  const usedTypes = new Set();
  let spend = 0;

  const add = (option) => {
    if (!option || selected.length >= legal.maxActions || usedTypes.has(option.action.type)) return false;
    const requiredReserve = option.cost > 0 ? CASH_RESERVES[type] : 0;
    if (spend + option.cost > observation.own.treasury - requiredReserve + 1e-9) return false;
    selected.push(option.action);
    usedTypes.add(option.action.type);
    spend += option.cost;
    return true;
  };

  if (observation.own.treasury < 5) {
    add(options
      .filter((option) => option.action.type === 'sell')
      .sort((a, b) => policy.build.indexOf(b.action.department) - policy.build.indexOf(a.action.department)
        || b.recovery - a.recovery)[0]);
  }

  const upgrade = policy.build
    .map((department) => options.find((option) => option.action.type === 'upgrade'
      && option.action.department === department
      && observation.own.departments[department] < 4))
    .find(Boolean);
  const program = policy.programs
    .map((program) => options.find((option) => option.action.type === 'openProgram' && option.action.program === program))
    .find(Boolean);
  if (type === 'prestigePlay') {
    add(program);
    add(upgrade);
  } else {
    add(upgrade);
    add(program);
  }

  if (observation.own.treasury > 15) add(options.find((option) => option.action.type === 'poach'));
  if (observation.own.treasury > 25) add(options.find((option) => option.action.type === 'campaign'));
  if (selected.length === 0) add(options.find((option) => option.action.type === 'upgrade'));
  return selected;
}

export function createAgent(type, { seed }) {
  if (!AGENT_TYPES.includes(type)) throw new TypeError(`agent type: unknown ${type}`);
  let rng = createRng(seed);

  const randomValue = () => {
    const next = nextRng(rng);
    rng = next.rng;
    return next.value;
  };

  const randomSetup = (id, name) => {
    const upgrades = {};
    for (let count = 0; count < 3; count += 1) {
      const eligible = DEPARTMENTS.filter((department) => (upgrades[department] ?? 0) < 2);
      const department = eligible[Math.floor(randomValue() * eligible.length)];
      upgrades[department] = (upgrades[department] ?? 0) + 1;
    }
    return { id, name, upgrades };
  };

  const chooseRandomAllocation = (observation, legal) => {
    const candidates = legal.actions.filter((option) => option.action.type !== 'bank');
    const selected = [];
    const types = new Set();
    let spend = 0;
    const desired = legal.maxActions;
    const campaign = candidates.findIndex((option) => option.action.type === 'campaign');
    if (campaign >= 0) {
      const [option] = candidates.splice(campaign, 1);
      selected.push(option.action);
      types.add(option.action.type);
      spend += option.cost;
    }
    while (selected.length < desired && candidates.length > 0) {
      const index = Math.floor(randomValue() * candidates.length);
      const [option] = candidates.splice(index, 1);
      if (types.has(option.action.type) || spend + option.cost > observation.own.treasury + 1e-9) continue;
      selected.push(option.action);
      types.add(option.action.type);
      spend += option.cost;
    }
    return selected;
  };

  return {
    type,
    version: POLICY_VERSION,
    setup: (id, name) => type === 'random' ? randomSetup(id, name) : scriptedSetup(type, id, name),
    chooseAllocation(observation, legal) {
      if (legal.kind !== 'allocation') throw new TypeError('legal options: expected allocation');
      return type === 'random'
        ? chooseRandomAllocation(observation, legal)
        : chooseScriptedAllocation(type, observation, legal);
    },
    chooseDecision(observation, legal) {
      if (legal.kind !== 'decision' || legal.commands.length === 0) throw new TypeError('legal options: expected decision');
      if (type === 'random') return structuredClone(legal.commands[Math.floor(randomValue() * legal.commands.length)]);
      const pending = observation.pendingDecision;
      if (pending.type === 'adminCrisis') {
        const choice = pending.effectiveSeverity >= 2 ? 'cancel' : 'keep';
        return structuredClone(legal.commands.find((command) => command.choice === choice));
      }
      const core = new Set(POLICIES[type].build.slice(0, 2));
      return structuredClone([...legal.commands].sort((a, b) => (
        Number(core.has(a.department)) - Number(core.has(b.department))
        || (b.recovery / Math.max(b.upkeepSaved, Number.EPSILON))
          - (a.recovery / Math.max(a.upkeepSaved, Number.EPSILON))
      ))[0]);
    },
  };
}

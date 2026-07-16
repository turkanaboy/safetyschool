import { validateContent } from '/engine/content.js';
import { ENGINE_VERSION } from '/engine/index.js';
import { RIVAL_SCHOOLS } from '/game.js';

const startup = document.querySelector('#startup');
const startupTitle = document.querySelector('#startup-title');
const startupMessage = document.querySelector('#startup-message');
const retry = document.querySelector('#retry-startup');
const status = document.querySelector('#game-status');
const trayButton = document.querySelector('.tray-handle');
const tray = document.querySelector('#management-tray');
const fixtureButtons = [...document.querySelectorAll('[data-fixture]')];
const buildings = [...document.querySelectorAll('.building')];
const variantButtons = [...document.querySelectorAll('[data-building-variant]')];
const rivals = [...document.querySelectorAll('.rival-campus')];
let contentVersion = '';
let currentFixture = 'early';
let selectedDepartment = 'academics';
const buildingVariants = Object.fromEntries(buildings.map((building) => [building.dataset.department, 'heritage']));

const departmentNames = {
  academics: 'Academics',
  administration: 'Administration',
  admissions: 'Admissions',
  athletics: 'Athletics',
  marketing: 'Marketing',
  studentAffairs: 'Student Affairs',
};

const fixtures = {
  early: {
    condition: 'Early momentum',
    note: 'The quad feels hopeful, but every building still looks like a compromise.',
    levels: { academics: 3, administration: 1, admissions: 1, athletics: 1, marketing: 1, studentAffairs: 1 },
    resources: ['$24m', '8,400', '44', '16,250'],
    activity: ['Fall term begins with 8,400 students', 'Academics anchors the young campus'],
  },
  prosperous: {
    condition: 'Campus thriving',
    note: 'The satisfying “look at my little campus” phase: busy paths, confident buildings, and room to brag.',
    levels: { academics: 5, administration: 3, admissions: 5, athletics: 3, marketing: 3, studentAffairs: 3 },
    resources: ['$61m', '13,740', '71', '31,600'],
    activity: ['Applications surge after a top-three ranking', 'The quad is packed between classes'],
  },
  strained: {
    condition: 'Margins tightening',
    note: 'Success has made the institution expensive. Deferred work is visible and the crowd has thinned.',
    levels: { academics: 3, administration: 3, admissions: 3, athletics: 1, marketing: 1, studentAffairs: 1 },
    resources: ['$7m', '9,180', '39', '19,400'],
    activity: ['Upkeep consumed most of the annual margin', 'Facilities flags a growing repair backlog'],
  },
  austerity: {
    condition: 'Austerity measures',
    note: 'The board is still yours, but it looks painfully quiet. Every next move feels consequential.',
    levels: { academics: 1, administration: 1, admissions: 1, athletics: 1, marketing: 1, studentAffairs: 1 },
    resources: ['−$3m', '5,940', '22', '11,100'],
    activity: ['Austerity restrictions are now in effect', 'Nonessential campus operations paused'],
  },
};

function selectBuilding(department) {
  selectedDepartment = department;
  for (const building of buildings) building.setAttribute('aria-pressed', String(building.dataset.department === department));
  const building = buildings.find((candidate) => candidate.dataset.department === department);
  const level = building.dataset.level;
  document.querySelector('#selected-building strong').textContent = `${departmentNames[department]} · Level ${level}`;
  document.querySelector('#selected-building span').textContent = level === '5'
    ? 'A campus landmark operating at full strength.'
    : level === '3' ? 'A proven department with visible room to grow.' : 'A modest foundation competing for scarce attention.';
  variantButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.buildingVariant === buildingVariants[department])));
}

function setBuildingVariant(variant) {
  buildingVariants[selectedDepartment] = variant;
  buildings.find((building) => building.dataset.department === selectedDepartment).dataset.variant = variant;
  selectBuilding(selectedDepartment);
}

function renderFixture(name) {
  const fixture = fixtures[name];
  currentFixture = name;
  document.body.dataset.fixture = name;
  document.querySelector('#campus-condition').textContent = fixture.condition;
  document.querySelector('#atmosphere-note').textContent = fixture.note;
  fixtureButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.fixture === name)));

  buildings.forEach((building) => {
    const level = fixture.levels[building.dataset.department];
    const isUpgrade = level > Number(building.dataset.level);
    building.dataset.level = String(level);
    building.setAttribute('aria-label', `${departmentNames[building.dataset.department]}, Level ${level}`);
    building.querySelector('.building__caption b').textContent = String(level);
    if (isUpgrade && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      building.classList.remove('is-building');
      void building.offsetWidth;
      building.classList.add('is-building');
    }
  });

  ['treasury', 'students', 'reputation', 'alumni'].forEach((resource, index) => {
    document.querySelector(`#${resource}-value`).textContent = fixture.resources[index];
  });
  document.querySelector('#activity-feed').innerHTML = [
    ...(contentVersion ? [`Records validated · ${contentVersion}`] : []),
    ...fixture.activity,
  ].map((item) => `<li>${item}</li>`).join('');
  selectBuilding(selectedDepartment);
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function start() {
  retry.hidden = true;
  startupTitle.textContent = 'Opening the gates';
  startupMessage.textContent = 'Validating the official campus records…';
  try {
    const [config, cards] = await Promise.all([fetchJson('/balance-config.json'), fetchJson('/cards.json')]);
    const content = validateContent(config, cards);
    contentVersion = content.identity.configVersion;
    status.textContent = `Engine ${ENGINE_VERSION} · ${RIVAL_SCHOOLS.length} rival schools ready`;
    renderFixture(currentFixture);
    startup.hidden = true;
  } catch (error) {
    startupTitle.textContent = 'The campus could not open';
    startupMessage.textContent = `Check the local server and try again. ${error.message}`;
    retry.hidden = false;
    status.textContent = 'Startup error';
  }
}

trayButton.addEventListener('click', () => {
  const expanded = trayButton.getAttribute('aria-expanded') === 'true';
  trayButton.setAttribute('aria-expanded', String(!expanded));
  tray.setAttribute('aria-hidden', String(expanded));
  tray.inert = expanded;
});
fixtureButtons.forEach((button) => button.addEventListener('click', () => renderFixture(button.dataset.fixture)));
buildings.forEach((building) => building.addEventListener('click', () => selectBuilding(building.dataset.department)));
variantButtons.forEach((button) => button.addEventListener('click', () => setBuildingVariant(button.dataset.buildingVariant)));
rivals.forEach((rival) => rival.addEventListener('click', () => {
  const selected = rival.getAttribute('aria-pressed') === 'true';
  rivals.forEach((candidate) => candidate.setAttribute('aria-pressed', 'false'));
  rival.setAttribute('aria-pressed', String(!selected));
}));
retry.addEventListener('click', start);
renderFixture(currentFixture);
start();

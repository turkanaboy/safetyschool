import { AGENT_TYPES } from '/agents/index.js';
import { validateContent } from '/engine/content.js';
import { ENGINE_VERSION } from '/engine/index.js';

const startup = document.querySelector('#startup');
const startupTitle = document.querySelector('#startup-title');
const startupMessage = document.querySelector('#startup-message');
const retry = document.querySelector('#retry-startup');
const status = document.querySelector('#game-status');
const trayButton = document.querySelector('.tray-handle');
const tray = document.querySelector('#management-tray');

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
    status.textContent = `Engine ${ENGINE_VERSION} · ${AGENT_TYPES.length - 1} rivals ready`;
    document.querySelector('#activity-feed').innerHTML = `<li>Records validated · ${content.identity.configVersion}</li><li>Campus board ready for review</li>`;
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
  tray.hidden = expanded;
});
retry.addEventListener('click', start);
start();

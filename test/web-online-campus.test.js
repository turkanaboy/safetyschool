import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { campusPresentation, renderCampusBoard, startCampusMotion } from '../web/online-campus.js';

const runtime = JSON.parse(await readFile(new URL('../web/assets/university-quad/Runtime/runtime-manifest.json', import.meta.url)));
const characters = JSON.parse(await readFile(new URL('../web/assets/university-quad/Runtime/Characters/student-actions.json', import.meta.url)));

const own = {
  id: 'human-1',
  name: 'Founders Green',
  treasury: 24,
  students: 5653,
  reputation: 52,
  alumni: 1200,
  strainedRounds: 0,
  enteredAusterity: false,
  departments: {
    academics: 3,
    studentAffairs: 2,
    athletics: 1,
    admissions: 1,
    marketing: 1,
    administration: 2,
  },
};

test('online campus uses all six fitted building assets and the complete quad', () => {
  const presentation = campusPresentation(own, runtime);
  const html = renderCampusBoard(own, runtime, characters);

  assert.equal(presentation.buildings.length, 6);
  assert.equal(new Set(presentation.buildings.map(({ image }) => image)).size, 6);
  assert.ok(presentation.buildings.every(({ widthPercent }) => widthPercent >= 11));
  assert.match(html, /Board\/quad-base-six-pad\.png/);
  assert.match(html, /Props\/central-fountain-static\.png/);
  assert.equal((html.match(/class="building /g) ?? []).length, 6);
  assert.equal((html.match(/class="building online-building" role="img"/g) ?? []).length, 6);
  assert.doesNotMatch(html, /<button class="building/);
  assert.match(html, /Academics[\s\S]*Level <b>3<\/b>/);
  assert.equal((html.match(/class="person /g) ?? []).length, 10);
});

test('online campus condition reflects prosperity, strain, and austerity', () => {
  assert.equal(campusPresentation({ ...own, treasury: 45, reputation: 60 }, runtime).condition.key, 'prosperity');
  assert.equal(campusPresentation({ ...own, strainedRounds: 1 }, runtime).condition.key, 'strain');

  const austerity = campusPresentation({ ...own, treasury: -1, enteredAusterity: true }, runtime).condition;
  assert.equal(austerity.key, 'austerity');
  assert.equal(austerity.maintenance, true);
  assert.equal(austerity.protest, true);
  assert.equal(austerity.frisbee, false);
});

test('online campus motion can be stopped before a realtime rerender', () => {
  const cancelled = [];
  const people = Array.from({ length: 3 }, (_, index) => ({
    classList: { contains: (name) => name === 'person--runner' && index === 0 },
    animate: () => ({ cancel: () => cancelled.push(index) }),
  }));
  const originalWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: false }) };

  try {
    const stop = startCampusMotion({ querySelectorAll: () => people }, runtime);
    stop();
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }

  assert.deepEqual(cancelled, [0, 1, 2]);
});

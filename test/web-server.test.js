import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';

import { createPlayServer, startPlayServer } from '../web/server.js';

function fetchFrom(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, path, method }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    call.on('error', reject);
    call.end();
  });
}

async function withServer(run) {
  const server = createPlayServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(server.address().port);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('play server serves only the browser game graph with correct HTTP behavior', async () => {
  await withServer(async (port) => {
    const routes = [
      ['/', 'text/html'],
      ['/styles.css', 'text/css'],
      ['/app.js', 'text/javascript'],
      ['/game.js', 'text/javascript'],
      ['/presentation.js', 'text/javascript'],
      ['/storage.js', 'text/javascript'],
      ['/assets/university-quad/Runtime/runtime-manifest.json', 'application/json'],
      ['/assets/university-quad/Runtime/Board/quad-base-six-pad.png', 'image/png'],
      ...['academics', 'student-affairs', 'athletics', 'admissions', 'marketing', 'administration']
        .map((department) => [`/assets/university-quad/Runtime/Buildings/${department}.png`, 'image/png']),
      ['/assets/university-quad/Runtime/Characters/student-actions-atlas.png', 'image/png'],
      ['/assets/university-quad/Runtime/Characters/student-actions.json', 'application/json'],
      ['/assets/university-quad/Runtime/Props/central-fountain-static.png', 'image/png'],
      ['/engine/content.js', 'text/javascript'],
      ['/agents/index.js', 'text/javascript'],
      ['/balance-config.json', 'application/json'],
    ];

    for (const [path, type] of routes) {
      const response = await fetchFrom(port, path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers['content-type'], new RegExp(`^${type}`), path);
      assert.ok(response.body.length > 0, path);
    }

    const head = await fetchFrom(port, '/app.js', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.ok(Number(head.headers['content-length']) > 0);

    const method = await fetchFrom(port, '/', 'POST');
    assert.equal(method.status, 405);
    assert.equal(method.headers.allow, 'GET, HEAD');

    for (const path of ['/package.json', '/../package.json', '/%2e%2e/package.json', '/assets/kenney/academics.png', '/missing.js']) {
      const response = await fetchFrom(port, path);
      assert.equal(response.status, 404, path);
      assert.doesNotMatch(response.body, /Safety School[\\/]|ENOENT|package\.json/);
    }
  });
});

test('play server reports a fixed-origin port conflict instead of falling through', async () => {
  const occupied = createPlayServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const port = occupied.address().port;

  try {
    await assert.rejects(startPlayServer({ port, log: () => {} }), new RegExp(`127\\.0\\.0\\.1:${port}.*already in use`));
  } finally {
    occupied.close();
    await once(occupied, 'close');
  }
});

test('campus gameplay shell keeps the approved board and exposes the five management destinations', async () => {
  await withServer(async (port) => {
    const shell = await fetchFrom(port, '/');
    const app = await fetchFrom(port, '/app.js');
    for (const department of ['admissions', 'marketing', 'academics', 'studentAffairs', 'athletics', 'administration']) {
      assert.match(shell.body, new RegExp(`data-department="${department}"`));
    }
    assert.match(shell.body, />Definitive Ultimate Marketing Ploy</);
    assert.equal(shell.body.match(/class="building\b/g)?.length, 6);
    assert.equal(shell.body.match(/data-runtime-building/g)?.length, 6);
    assert.match(shell.body, /data-runtime-board/);
    assert.match(shell.body, /class="quad__fountain"[^>]*>\s*<img[^>]*data-runtime-fountain/);
    assert.doesNotMatch(shell.body, /\/assets\/kenney\//);
    for (const section of ['briefing', 'allocate', 'programs', 'rivals', 'boardBook']) {
      assert.match(shell.body, new RegExp(`data-management-section="${section}"`));
    }
    assert.match(shell.body, /data-management-section="allocate"[^>]*>Actions<\/button>/);
    assert.match(shell.body, /aria-label="Campus command bar"/);
    assert.doesNotMatch(shell.body, /class="activity"/);
    assert.match(shell.body, /id="tray-content"/);
    assert.match(shell.body, /id="setup-panel"/);
    assert.match(shell.body, /id="game-announcer"[^>]+aria-live="polite"/);
    assert.match(shell.body, /class="protest"/);
    assert.match(app.body, /button\.disabled = emergency && !emergencyShortcut/);
    assert.match(app.body, /Estimated alumni donations/);
  });
});

test('university quad manifest is the sole runtime asset contract', async () => {
  await withServer(async (port) => {
    const manifestResponse = await fetchFrom(port, '/assets/university-quad/Runtime/runtime-manifest.json');
    const manifest = JSON.parse(manifestResponse.body);
    const padIds = manifest.pads.map((pad) => pad.id);

    assert.equal(manifest.schemaVersion, 1);
    assert.equal(new Set(padIds).size, 6);
    assert.deepEqual(padIds.sort(), ['academics', 'administration', 'admissions', 'athletics', 'marketing', 'student-affairs']);
    assert.equal(manifest.fountain.statefulImplementation, 'static-sprite');
    assert.equal(manifest.fountain.overlayProceduralWaterOnFallback, false);
    assert.equal(new Set(Object.values(manifest.buildingTemplate.images)).size, 6);
    assert.equal(manifest.viewportContract.pageScroll, false);

    const app = await fetchFrom(port, '/app.js');
    const styles = await fetchFrom(port, '/styles.css');
    assert.match(app.body, /university-quad\/Runtime/);
    assert.match(app.body, /runtime-manifest\.json/);
    assert.match(app.body, /ResizeObserver/);
    assert.match(app.body, /dataset\.frisbee/);
    assert.match(app.body, /depth\.constructionFx/);
    assert.match(app.body, /buildingTemplate\.images\[pad\.id\]/);
    assert.match(app.body, /person\.animate\(/);
    assert.doesNotMatch(app.body, /applyBuildingGeometry\(building, level\);/);
    assert.doesNotMatch(app.body, /\/assets\/kenney\//);
    assert.match(styles.body, /--interaction-overlay-depth/);
    assert.match(styles.body, /--hud-depth/);
    assert.match(styles.body, /data-population="6"/);
    assert.match(styles.body, /data-population="3"/);
    assert.match(styles.body, /data-maintenance="on"/);
    assert.match(styles.body, /data-protest="on"/);
    assert.match(styles.body, /\.quad__fountain img/);
  });
});

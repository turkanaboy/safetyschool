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

    for (const path of ['/package.json', '/../package.json', '/%2e%2e/package.json', '/missing.js']) {
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

test('campus workshop exposes six named building plots and atmosphere fixtures', async () => {
  await withServer(async (port) => {
    const shell = await fetchFrom(port, '/');
    for (const department of ['admissions', 'marketing', 'academics', 'studentAffairs', 'athletics', 'administration']) {
      assert.match(shell.body, new RegExp(`data-department="${department}"`));
    }
    for (const fixture of ['early', 'prosperous', 'strained', 'austerity']) {
      assert.match(shell.body, new RegExp(`data-fixture="${fixture}"`));
    }
    assert.match(shell.body, />Definitive Ultimate Marketing Ploy</);
    assert.equal(shell.body.match(/class="building\b/g)?.length, 6);
  });
});

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const ROUTES = new Map([
  ['/', ['web/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['web/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
  ['/game.js', ['web/game.js', 'text/javascript; charset=utf-8']],
  ['/presentation.js', ['web/presentation.js', 'text/javascript; charset=utf-8']],
  ['/storage.js', ['web/storage.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['web/styles.css', 'text/css; charset=utf-8']],
  ['/agents/index.js', ['agents/index.js', 'text/javascript; charset=utf-8']],
  ['/engine/content.js', ['engine/content.js', 'text/javascript; charset=utf-8']],
  ['/engine/index.js', ['engine/index.js', 'text/javascript; charset=utf-8']],
  ['/engine/rng.js', ['engine/rng.js', 'text/javascript; charset=utf-8']],
  ['/engine/rules.js', ['engine/rules.js', 'text/javascript; charset=utf-8']],
  ['/balance-config.json', ['balance-config.json', 'application/json; charset=utf-8']],
  ['/cards.json', ['cards.json', 'application/json; charset=utf-8']],
]);

function send(response, status, body, headers = {}) {
  const bytes = Buffer.from(body);
  response.writeHead(status, {
    'content-length': bytes.length,
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  if (response.req.method !== 'HEAD') response.end(bytes);
  else response.end();
}

export function createPlayServer() {
  return createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      send(response, 405, 'Method not allowed', { allow: 'GET, HEAD' });
      return;
    }

    const rawPath = request.url.split('?')[0];
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      send(response, 404, 'Not found');
      return;
    }
    if (decodedPath.split('/').includes('..')) {
      send(response, 404, 'Not found');
      return;
    }

    const route = ROUTES.get(new URL(request.url, `http://${HOST}`).pathname);
    if (!route) {
      send(response, 404, 'Not found');
      return;
    }

    try {
      const body = await readFile(new URL(route[0], ROOT));
      send(response, 200, body, { 'content-type': route[1] });
    } catch {
      send(response, 500, 'Game asset unavailable');
    }
  });
}

export function startPlayServer({ port = DEFAULT_PORT, log = console.log } = {}) {
  const server = createPlayServer();
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') reject(new Error(`Safety School cannot start: http://${HOST}:${port} is already in use.`));
      else reject(error);
    });
    server.listen(port, HOST, () => {
      const url = `http://${HOST}:${port}`;
      log(`Safety School is ready at ${url}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startPlayServer().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

import { parentPort, workerData } from 'node:worker_threads';

import { loadContent } from '../engine/content-node.js';
import { runSchedule } from './run.js';

const content = loadContent();
const run = runSchedule(workerData.schedule, content, {
  verifyReplay: workerData.verifyReplay === 'all'
    ? true
    : workerData.verifyReplay === 'sample' ? (game) => game.cycle === 0 : false,
  onProgress: (complete, total) => {
    if (complete % 50 === 0 || complete === total) parentPort.postMessage({ type: 'progress', complete });
  },
});
parentPort.postMessage({
  type: 'complete',
  results: run.results,
  replayFailures: run.replayFailures,
  identity: content.identity,
});

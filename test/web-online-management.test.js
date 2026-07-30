import assert from 'node:assert/strict';
import test from 'node:test';

import { loadContent } from '../engine/content-node.js';
import { createMatchRuntime, matchViews } from '../multiplayer/runtime.js';
import { renderOnlineManagement } from '../web/online-management.js';

const content = loadContent();
const members = [
  { userId: 'human-1', name: 'Founders Green', seat: 0 },
  { userId: 'human-2', name: 'Safety State', seat: 1 },
];

test('multiplayer management surfaces use the filtered seat view', () => {
  const created = createMatchRuntime({ seed: 42, members }, content);
  created.state.players[1].treasury = 123.45;
  const view = matchViews(created.state, created.meta, content)['human-1'];

  assert.match(renderOnlineManagement('briefing', view, content), /Budget &amp; cash flow/);
  assert.match(renderOnlineManagement('briefing', view, content), /Estimated alumni donations/);
  assert.match(renderOnlineManagement('programs', view, content), /Academic portfolio/);

  const rivals = renderOnlineManagement('rivals', view, content, 'human-2');
  assert.match(rivals, /Safety State/);
  assert.doesNotMatch(rivals, /123\.45/);

  assert.match(renderOnlineManagement('boardBook', view, content), /Board Book/);
  assert.match(renderOnlineManagement('boardBook', view, content), /DUMP trend/);
});

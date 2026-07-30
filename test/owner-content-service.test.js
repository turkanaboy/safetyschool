import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createOwnerContentService } from '../supabase/functions/owner-content/service.js';

const config = JSON.parse(await readFile(new URL('../balance-config.json', import.meta.url)));
const cards = JSON.parse(await readFile(new URL('../cards.json', import.meta.url)));
const userId = '1819f2e2-38bd-4aa8-a4d3-b77c3a02a65c';

function memoryStore() {
  const sets = [];
  let activeId = null;
  let version = 0;
  const row = (values) => ({
    id: crypto.randomUUID(),
    version: ++version,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    published_at: null,
    validation: null,
    ...structuredClone(values),
  });
  return {
    sets,
    async ensureSeed(payload) {
      if (activeId) return sets.find(({ id }) => id === activeId);
      const seeded = row({
        status: 'published',
        deck: payload.deck,
        content_hash: payload.contentHash,
        created_by: payload.userId,
        validation: payload.validation,
        published_at: new Date().toISOString(),
      });
      sets.push(seeded);
      activeId = seeded.id;
      return seeded;
    },
    async overview(ownerId) {
      return {
        active: sets.find(({ id }) => id === activeId),
        drafts: sets.filter((set) => set.status === 'draft' && set.created_by === ownerId),
        published: sets.filter((set) => set.status === 'published'),
      };
    },
    async createDraft(ownerId) {
      const active = sets.find(({ id }) => id === activeId);
      const draft = row({
        status: 'draft',
        deck: active.deck,
        content_hash: active.content_hash,
        created_by: ownerId,
      });
      sets.push(draft);
      return draft;
    },
    async loadDraft(ownerId, setId) {
      const draft = sets.find((set) => set.id === setId && set.status === 'draft' && set.created_by === ownerId);
      if (!draft) throw new Error('Card set not found');
      return structuredClone(draft);
    },
    async saveDraft(payload) {
      const draft = sets.find((set) => set.id === payload.cardSetId && set.created_by === payload.userId);
      draft.deck = structuredClone(payload.deck);
      draft.content_hash = payload.contentHash;
      draft.updated_at = new Date().toISOString();
      return structuredClone(draft);
    },
    async publish({ cardSetId, validation }) {
      const draft = sets.find(({ id }) => id === cardSetId);
      draft.status = 'published';
      draft.validation = validation;
      draft.published_at = new Date().toISOString();
      activeId = draft.id;
      return structuredClone(draft);
    },
    async activate(cardSetId) {
      const published = sets.find((set) => set.id === cardSetId && set.status === 'published');
      if (!published) throw new Error('Published card set not found');
      activeId = published.id;
      return structuredClone(published);
    },
  };
}

test('owner content seeds, drafts, saves, and publishes a canonical whole deck', async () => {
  const store = memoryStore();
  const service = createOwnerContentService({ config, seedCards: cards, store });
  const first = await service.handle(userId, { action: 'overview' });
  const draft = await service.handle(userId, { action: 'createDraft' });
  const edited = structuredClone(draft.deck);
  edited.fortuneCards[0].name = 'A Very Useful Trustee';
  const saved = await service.handle(userId, { action: 'saveDraft', cardSetId: draft.id, deck: edited });
  const published = await service.handle(userId, { action: 'publish', cardSetId: draft.id });
  const final = await service.handle(userId, { action: 'overview' });

  assert.equal(first.published.length, 1);
  assert.equal(saved.deck.fortuneCards[0].name, 'A Very Useful Trustee');
  assert.equal(published.status, 'published');
  assert.equal(store.sets.find(({ id }) => id === draft.id).validation.games.length, 3);
  assert.equal(final.active.id, draft.id);
  assert.equal(final.drafts.length, 0);
});

test('owner content rejects unknown effects with the canonical card path', async () => {
  const service = createOwnerContentService({ config, seedCards: cards, store: memoryStore() });
  const draft = await service.handle(userId, { action: 'createDraft' });
  draft.deck.crisisCards[0].effects[0].type = 'inventNewMechanic';

  await assert.rejects(
    service.handle(userId, { action: 'saveDraft', cardSetId: draft.id, deck: draft.deck }),
    /cards\.crisisCards\[0\]\.effects\[0\]\.type/,
  );
});

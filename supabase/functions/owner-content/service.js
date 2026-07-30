import { validateContent } from '../../../engine/content.js';
import { runPublishSmoke } from '../../../sim/evaluate.js';

function cardSetSummary(set) {
  return {
    id: set.id,
    version: Number(set.version),
    status: set.status,
    contentHash: set.content_hash,
    createdAt: set.created_at,
    updatedAt: set.updated_at,
    publishedAt: set.published_at,
  };
}

function id(value) {
  const clean = String(value ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean)) {
    throw new Error('A valid card set is required.');
  }
  return clean;
}

export function createOwnerContentService({ config, seedCards, store }) {
  function validate(deck) {
    return validateContent(config, deck);
  }

  async function ensureSeed(userId) {
    const content = validate(seedCards);
    return store.ensureSeed({
      userId,
      deck: content.cards,
      contentHash: content.identity.cardsDigest,
      validation: { kind: 'canonical', passedAt: new Date().toISOString() },
    });
  }

  return {
    async handle(userId, input) {
      const action = input?.action;
      await ensureSeed(userId);

      if (action === 'overview') {
        const result = await store.overview(userId);
        return {
          active: cardSetSummary(result.active),
          drafts: result.drafts.map(cardSetSummary),
          published: result.published.map(cardSetSummary),
        };
      }

      if (action === 'createDraft') {
        const draft = await store.createDraft(userId);
        return { ...cardSetSummary(draft), deck: draft.deck };
      }

      if (action === 'loadDraft') {
        const draft = await store.loadDraft(userId, id(input.cardSetId));
        return { ...cardSetSummary(draft), deck: draft.deck };
      }

      if (action === 'saveDraft') {
        const content = validate(input.deck);
        const draft = await store.saveDraft({
          userId,
          cardSetId: id(input.cardSetId),
          deck: content.cards,
          contentHash: content.identity.cardsDigest,
        });
        return { ...cardSetSummary(draft), deck: draft.deck };
      }

      if (action === 'publish') {
        const draft = await store.loadDraft(userId, id(input.cardSetId));
        const content = validate(draft.deck);
        if (content.identity.cardsDigest !== draft.content_hash) throw new Error('Draft content changed; save and validate it again.');
        const smoke = runPublishSmoke(content);
        return cardSetSummary(await store.publish({
          cardSetId: draft.id,
          validation: {
            kind: 'canonical-and-smoke',
            passedAt: new Date().toISOString(),
            games: smoke.map(({ seed, round, endReason, finalStateDigest }) => ({
              seed, round, endReason, finalStateDigest,
            })),
          },
        }));
      }

      if (action === 'activate') return cardSetSummary(await store.activate(id(input.cardSetId)));
      throw new Error('Unknown owner content action.');
    },
  };
}

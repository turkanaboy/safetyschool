import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { canonicalStringify, validateContent } from './content.js';

export function nodeDigest(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

export function loadContent() {
  const config = JSON.parse(readFileSync(new URL('../balance-config.json', import.meta.url), 'utf8'));
  const cards = JSON.parse(readFileSync(new URL('../cards.json', import.meta.url), 'utf8'));
  return validateContent(config, cards, nodeDigest);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const content = loadContent();
  console.log(`Validated Safety School content ${content.identity.configVersion}/${content.identity.cardsVersion}`);
}

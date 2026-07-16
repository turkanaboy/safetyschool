const STEP = 0x6D2B79F5;

export function createRng(seed) {
  if (!Number.isInteger(seed)) throw new TypeError('seed: must be an integer');
  return { state: seed >>> 0, cursor: 0 };
}

export function nextRng(rng) {
  const state = (rng.state + STEP) >>> 0;
  let value = state;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  value = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  return { value, rng: { state, cursor: rng.cursor + 1 } };
}

export function shuffle(source, initialRng) {
  const items = [...source];
  let rng = initialRng;
  for (let index = items.length - 1; index > 0; index -= 1) {
    const next = nextRng(rng);
    rng = next.rng;
    const swapIndex = Math.floor(next.value * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return { items, rng };
}

export function deriveSeed(seed, label) {
  let value = seed >>> 0;
  for (const character of String(label)) {
    value = Math.imul(value ^ character.codePointAt(0), 0x45D9F3B) >>> 0;
  }
  return value;
}

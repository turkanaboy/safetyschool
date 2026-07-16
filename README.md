# SAFETY SCHOOL — Implementation Handoff Package
**v1.2 · July 2026 · Envoq LLC**

## Contents & reading order
1. `SAFETY-SCHOOL-GOING-CONCERN-DESIGN.md` — what the game is (design doc, v1.2)
2. `resolution-order.md` — exactly how a round and year resolve; **wins all conflicts** with the design doc
3. `balance-config.json` — every numeric constant; **wins all numeric conflicts**; the engine hardcodes nothing
4. `cards.json` — all 120 cards (12 Disruptions, 36 Fortune, 36 Crisis, 36 Headlines) against closed effect vocabularies
5. `BUILD-PLAN.md` — phased build: headless sim → hotseat/solo → Supabase multiplayer → polish

## Authority hierarchy
`balance-config.json` (numbers) > `resolution-order.md` (mechanics) > design doc (intent). Card content in `cards.json` may never require an effect type outside its file's vocabularies; new effect types are a versioned change.

## Phase 1 contract
Build a pure deterministic engine module — `(state, commands, content, rngCursor) → (state', events, rngCursor', pendingDecision)` — plus five archetype agents, a Random agent, Monte Carlo balance verification, and replay tooling. No UI or network. Shuffle each deck with Fisher–Yates at setup and reshuffle, draw from the top without consuming selection RNG, and consume exactly one target RNG value for every Fortune or Crisis card. Apply `bonusConversionsThisRound` immediately during Chance, outside pool scaling, before strain and elimination.

## What "done" looks like for Phase 1
A balance report showing all acceptance criteria green in both `programsEnabled` branches, plus a determinism proof (100% byte-identical replays). Expect the config to change during this phase — that is the system working as designed.

## Non-goals in Phase 1
Rendering, networking, lobbies, auth, animation, sound, timed mode. All of that waits for a proven engine.

# BUILD PLAN
### Safety School — Implementation Handoff v1.2

**Read first:** `SAFETY-SCHOOL-GOING-CONCERN-DESIGN.md` (what the game is) → `resolution-order.md` (exactly how a round resolves — this spec wins all conflicts) → `balance-config.json` (every number; hardcode nothing) → `cards.json` (complete content using closed effect vocabularies).

**Prime directive:** the engine is a pure, deterministic function: `(state, actions, config, rngCursor) → (state', events)`. No UI, no network, no clock inside the engine. Everything else in this plan is a shell around that function.

---

## Phase 1 — Headless engine + Monte Carlo balance harness
*The game must be proven fun-shaped in math before it exists in pixels.*

**Deliverables**
1. **Engine** (vanilla JS module, zero dependencies beyond a seeded PRNG): full round + year-end resolution per `resolution-order.md`. Loads `balance-config.json` and `cards.json` at init.
2. **Five archetype AIs** (design doc §10: Steady Hand, Gambler, Prestige Play, Fortress, Oracle) as simple policy functions — priority-ordered build scripts plus basic reactive rules (fire-sale policy, poach-when-able, campaign-when-cash-over-X, Admin L5 cancel heuristic: cancel any severity ≥2). Plus one **Random** agent as a sanity floor.
3. **Monte Carlo harness:** run N seeded games (mixed archetype lineups, 2–5 players), emit per-game logs and an aggregate report.
4. **Replay tool:** re-run any (seed, action-log) pair and diff final states — the determinism test.

**Acceptance criteria** (from `balance-config.json → simulationAcceptanceCriteria`, over ≥10,000 games):
- Every archetype owns 15–30% of winners in each balanced branch; Random owns <8%.
- Median game ends round 22–28; ≤15% of games end before Year 4; ≤40% reach the Year 6 tiebreak.
- Austerity escape rate 25% ± 8% (a player who enters forced fire-sales survives to game end).
- **Programs A/B:** the full suite runs with `programsEnabled` both true and false. Criteria must pass in both branches; additionally, with programs on, no single program appears in >60% of winning portfolios and none in <10% (no auto-include, no dead pick).
- Determinism: 100% of replays byte-identical.
- No game exceeds 30 rounds; no unresolvable states (fuzz with the Random agent, ≥1,000 games).

**Tuning loop:** when criteria fail, adjust *only* `balance-config.json`, re-run, commit config + report together. Never patch the engine to fix balance.

## Phase 2 — Local playable: hotseat + solo vs. AI
- Vanilla JS/HTML5 front end over the Phase 1 engine (no backend). Screens: dashboard (funnel view: applicants → enrolled → alumni), allocation panel, card-reveal moment (the satire showcase — give it staging), standings, year-end report ("Annual Report to the Board" framing).
- Solo mode = 2–4 archetype AIs from Phase 1, difficulty = which archetypes you face.
- Untimed casual flow: advance on confirm.
- Exit test: a full 4-player hotseat game with humans, 60–90 min, at least one austerity comeback attempt witnessed.

## Phase 3 — Async multiplayer (Supabase)
- Tables: `games`, `game_players`, `game_actions` (append-only action log), `game_snapshots` (state + RNG cursor per round — the Step 11 persistence unit). Realtime channel for phase-advance and reveals.
- Server-authoritative resolution: clients submit actions; an edge function runs the same engine module; clients verify against snapshots (determinism = free anti-cheat).
- Secrecy enforcement server-side: exact treasuries and Admin L3 foresight are row-level-secured, never shipped to non-entitled clients.
- Lobby, invites, reconnect-from-snapshot, and untimed async play (a round advances when all have confirmed, even across hours).

## Phase 4 — Content & polish
- Full satirical card pass (flavor text QA), sound, animation on the card-reveal and season-roll moments, timed competitive mode (config flag per resolution spec), spectator mode, post-game "institutional history" recap graph (the ups-and-downs, visualized).

---

## Repo shape
```
/engine        pure resolution module + config loader
/agents        archetype AI policies
/sim           Monte Carlo harness + reports
/web           Phase 2 front end
/supabase      Phase 3 schema + edge functions
/content       balance-config.json, cards.json, disruptions, headlines
/docs          design doc, resolution-order.md, this file
```

**Definition of "ready to start":** all four documents and the complete `cards.json` are present, and every Phase 1 acceptance threshold is config-owned.

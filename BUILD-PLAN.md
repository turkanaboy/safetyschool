# Safety School Build Plan

**Read first:** `SAFETY-SCHOOL-GOING-CONCERN-DESIGN.md` (product intent) → `resolution-order.md` (resolution rules) → `balance-config.json` (all numeric values) → `cards.json` (content and closed effect vocabularies).

**Prime directive:** the engine is a pure, deterministic function: `(state, actions, config, rngCursor) → (state', events)`. No UI, network, or clock belongs inside it.

## Phase 1 — Headless engine and balance harness (complete)

- Deterministic engine, seeded randomness, pending decisions, replays, and content validation.
- Five strategy archetypes plus a Random agent.
- Monte Carlo balance verification in both Programs branches and a 1,000-game fuzz run.
- Acceptance evidence in `reports/phase-1-balance.md` and `reports/phase-1-balance.json`.

## Phase 2 — Local solo campus experience (complete)

- One human school versus three named AI rivals; no backend or account.
- Full setup, autosave/resume, complete-game flow, player decisions, elimination, spectating, and skip to results.
- Full-screen 2.5D six-pad campus, distinct department buildings, animated campus activity, condition cues, construction states, three visible rival campuses, and the runtime fountain asset.
- Primary bottom navigation for Briefing, Actions, Programs, Rivals, and Board Book.
- Legible actions and building details, staged Headline/Fortune/Crisis reveals, rival feed, Emergency Board Meetings, Annual Reports, DUMP rankings, and final issue.
- Informational Briefing budget: recurring tuition versus upkeep, department/program expense detail, estimated annual support, staged one-time action spend, and last-term actuals. Department funding remains the validated level-and-card system; continuous dollar allocation is deferred because it would require a new economic model and balance pass.

The completion evidence and Phase 3 boundary are recorded in `docs/phase-2-completion.md`.

## Phase 3 — Multiplayer and operator tools (next)

The backend provider and deployment topology are intentionally undecided. Phase 3 begins with an architecture decision, not an assumed Supabase implementation.

Planned outcomes:

- Async multiplayer with accounts, lobbies/invites, reconnect, and untimed confirmation.
- Server-authoritative engine resolution with an append-only action history and deterministic snapshots/replays.
- Server-enforced secrecy for exact rival treasuries, private cards, and Administration foresight.
- An owner dashboard for aggregate game/player health, completion, pacing, errors, and balance signals.
- An owner card editor for content and existing approved modifiers. Any new modifier type must be treated as a versioned engine change and receive a full rebalance verification.

Architecture decisions to make before implementation:

- Hosting and data provider.
- Authentication and invitation model.
- Realtime versus polling behavior for async turns.
- Snapshot, retry, idempotency, and conflict policy.
- Privacy, retention, and access rules for owner analytics.

## Phase 4 — Content and polish

- Expanded and refined art, sound, animation, and satirical copy.
- Additional architecture sets and campus ambience.
- Timed competitive mode, spectator improvements, and post-game institutional-history visualization.
- Any separately approved economic redesign, including continuous department allocation, only after its own prototype and rebalance plan.

## Repository shape

```text
/engine    pure resolution module and content loading
/agents    deterministic AI policies
/sim       fuzzing, Monte Carlo simulation, and reports
/web       Phase 2 browser client and local HTTP server
/reports   generated balance evidence
/docs      plans, specifications, and completion records
```

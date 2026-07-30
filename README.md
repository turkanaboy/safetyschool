# Safety School

Safety School is a satirical university-management board game with complete solo and server-authoritative multiplayer loops.

## Play locally

Requirements: Node.js 24 or newer.

```powershell
npm.cmd install
npm.cmd run play
```

Open `http://127.0.0.1:4173`. The browser stores one autosaved local game; no account or backend is required.

## Current playable release: Phase 2

The solo build includes:

- A full-screen six-department campus with distinct buildings, animated students, campus-condition cues, and local construction effects.
- One human school against three named AI schools, with setup, autosave/resume, elimination, spectating, and skip-to-results flows.
- Clear term actions, building and program explanations, staged card reveals, Annual Reports, emergencies, rival intelligence, Board Book history, and the Definitive Ultimate Marketing Ploy (DUMP) Ranking.
- A Briefing budget view that compares recurring tuition and upkeep, itemizes spending by department and program, shows estimated annual support, and previews staged one-time actions. This view is informational; the validated level-based department mechanics remain authoritative.

See [docs/phase-2-completion.md](docs/phase-2-completion.md) for the completion record and Phase 3 handoff.

## Phase 3 multiplayer

The multiplayer build adds guest Supabase sessions, private realtime lobbies, synchronized founding plans and turns, AI-filled open seats, reconnectable match state, and the full Briefing, Actions, Programs, Rivals, and Board Book navigation for two to four humans. Matches pin an immutable card version when they start.

Open `http://127.0.0.1:4173/online.html` after starting the local server. See [docs/phase-3-foundation.md](docs/phase-3-foundation.md) for the architecture, live schema, deployment checklist, and next implementation boundary.

The designated permanent owner can open `http://127.0.0.1:4173/owner.html` to view aggregate game health and manage versioned card drafts. Owner sign-in uses a one-time email link; players still need no account.

## Verification

```powershell
npm.cmd run validate:content
npm.cmd test
npm.cmd run verify:phase1
```

The University Quad asset pack also has its own validator at `C:\Users\Summit E16 Flip\Desktop\Claude\Asset Bank\University Quad Asset Pack\validate-assets.ps1`.

## Project authority

When documents disagree:

1. `balance-config.json` controls numbers.
2. `resolution-order.md` controls mechanics and resolution order.
3. `SAFETY-SCHOOL-GOING-CONCERN-DESIGN.md` controls product intent.
4. `cards.json` controls card content within its closed effect vocabularies.

The engine is pure and deterministic. UI, storage, and future networking remain shells around the same authoritative game rules.

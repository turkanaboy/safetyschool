# Phase 3 Multiplayer Foundation

Updated: 2026-07-19
Branch: `codex/phase-3-multiplayer-foundation`

## Decision

Phase 3 uses the existing static browser game on Vercel with Supabase for authentication, Postgres persistence, row-level security, RPC command boundaries, and realtime lobby updates.

The confirmed multiplayer shape is:

- Two to four human players.
- Existing AI schools fill open seats when a match begins.
- Asynchronous play with no turn deadline.
- `tylermlowell@gmail.com` receives the initial owner role.

This slice deliberately stops at secure lobby readiness. It does not upload the Phase 2 local save, trust browser-authored game state, or start a multiplayer match.

## Delivered in this slice

- Passwordless email magic-link sign-in at `/online.html`.
- Automatic player profiles and initial owner-role assignment.
- Private eight-character lobby codes and shareable invite links.
- Create, join, resume, ready/unready, leave, and host-cancel operations.
- Four visible seats, with AI placeholders for empty seats.
- Realtime refresh for lobby membership, readiness, and cancellation.
- A Vercel static build that packages the solo game, multiplayer UI, engine/content assets, and pinned Supabase browser client into `dist/`.
- A solo-game entry point linking to multiplayer without changing the validated Phase 2 mechanics.

## Database contract

Applied Supabase migrations live in `supabase/migrations/` and create:

- `profiles`: one profile per authenticated user, with `player` or `owner` role.
- `lobbies`: host-owned waiting/cancelled lobbies with unique invite codes.
- `lobby_members`: one human per lobby seat, seats zero through three, with readiness state.
- `create_lobby`, `join_lobby`, `set_lobby_ready`, and `leave_lobby`: authenticated RPC mutations.

All three public tables have row-level security enabled. Anonymous table access and mutation RPC execution are revoked. Signed-in users can read only their own profile plus profiles, lobby rows, and membership rows shared through one of their lobbies. Browser clients cannot insert, update, or delete table rows directly.

Lobby mutations also update a lobby heartbeat row so Supabase Postgres Changes can notify remaining members when a membership row is deleted. Host cancellation retains the tiny membership rows as authorization tombstones; cancelled lobbies are excluded from the UI, and their members can no longer read one another's profiles. This avoids relying on filtered realtime `DELETE` events, which Supabase does not support.

The four public RPCs are intentionally `SECURITY DEFINER` because direct table writes are disabled. Each verifies `auth.uid()`, validates its target, uses a fixed empty `search_path`, and performs the smallest allowed mutation. Supabase's security advisor therefore reports the expected authenticated-security-definer warnings for these four functions; they are reviewed exceptions, not unguarded functions. See the [Supabase lint explanation](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).

## Configuration before public email testing

In Supabase Authentication settings:

1. Set the production Site URL to `https://safetyschool.com` after that domain serves the Vercel production deployment.
2. Add `https://safetyschool.com/online.html` as an allowed redirect URL.
3. Keep `http://127.0.0.1:4173/online.html` as a local-development redirect.
4. Add the exact active Vercel preview `/online.html` URL when testing a branch preview.
5. Configure custom SMTP before inviting players outside the Supabase project team. The built-in email sender is not intended for a public playtest.

The Supabase URL and publishable key are intentionally browser-visible public configuration. Never add a secret or service-role key to this repository, the browser bundle, or a `VITE_`/`NEXT_PUBLIC_`-style environment variable.

## Vercel deployment

The GitHub-connected Vercel project is `safetyschool`. `vercel.json` runs `npm run build` and publishes `dist/`; no runtime server or secret environment variable is required for this slice.

Before production testing:

1. Confirm a branch preview returns HTTP 200 for `/` and `/online.html`.
2. Attach `safetyschool.com` to the Vercel project and apply the DNS records Vercel provides.
3. Promote or merge only after the preview passes the browser checks.
4. Update Supabase Site URL and redirect allow-list entries to the final production URLs.

## Verification

Run locally:

```powershell
npm.cmd run validate:content
npm.cmd test
```

The focused Phase 3 checks cover lobby-code validation, magic-link redirect construction, RPC names and payloads, online static routes, the bundled Supabase client, the solo multiplayer entry point, and the existing campus shell contract.

Manual browser acceptance for this slice:

- `/online.html` renders a meaningful signed-out screen without a browser error or error overlay.
- The solo setup still renders and exposes the Online multiplayer link.
- After authentication is configured, two different accounts can join one lobby, see only shared members, change only their own readiness, and leave/cancel according to host status.

## Next implementation boundary

The next slice is server-authoritative match creation and turn resolution:

1. Add versioned match, player-seat, action-log, and snapshot records.
2. Start only from a lobby with at least two human members and the required readiness rule.
3. Seed and initialize the unchanged deterministic engine on the server.
4. Accept idempotent typed commands, validate the acting player and current decision, resolve on the server, and append the result transactionally.
5. Return player-filtered observations so treasury, private cards, and Administration foresight never cross an information boundary.
6. Reconnect from a versioned snapshot plus append-only actions; never accept a Phase 2 browser save as authoritative state.
7. Add match completion events that later owner analytics can aggregate.

The owner dashboard and copy-only card editor remain later Phase 3 slices. New card modifier types and continuous dollar-allocation budgeting remain separate mechanics work because either requires a complete engine/content contract and rebalance pass.

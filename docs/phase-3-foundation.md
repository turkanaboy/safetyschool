# Phase 3 Multiplayer Runtime

Updated: 2026-07-21
Branch: `codex/phase-3-campus-play`

## Decision

Phase 3 uses the existing static browser game on Vercel with Supabase for authentication, Postgres persistence, row-level security, RPC command boundaries, and realtime lobby updates.

The confirmed multiplayer shape is:

- Two to four human players.
- Existing AI schools fill open seats when a match begins.
- Asynchronous play with no turn deadline.
- The designated bootstrap account receives the initial owner role.

The browser never uploads the Phase 2 local save or authors canonical match state. An authenticated Edge Function validates commands and advances the unchanged deterministic engine; Postgres stores versioned snapshots and filtered player views.

## Delivered in this slice

- Guest entry at `/online.html` with a display name and no visible account login.
- Automatic player profiles and initial owner-role assignment.
- Private six-character lobby codes and shareable invite links; existing eight-character codes remain joinable.
- Create, join, resume, ready/unready, leave, and host-cancel operations.
- Four visible seats, with AI placeholders for empty seats.
- Realtime refresh for lobby membership, readiness, and cancellation.
- Host-only match start after at least two humans join and every human is ready.
- Fair four-campus initialization, with deterministic AI schools filling open seats and the same balanced founding plan for every human.
- Server-authoritative begin-term, allocation, pending-decision, completion, and winner transitions.
- Idempotent command IDs, compare-and-swap match versions, append-only command history, and reconnectable snapshots.
- Per-player realtime views that omit rivals' private treasury and private-card information.
- A playable multiplayer management screen with resources, campuses, events, action explanations, waiting state, and next-turn controls.
- A full-screen live campus board sourced only from each human's filtered authoritative observation.
- Six manifest-positioned, uniquely illustrated buildings whose visible size and level follow current department state.
- Runtime fountain, paths, moving students, frisbee, birds, flag, construction rise/dust, and prosperity/strain/austerity cues.
- DUMP rankings, current-turn controls, match activity, and campus resources arranged around the no-scroll desktop board.
- A Vercel static build that packages the solo game, multiplayer UI, engine/content assets, and pinned Supabase browser client into `dist/`.
- A solo-game entry point linking to multiplayer without changing the validated Phase 2 mechanics.

## Database contract

Applied Supabase migrations live in `supabase/migrations/` and create:

- `profiles`: one profile per authenticated user, with `player` or `owner` role.
- `lobbies`: host-owned waiting/cancelled lobbies with unique invite codes.
- `lobby_members`: one human per lobby seat, seats zero through three, with readiness state.
- `create_lobby`, `join_lobby`, `set_lobby_ready`, and `leave_lobby`: authenticated RPC mutations.
- `matches` and `match_seats`: the match lifecycle and immutable human/AI seat identities.
- `match_snapshots`: the current canonical engine state and server metadata.
- `match_views`: one filtered observation per human, published through Realtime.
- `match_actions` and `match_submissions`: idempotent command history and current-term human allocations.
- `commit_match_start`, `store_match_submission`, `update_match_views`, and `commit_match_transition`: service-role-only transactional mutations called by `match-command`.

All public tables have row-level security enabled. Access by the unauthenticated Postgres `anon` role and mutation RPC execution are revoked. Supabase Auth guest users receive unique IDs and the `authenticated` role, so they can read only their own profile, shared lobby records, match membership, and their own filtered match view. Browser clients cannot insert, update, or delete match rows directly.

Lobby mutations also update a lobby heartbeat row so Supabase Postgres Changes can notify remaining members when a membership row is deleted. Host cancellation retains the tiny membership rows as authorization tombstones; cancelled lobbies are excluded from the UI, and their members can no longer read one another's profiles. This avoids relying on filtered realtime `DELETE` events, which Supabase does not support.

The lobby RPCs are intentionally `SECURITY DEFINER` because direct table writes are disabled. Each verifies `auth.uid()`, validates its target, uses a fixed empty `search_path`, and performs the smallest allowed mutation. The match RPCs are executable only by `service_role`; the `match-command` Edge Function independently verifies the user's access token before invoking them. Supabase's security advisor may therefore report reviewed security-definer exceptions. See the [Supabase lint explanation](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).

## Configuration before guest testing

In Supabase Authentication settings:

1. Enable Anonymous Sign-Ins under Auth providers.
2. Keep the production Site URL set to `https://safetyschoolgame.com`.
3. Before sharing the game publicly, configure Cloudflare Turnstile or invisible CAPTCHA and pass its token to `signInAnonymously`; the initial private playtest does not include a CAPTCHA key.
4. Do not enable time-based anonymous-user deletion until match expiration exists. Deleting a guest who is seated in an active asynchronous match would remove that player's view and leave the match waiting for a player who can no longer reconnect.

The Supabase URL and publishable key are intentionally browser-visible public configuration. Never add a secret or service-role key to this repository, the browser bundle, or a `VITE_`/`NEXT_PUBLIC_`-style environment variable.

## Vercel deployment

The GitHub-connected Vercel project is `safetyschool`. `vercel.json` runs `npm run build` and publishes `dist/`. Authoritative match commands run in the deployed Supabase `match-command` Edge Function, whose secret API key is supplied by Supabase's managed function environment and never by Vercel or the browser.

Before production testing:

1. Confirm a branch preview returns HTTP 200 for `/` and `/online.html`.
2. Attach `safetyschoolgame.com` to the Vercel project and apply the DNS records Vercel provides.
3. Promote or merge only after the preview passes the browser checks.
4. Update Supabase Site URL and redirect allow-list entries to the final production URLs.

## Verification

Run locally:

```powershell
npm.cmd run validate:content
npm.cmd test
```

The focused Phase 3 checks cover guest-session metadata, lobby commands, authoritative runtime and service transitions, private observations, match command payloads, online static routes, and the existing campus shell contract.

Manual browser acceptance completed for this slice:

- `/online.html` renders a meaningful signed-out screen without a browser error or error overlay.
- The solo setup still renders and exposes the Online multiplayer link.
- Two isolated guests joined one lobby, readied, and started a four-campus match with two AI schools.
- Both guests received allocation controls, the first waited for the second, and the second submission resolved the term once for both players.
- Reloading a guest restored the same active match and version.
- Stored player views exposed each player's own treasury and no opponent treasury values.
- The live match rendered all six distinct building assets, the fountain, paths, and ten campus actors with no failed image loads.
- The 1280x720 reference viewport matched the runtime contract: a 1034x566 stage, 849x566 board, 246px activity rail, and no page overflow.
- Beginning a shared term kept the authoritative allocation controls available in the independently scrolling activity rail without shrinking or covering the board.

## Next implementation boundary

The authoritative campus board is now complete for the first multiplayer slice. The next implementation boundary is:

1. Bring Briefing, Programs, Rivals, and Board Book into the multiplayer shell without exposing private state.
2. Add the staged headline/disruption and emergency-board presentation used by solo play.
3. Replace the fixed balanced founding plan with a synchronized pregame setup flow.
4. Exercise elimination, human-owned pending decisions, annual reports, final results, and reconnects across a complete browser-played game.

The owner dashboard and copy-only card editor remain later Phase 3 slices. New card modifier types and continuous dollar-allocation budgeting remain separate mechanics work because either requires a complete engine/content contract and rebalance pass.

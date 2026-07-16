# RESOLUTION ORDER SPECIFICATION
### Safety School — Deterministic Engine Spec v1.2

This document defines the **exact, deterministic order of operations** for the game engine. Given the same seed, same player actions, and same `balance-config.json`, two runs of the engine MUST produce byte-identical game states. This property is mandatory — it is what makes the Phase 1 Monte Carlo harness, replays, and async multiplayer reconciliation possible.

**Rule of interpretation:** if this document and the design doc disagree, this document wins. If this document and `balance-config.json` disagree on a *number*, the config wins.

---

## 0. Foundations

### 0.1 Numeric rules
- **Money:** decimal $M. All intermediate math at full float precision; round to 2 decimal places (banker's rounding) only when writing to persisted state.
- **Students / Alumni / Applicants / Pull:** integers. Apply `floor()` after any multiplication or scaling, at the moment the value is written to state (never mid-formula).
- **Reputation:** integer, clamp to [0, 100] immediately after every modification.
- **Percent rates (yield, retention, graduation):** decimals at full precision; never rounded.

### 0.2 RNG discipline
- One seeded PRNG stream per game (mulberry32 or PCG32; pick one, never change it mid-project).
- The stream is consumed **only** at the call sites enumerated in this document, **in the exact order listed**, with per-player events resolved in **seat order** (seat order = join order, fixed for the whole game).
- Eliminated players consume **no** RNG draws. (This means a game's RNG tape depends on elimination history — that is fine and expected; determinism is per-(seed, action-history), not per-seed alone.)
- Card decks are shuffled with Fisher–Yates at game start (and on reshuffle), consuming one draw per swap. Shuffle order at game start: Fortune deck, Crisis deck, Headline deck, Annual Disruption deck.
- **UI may never consume game RNG.** Cosmetic randomness uses a separate, unseeded stream.

### 0.3 Priority token
A **priority token** starts with seat 1 and rotates one seat clockwise at the start of every round. It breaks all ties that seat order would make unfair if fixed (currently: contested poach targets, §5.3; simultaneous race-Disruption claims, §7.4).

### 0.4 Action validation (at commit time)
- Max **2 actions** per player per round; each action type at most once per round except where noted.
- An action requiring spend is legal only if the player's treasury covers **the sum of all their committed spends this round**. Treasury may go negative from upkeep, crises, and headlines — never from voluntary actions.
- Admissions upgrades are only committable in round 5 of a year.
- Upgrades are +1 level only; no level-skipping; max level 5.
- **Open Program** (if `programsEnabled`): legal only if the player has an unused program slot (`slotsByAcademicsLevel[currentAcademicsLevel]` minus programs held) and can afford `openCost`. Max one program opened per round. Programs can never be closed or sold — they are excluded from fire-sales, voluntary and forced.

---

## 1. Round Sequence (every round)

Steps execute in this order. Within any per-player step, iterate players in seat order.

### Step 1 — Round setup
1.1. Rotate priority token.
1.2. Increment round counter; derive `year` and `roundOfYear`.
1.3. Apply expiring effects cleanup (last round's headline ends; "next round" effects from prior round become active this round).

### Step 2 — Headline reveal 🎲
2.1. Draw the top card of the Headline deck (reshuffle first if empty — Fisher–Yates consumes RNG). The top-deck draw itself consumes no RNG. Its effects are active for this round only.
2.2. Broadcast to all players.

### Step 3 — Income
3.1. Tuition per player: `students × tuitionPerStudentPerRound`, modified by headline. (Alumni donations are annual — §2 of Year-End, not here.)
3.2. Upkeep per player: `Σ dept upkeep × dept cost multiplier`, then `× costDisease^(year−1)`, then `× (1 − adminL4Discount)` if applicable, then headline modifiers. Deduct.
3.3. Write net to treasury. **No austerity check yet** — players get their allocation phase to react (fire-sales are an allocation action).

### Step 4 — Allocation (simultaneous, untimed)
4.1. All surviving players commit up to 2 actions (upgrade / campaign / voluntary fire-sale / poach / bank). Validation per §0.4.
4.2. Phase advances when all surviving players have confirmed. No player sees another's commitments until Step 5.

### Step 5 — Action resolution
Resolve **by action type**, all players' actions of a type together, in this order:
5.1. **Voluntary fire-sales:** −1 level, +`buildCost delta × 0.4` treasury, no reputation penalty. (First, so recovered cash is available… it is not — spends were validated at commit against pre-sale treasury; sale proceeds cannot fund same-round actions. Proceeds land now anyway.)
5.2. **Upgrades:** deduct cost, +1 level. New level takes effect **immediately** (affects this round's recruiting, strain capacity, chance scaling).
5.3. **Program openings:** deduct `openCost`; program effects take effect **immediately** (this round's recruiting, capacity bonus, crisis-weight modifier). Slot legality was checked at commit against pre-round Academics level; an Academics upgrade resolved in 5.2 does **not** grant a same-round slot (slots are evaluated at commit time).
5.4. **Poaches:** for each poach in seat order: verify target still eligible (`yearLosses ≥ 300`); transfer `floor(target.yearLosses × 0.05)` students from nowhere (these are already-departed students; the target loses nothing further); deduct $3M. If two players poach the same target, both succeed independently. If a rule later makes poaches exclusive, priority token decides.
5.5. **Campaigns:** register `spend × 100` pull for Step 6. Deduct spend.
5.6. **Bank:** no-op.

### Step 6 — Recruiting resolution 🎲
Pull is computed in **classes**, because classes differ in yield and scaling exposure:
6.1. Per player, compute pull by class, each modified by headline where applicable:
  - **Admissions class:** `admissionsLevel × 150 × (reputation/50)`, plus `bonusConversionsPending × (no multiplier — bonus conversions are pre-multiplied)`.
  - **Campaign class:** `campaignPull × (reputation/50)`.
  - **Program class (per program held):** `pullPerRound × repMultiplier`, where repMultiplier is `reputation/50` by default, `(reputation/50)²` for Business, and `1.0` for programs with `subjectToReputationMultiplier: false` (Nursing).
6.2. Round allotment: `annualPool[year] / 5`, modified by headline.
6.3. **Scalable pull** = all classes except pull from programs with `subjectToPoolScaling: false` (Nursing — its pull is reserved off the top; subtract it from the allotment first, floored at an allotment of 0 for everyone else in the pathological case). If `Σ scalable pulls > remaining allotment`: scale every player's scalable pull by `remainingAllotment / Σ scalablePulls`.
6.4. Apportion each player's scaled pull back to classes proportional to pre-scale contribution.
6.5. Admissions-class conversions: `floor(pull × 0.9)`. Bonus conversions within it convert at 100%.
6.6. **[RNG #2 — one draw per player with an active campaign, seat order]** Campaign yield: `uniform(0.4, 0.8)`, floored at `0.4 + admissionsLevel × 0.05`. Conversions: `floor(campaignPull × yield)`.
6.7. Program-class conversions: `floor(pull × programYield)` per program (default 0.9; Nursing 1.0).
6.8. Add all conversions to students.

### Step 7 — Athletics Season (round 3 only) 🎲
7.1. **[RNG #3 — one draw per player with Athletics activated, seat order]** Roll season vs. odds table for their level.
7.2. Apply the configured money/reputation payout immediately. Great Season: queue the configured `bonusConversionsNextRound`. Losing Season: queue one **extra Crisis draw targeted at Athletics** for Step 8 (severity rolled normally).

### Step 8 — Chance phase 🎲
Per player, in seat order, fully resolving each player before the next:
8.1. Fortune: draw the top card without RNG → **[RNG]** consume one target value even when the card names a fixed department → apply `benefit = base × (targetLevel + 1) / 3`. Apply any `bonusConversionsThisRound` immediately to students, outside pool scaling, before Step 9.
8.2. Crisis: draw the top card without RNG → **[RNG]** consume one target value even when the card names a fixed department. Target weights are uniform across the six departments **modified by the player's held-program `crisisTargetWeightModifiers`** (Arts & Sciences doubles the academics weight for that player's crisis draws — still one RNG draw, mapped over a 7-slice wheel instead of 6). Apply Admin L2 severity reduction (min severity 1). If player has an unused Admin L5 cancel this year, engine pauses for their cancel/keep decision (AI policy in sim). If kept: `damage = base × (6 − targetLevel) / 5`.
8.3. Extra Athletics crisis from a Losing Season resolves after the normal crisis, same rules, target fixed to Athletics.
Fortune-before-Crisis is guaranteed per player: a windfall can absorb a same-round blow.

### Step 9 — Strain check
9.1. Capacity = `academicsLevel × 1500 + Σ heldProgram.academicsCapacityBonus`. If `students > capacity`: reputation −2; add 0.006 to this year's accumulated retention penalty.

### Step 10 — Austerity & elimination check
10.1. For each player with treasury < 0, in seat order: forced fire-sale loop — player chooses a department level to sell (−1 level, +40% of that level's build-cost delta, reputation −3), repeating until treasury ≥ 0 or all departments are at level 1. (Sim AI policy: sell cheapest-upkeep-per-dollar-recovered first, protect archetype-core departments last.)
10.2. Eliminate any player who is (a) still insolvent with everything at level 1, or (b) below 1,000 students. Simultaneous eliminations all occur.
10.3. On elimination: run inheritance — `floor(students × 0.5)` distributed to survivors proportional to reputation share (floor each share; remainder students are lost); the other 50% leave the region.
10.4. If exactly one player survives: **game over, they win.** If zero survive (mutual destruction this round): winner = highest Institutional Health Score among this round's casualties.

### Step 11 — Standings publication
11.1. Publish: exact students, exact reputation, treasury **band** (Broke <$5M / Tight $5–15M / Stable $15–35M / Flush >$35M), department levels, alumni. Exact treasury is private (a Data Breach crisis can expose it).
11.2. This is the public pre-year-end standings event. Full persistence is deferred until all applicable year-end work completes.

---

## 2. Year-End Sequence (round 5 only, after Step 11)

Y1. **Graduation** (per player, seat order): `seniors = floor(students × 0.25)`; `grads = floor(seniors × (0.35 + 0.08 × academicsLevel))`. Students −grads; Alumni +grads.
Y2. **Attrition:** `retention = clamp(studentAffairs.retentionBase + studentAffairs.retentionPerLevel × studentAffairsLevel + Σ heldProgram.annualRetentionBonus, …, studentAffairs.retentionCap) − accumulatedStrainPenalty − any card/disruption penalties`. Students = `floor(students × retention)`. Reset strain accumulator. (The configured cap applies before penalties; Education can help reach it, never exceed it.)
Y3. **Donations & grants:** treasury += `alumni × (0.001 × academicsLevel + Σ heldProgram.donationPerAlumBonusPerYear)`; treasury += `Σ heldProgram.annualStateGrantPerAdminLevel × administrationLevel`.
Y4. **Annual Disruption resolves:** the Disruption revealed one year ago takes effect for the **coming** year (its modifiers are attached to year+1's state).
Y5. **Reveals:** if not yet drawn, draw year+2's Disruption from the top without consuming RNG. Publicly reveal year+1's Disruption to all; privately reveal year+2's to Admin L3+ players only.
Y6. **Demographic cliff tick:** load `annualPool[year+1]`.
Y7. **Safety net:** identify the lowest-treasury survivor; if treasury is below `safetyNet.treasuryThreshold` and their appropriation is unused, add `safetyNet.amount` and mark it used.
Y8. **Post-year-end elimination re-check:** attrition/graduation can drop a player below 1,000 students — rerun Step 10.2–10.4 logic.
Y9. **Year 6 check:** if the year just ended is Year 6 and 2+ players survive: compute Institutional Health Score = `treasury/10 + students/100 + reputation + Σ(deptLevels)×5 + alumni/500`; highest wins; exact tie broken by (students, then alumni, then priority token proximity).
Y10. Reset per-year flags (Admin L5 cancel, athletics season, safety-net eligibility recheck).

### Step 12 — Complete round persistence
After Y10 on round 5, or immediately after Step 11 on all other rounds, persist the full state and RNG cursor. This post-transaction snapshot is the replay/audit unit.

---

## 3. Complete RNG call-site index (audit checklist)

| # | Site | When | Draws |
|---|---|---|---|
| G1 | Deck shuffles | Game start / reshuffle | Fisher–Yates per deck, fixed deck order |
| R1 | Headline reshuffle | Step 2, only when empty | Fisher–Yates swaps; top-card draw consumes 0 |
| R2 | Campaign yields | Step 6.6 | 1 per campaigning player, seat order |
| R3 | Athletics seasons | Step 7 (round 3) | 1 per activated player, seat order |
| R4 | Fortune target | Step 8.1 | 1 per player, seat order; top-card draw consumes 0 |
| R5 | Crisis target | Step 8.2 | 1 per player, seat order; top-card draw consumes 0 |
| R6 | Extra Athletics crisis target | Step 8.3 | 1 per triggered player; top-card draw consumes 0 |
| Y5 | Disruption draw | Year-end | 0; draw from the shuffled top |

Nothing else may touch the game PRNG. Any new mechanic that needs randomness must be added to this table in a versioned change.

---

## 4. Edge cases (bind these in tests)

1. **Pool scaling with zero total pull:** skip Step 6.3–6.7 (division guard).
2. **Player confirms zero actions:** treated as Bank.
3. **Crisis targets a department mid-fire-sale-spiral:** levels are read at resolution time (Step 8), after Step 5 sales — a department sold this round is hit at its *new* level.
4. **Elimination during Step 10 with a pending Admin L5 decision elsewhere:** chance phase (Step 8) fully completes for all players before Step 10 begins; no interleaving.
5. **Reshuffle timing:** a deck reshuffles at the moment a draw finds it empty, not at end of round.
6. **Headline modifying a phase that already passed:** impossible by construction — headlines resolve first and list which steps they touch; a headline card may only reference Steps 3–9 of its own round.
7. **Negative reputation math:** clamp at 0; pull multiplier bottoms out at 0 (a 0-rep university recruits nobody — by design, this is near-terminal).
8. **Two players eliminated, inheritance ordering:** compute all eliminations first, then run inheritance once, distributing to the surviving set only (casualties never inherit from each other).
9. **Year 6 tiebreak with a player eliminated in the final year-end:** eliminated players are not scored; only survivors compete on Health Score.
10. **Admin L3 achieved mid-year:** foresight grants at the next Y5 reveal; no retroactive peek.
11. **Academics fire-sold below a program-slot threshold:** already-open programs are grandfathered — a player forced from Academics L3 to L2 keeps both programs but cannot open new ones until slots recover. Program upkeep continues (the tenure committee sends its regards).
12. **Programs and the Health Score:** each held program counts as +1 toward `Σ departmentLevels` in the Year 6 tiebreak formula.
13. **`programsEnabled: false`:** the openProgram action is invalid at commit; all program-tagged card riders are no-ops; nothing else changes. Both branches must pass the determinism suite.

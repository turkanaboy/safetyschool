# SAFETY SCHOOL
### A competitive university management board game for the web
**Design Document v1.1 — Game Design Scope**

> **v1.2 changelog:** Added the Program Portfolio (§3.7) — six openable academic programs, gated by Academics level, feature-flagged for A/B simulation. Card deck targets raised for replayability (36 Fortune / 36 Crisis / 12 Disruptions / 36 Headlines).
> **v1.1 changelog:** All open questions resolved (§12). Added the Higher Ed Headlines shared modifier (§6.5). Allocation phase is now untimed casual. Tone locked as satirical. Numeric constants in this document are now *illustrative* — the authoritative values live in `balance-config.json`, and Phase 1 of the build plan validates them via headless simulation.

---

## 1. Concept & Design Pillars

**Elevator pitch:** 2–5 players each inherit the shell of a struggling university in the same shrinking region. Build departments, fight for a dwindling pool of applicants, survive crises, and outlast your rivals. SimCity's resource management meets Monopoly's elimination tension — compressed into a 60–90 minute session.

**Design pillars (every mechanic must serve at least one):**

1. **Strategy over luck (70/30).** Randomness exists, but its *magnitude* is always shaped by player decisions. A well-run department shrugs off crises and amplifies windfalls. Luck determines *what* happens; strategy determines *how much it matters*.
2. **The funnel is the game.** Applicants → Enrolled → Retained → Graduated → Alumni Donors. Every department touches one stage of the pipeline. No department is optional forever; every department can be neglected temporarily.
3. **Guaranteed ending.** A shrinking shared applicant pool ("the demographic cliff") and rising costs mathematically force the game to a conclusion by Year 6. No infinite stalemates.
4. **Ups and downs by design.** Fortune/Crisis card pairs each round, annual disruption events, and the Athletics gamble create swings — but always with mitigation paths so a downswing feels like a challenge, not a coin flip.
5. **Interactive, not solitaire.** Players compete directly for the same applicant pool, can poach students from wounded rivals, and race for first-mover advantages on annual events.

---

## 2. Core Resources

| Resource | What it is | How you get it | How you lose it |
|---|---|---|---|
| **Treasury ($M)** | Cash on hand | Tuition, donations, grants, windfalls | Upkeep, builds, crises |
| **Students** | Current enrollment | Recruiting each round | Attrition, graduation, crises, poaching |
| **Reputation (0–100)** | Recruiting power multiplier & crisis buffer | Strong seasons, graduations, fortune cards | Scandals, strain, crises |
| **Alumni** | Permanent donor base | Graduating students | Never lost (your one compounding asset) |

**The money loop:** Students pay tuition every round. Alumni donate every year. Everything else is expense. Treasury going negative starts the death spiral (see §8).

---

## 3. The Six Departments ("Classes")

Every department is an object with the same interface: `level (1–5)`, `upkeep`, `buildCost`, `passiveEffect`, `crisisResistance`, `fortuneAmplification`. Personality comes from the stat spread.

### Shared cost curve
| Level | Build cost (cumulative) | Upkeep per round |
|---|---|---|
| 1 | free (start) | $1M |
| 2 | $8M | $2M |
| 3 | $18M | $4M |
| 4 | $32M | $7M |
| 5 | $50M | $11M |

*(Athletics pays 150% of this curve. Administration pays 75%.)*

### 3.1 Admissions — *The Tortoise*
- **Effect:** Recruits **150 × level** applicant-conversions per round from the shared pool, at a stable ~90% yield. Low variance.
- **Profile:** Cheap, slow, reliable. The backbone. Build constraint: can only be upgraded at end of academic year (it "takes the longest to build" — staff, territory management, and pipelines take time).
- **Weakness:** Linear scaling. Can never produce a spike. If the pool shrinks, Admissions' pull shrinks proportionally.

### 3.2 Marketing — *The Firehose*
- **Effect:** Active ability: **Campaign** — spend $2M–$10M in a round; generate applicant interest worth **2.5× spend** in pool-draw power, but yield on those applicants is volatile: roll 40–80%.
- **Profile:** Instant, expensive, unreliable conversion. The only department that produces enrollment *this round*.
- **Synergy:** Yield floor rises +5% per Admissions level (a good funnel converts hype). This is the core Marketing/Admissions dance.
- **Weakness:** Zero passive effect. A Level 5 Marketing department doing nothing is just a $16.5M/round bonfire. Level only raises the campaign spend cap and the yield floor.

### 3.3 Academics — *The Engine (and the Fuse)*
- **Effect:** Sets **graduation rate: 35% + 8% per level** (of eligible seniors at year end). Sets **donation per alum: $1,000 × level** per year.
- **Strain mechanic:** Academics supports **1,500 students per level**. Every round you're over capacity: −2 Reputation and −3% annual retention. Over-enrollment is a real failure mode, not just flavor.
- **Profile:** Expensive, essential, and the department that punishes greed. Growth-rushing players who neglect it enter a reputation spiral.
- **Payoff horizon:** Slow — graduates become alumni, alumni compound donations. The late-game win condition lives here.

### 3.4 Student Affairs — *The Sealant*
- **Effect:** Sets **annual retention: 72% + 4% per level** (max 92%).
- **Profile:** Does nothing visible for four rounds, then saves you a fortune at year end. Every retained student is a student you didn't pay Marketing to replace — and as the pool shrinks, retention becomes the cheapest "recruiting" in the game.
- **Weakness:** No enrollment, no graduation boost, no donor effect. Pure defense. Easy to undervalue early — deliberately designed so Year 1 skeptics regret it by Year 4.

### 3.5 Athletics — *The Casino*
- **Effect:** Once per year (round 3 of each year), the **Season** resolves:

| Level | Great season | Good season | Losing season |
|---|---|---|---|
| 1 | 10% | 40% | 50% |
| 2 | 15% | 45% | 40% |
| 3 | 25% | 45% | 30% |
| 4 | 35% | 45% | 20% |
| 5 | 45% | 45% | 10% |

- **Great:** +$8M donor windfall, +8 Reputation, +400 bonus applicant-conversions next round (the "Flutie Effect").
- **Good:** +$2M, +2 Reputation.
- **Losing:** −$3M (empty stadium), −3 Reputation, and draw an extra Crisis card targeted at Athletics (injury, scandal, coach buyout).
- **Profile:** 150% cost curve, high ceiling, real downside. The variance engine of the game — but note the player *chooses* their exposure. Not investing in Athletics is always legal.

### 3.6 Administration — *The Oracle*
- **Effect by tier (75% cost curve):**
  - **L1:** Nothing. (Every university has one. It mostly sends emails.)
  - **L2 — Risk Office:** All Crisis cards hit you at one severity step lower.
  - **L3 — Institutional Research:** You privately see **next year's Annual Disruption one full year early** (everyone else sees it during the final round of the current year). Two full years of prep vs. everyone's one.
  - **L4 — Efficiency Consultants:** −15% total upkeep across all departments.
  - **L5 — The Fixer:** Once per academic year, cancel any one Crisis card outright (yours) after seeing it.
- **Profile:** No pipeline effect whatsoever. Pure information, mitigation, and efficiency. The strategy-player's department — Administration is how you convert the "chance" part of the game back into "strategy."

### 3.7 The Program Portfolio (v1.2)

Programs are **one-time investments** — an opening cost plus flat upkeep, no levels, no upgrade decisions. They reshape your existing numbers rather than adding a parallel subsystem, which is what keeps them board-game-weight: one new action type, zero new phases, zero new dice.

**Slots are gated by Academics** (this gives Academics a mid-game identity beyond graduation rates): Academics L1 = 1 slot, L3 = 2 slots, L5 = 3 slots. Six programs compete for at most three slots — the portfolio choice is the point. Opening a program uses a normal action slot; programs cannot be closed (that endowment is *restricted*, sorry).

**Default rules:** program pull joins your recruiting pull, converts at 90% yield, is subject to pool scaling and the reputation multiplier — *except where a program's shape says otherwise.* The exceptions are the personalities:

| Program | Open / upkeep | Shape |
|---|---|---|
| **Nursing** | $12M / $2M | +120 pull/round. **Immune to the rep multiplier AND pool scaling; 100% yield.** Expensive, low, utterly consistent — the recession-proof floor. The only recruiting in the game the demographic cliff cannot touch. |
| **Business** | $8M / $1.5M | +150 pull/round **× (rep/50)²**. At 70 rep ≈ 294; at 35 rep ≈ 74. Highest ceiling in the game, and it craters exactly when you're already hurting. Its volatility is deterministic — your reputation graph *is* the dice. |
| **Arts & Sciences** | $7M / $1M | +100 pull/round and **+1,500 Academics capacity** (the big tent) — but Academics' weight in your crisis targeting doubles (the faculty are... spirited). |
| **Engineering** | $15M / $2.5M | +80 pull/round and **+$500 donation per alum per year** (STEM alumni earn more). The steepest opening cost, the strongest compounding late game. |
| **Education** | $5M / $1M | +60 pull/round and **+2% annual retention** (education students stay). Cheap glue for the Fortress build. |
| **Public Affairs** | $6M / $1M | +40 pull/round and an annual **state grant of $0.5M × your Administration level** (state relations pay). The Oracle archetype's missing income source. |

**Targeting note:** programs are never targets of per-round Fortune/Crisis cards (departments remain the six targets), but Disruptions and some cards carry **program tags** — conditional riders like *"National Nursing Shortage: players with Nursing +200 pull this year."* Programs are content, not code: each is a stat-modifier bundle in `balance-config.json`.

**Feature flag:** `programsEnabled` in the config. Phase 1's Monte Carlo runs the full suite both ways; if programs distort archetype win rates outside the acceptance band, pulling them is a flag flip, not surgery.

---

## 4. Round Structure (one round ≈ 2–3 minutes, simultaneous play)

Each round is one "term." Five rounds = one academic year. All players act simultaneously in phases; the server resolves.

**Phase 0 — Headline.** One shared **Higher Ed Headline** (§6.5) is revealed and applies identically to all players for this round only. Revealed *before* allocation so players can react to it.

**Phase 1 — Income.** Collect tuition: **$2,000 × current students** (i.e., 5,000 students = $10M), modified by any active headline. Pay all upkeep automatically. Display net.

**Phase 2 — Allocation (the decision phase, untimed — all players confirm to advance).**
Choose up to **two actions**:
- Upgrade a department (pay build cost; Admissions only upgradeable in round 5)
- Run a Marketing Campaign
- **Reallocate:** demolish a department level, recover 40% of its build cost (the fire-sale — painful by design)
- **Poach:** if any rival lost 300+ students this year, spend $3M to transfer-recruit 5% of their losses
- Bank (do nothing, hold cash — a real strategy heading into a known bad year)

**Phase 3 — Chance.** Draw **one Fortune and one Crisis**, each targeting a random department (see §6). Resolve Fortune first (a good round can pay for a bad card).

**Phase 4 — Standings.** Public dashboard update: every player's students, reputation, and *approximate* treasury band (exact cash is hidden — you can see who looks wounded, not their exact wallet).

**Round 3 of each year:** Athletics Season resolves for anyone with Athletics ≥ L1 activated.
**Round 5 of each year:** Year-End (see §5).

---

## 5. The Academic Year & Annual Disruptions

### Year-End sequence (round 5, after normal phases):
1. **Graduation:** Graduation-rate % of your senior cohort (modeled simply: ¼ of student body is "seniors") graduates → they leave enrollment and join **Alumni** permanently.
2. **Attrition:** Retention % applied to remaining students. The rest leave.
3. **Donations:** Alumni × donation-per-alum pays out.
4. **Annual Disruption resolves** (the one revealed a year ago — its effects apply to the coming year).
5. **Next year's Disruption is revealed publicly.** (Admin L3 players already knew.)
6. **Demographic cliff ticks** (see §8).
7. **Safety-net check:** the player with the lowest treasury (if below $10M) receives a one-time **$5M State Emergency Appropriation** — once per player per game. Softens death spirals without removing them.

### Annual Disruption examples (affects ALL universities; prep is the game):
| Disruption | Effect for the year | How you prep |
|---|---|---|
| **Demographic Acceleration** | Applicant pool −25% extra this year | Student Affairs (retain instead of recruit) |
| **State Funding Cut** | All upkeep +20% | Admin L4, bank cash, fire-sale bloat |
| **Rankings Methodology Change** | Reputation counts double in pool-draw | Pump Reputation the year before |
| **Financial Aid System Meltdown** | All yields −20%; Marketing campaigns capped at $4M | Admissions (stable yield floor) |
| **Conference Realignment** | Athletics seasons: Great payouts double, Losing losses double | Go big or divest before it hits |
| **Accreditation Review Year** | Any university over Academics capacity loses 10 Reputation instantly | Fix your ratios in advance |
| **Viral Campus Moment** | First player to reach 65+ Reputation this year gets +600 applicants | Race dynamic — first-mover only |

Two years of visible horizon (one for Admin L3 players... two) means every disruption is a strategy puzzle, not a gotcha. This is the single biggest strategy-over-chance lever in the design.

---

## 6. Chance Cards: Fortune & Crisis

Every round, every player draws one of each. Each card names a **target department** (weighted random) and a **base magnitude** (severity 1–3). Then the scaling rule — the heart of your original idea — kicks in:

> **Crisis damage = base × (6 − target level) / 5**
> **Fortune benefit = base × (target level + 1) / 3**

A Level 5 department takes 20% crisis damage and reaps 200% fortune value. A Level 1 department takes full damage and gets scraps. **Investment is armor and amplifier simultaneously.** This is what makes the chance system feel fair: cards reward the board state you built.

### Sample Fortune cards
| Card | Target | Base effect (severity 2) |
|---|---|---|
| Star Faculty Hire | Academics | +$3M grant, +3 Rep |
| Admissions Rep Goes Viral | Admissions | +200 bonus conversions this round |
| Booster Whale | Athletics | +$5M donation |
| Retention Program Featured Nationally | Student Affairs | +4 Rep, +2% retention this year |
| Campaign Goes Viral | Marketing | Next campaign yield locked at 80% |
| Clean Audit | Administration | Refund 50% of this round's upkeep |

### Sample Crisis cards
| Card | Target | Base effect (severity 2) |
|---|---|---|
| Accreditation Warning | Academics | −4 Rep, −$2M compliance costs |
| Yield Miss | Admissions | This round's conversions −50% |
| Hazing Scandal | Athletics | −5 Rep, −$3M |
| Housing Mold Outbreak | Student Affairs | −3% retention this year, −$2M |
| Ad Buy Backfires | Marketing | Lose $2M, no campaign next round |
| Data Breach | Administration | −$3M, standings show your exact treasury for 2 rounds |

Deck construction: **36 Fortune, 36 Crisis** (raised in v1.2 for replayability and program-tagged content), severity distribution 40/40/20 (sev 1/2/3). Severity 3 cards are rare and dramatic; Admin L2 turns a sev-3 into a sev-2, and Admin L5 deletes one per year.

### 6.5 Higher Ed Headlines (shared per-round modifier)

One Headline is drawn at the start of every round and applies **identically to all surviving players** for that round only. Because it is perfectly symmetric, it adds texture, shared fate, and a satirical voice every round without adding asymmetric luck — the per-player Fortune/Crisis pair remains the only unequal randomness in the game, protecting the 70/30 strategy pillar.

**Magnitude cap:** no Headline may exceed roughly half the impact of a severity-1 card.

Examples:
| Headline | Effect this round |
|---|---|
| *"Tuition Discount War Escalates"* | All tuition income −5% |
| *"Gen Z Suddenly Loves College Again"* | Pool allotment +10% |
| *"Statewide Ransomware Wave"* | All Administration upkeep doubled |
| *"Viral 'Day in My Life' TikTok Trend"* | All Marketing campaign pull +15% |
| *"National Coaching Carousel"* | Athletics upkeep +$1M for everyone |
| *"Slow News Week"* | No effect. Everyone exhales. |

~30 Headlines including a healthy share of no-ops and near-no-ops; the deck should feel like ambient weather, not a second crisis system.

---

## 7. Player Interaction (why this isn't multiplayer solitaire)

1. **The Shared Pool (primary).** All recruiting draws from one regional applicant pool. Each round, players' total *pull* (Admissions passive + active campaigns, multiplied by Reputation/50) is computed; if combined pull exceeds the pool's round allotment, everyone is scaled down proportionally. Your rival's Marketing blitz literally shrinks your Admissions haul. Overbidding into a small pool wastes money — reading opponents matters.
2. **Poaching.** Wounded universities bleed transfers (§4 Phase 2). Kicking rivals while they're down accelerates eliminations and endgame.
3. **Hidden treasury, public suffering.** Everyone sees enrollment and reputation; cash is a band estimate. Bluffing solvency is viable.
4. **Race disruptions.** Some annual events reward only the first mover.
5. **Elimination inheritance.** When a university folds, its current students disperse: 50% distributed to surviving schools proportional to Reputation, 50% leave the region (the pool does not grow — collapse hurts the ecosystem). Feeding on a dying rival is real but not a full windfall.

---

## 8. Pacing, Elimination & the Guaranteed Ending

### The Demographic Cliff (the game's clock)
- Regional applicant pool: **Year 1: 30,000 → Year 2: 28,000 → Year 3: 25,000 → Year 4: 21,000 → Year 5: 17,000 → Year 6: 13,000.**
- Meanwhile **cost disease**: all upkeep +5% per academic year, compounding.
- Result: the math *cannot* sustain 4–5 mid-sized universities by Year 5. Someone must fail. The board tightens itself; no player action can stall the game indefinitely.

### The Death Spiral (deliberate, escapable, dramatic)
1. Treasury goes negative → **Austerity**: forced fire-sale of department levels at 40% until solvent. Each forced sale: −3 Reputation.
2. Reputation drop shrinks pool-pull → fewer students → less tuition → more austerity.
3. **Elimination:** you fold if (a) you're still insolvent after fire-selling everything above Level 1, or (b) enrollment drops below 1,000.
4. **Escape hatches:** the one-time State Appropriation (§5), alumni donations (your compounding lifeboat — this is why Academics investment early saves lives late), and poach-proofing via Student Affairs. Comebacks should happen in ~1 of 4 games: rare enough to fear the spiral, common enough to keep fighting.

### Game length math
- 6 academic years × 5 rounds = **30 rounds max**.
- Simultaneous untimed allocation (casual mode) with fast server resolution ≈ 2–3 min/round in practice → **~60–90 minute typical session**, shortening as eliminations reduce decision load. A timed competitive mode can be layered on later without engine changes.
- **Win conditions:** (1) sole surviving university at any point, OR (2) if 2+ survive to end of Year 6: highest **Institutional Health Score = Treasury($M)/10 + Students/100 + Reputation + (Σ department levels × 5) + Alumni/500.** The score formula means a Year 6 finish is still a real contest, not a formality — a cash-poor prestige school can beat a bloated enrollment mill.

---

## 9. Starting State & First-Turn Feel

Each player starts identically:
- **Treasury: $50M | Students: 5,000 | Reputation: 50 | Alumni: 2,000 (donating $1k each at Academics L1)**
- All six departments at Level 1.
- **Plus 3 free upgrade levels to distribute at setup** (max 2 in one department). This is the "reallocate as you see fit to start" moment — your opening build is your identity declaration, visible to all players before Round 1.

Baseline Round 1 economics: $10M tuition in, ~$6M upkeep out → ~$4M/round surplus. Enough to feel rich for exactly one year — Year 2's cost disease and the first Disruption end the honeymoon.

---

## 10. Strategy Archetypes (proof the strategy space is real)

| Archetype | Build | Wins by | Dies to |
|---|---|---|---|
| **The Steady Hand** | Admissions 4 / Student Affairs 3 | Outlasting; needs the fewest new students per year | Rankings-based disruptions; being boring while rivals spike |
| **The Gambler** | Athletics 4 / Marketing 3 | Two Great Seasons back-to-back = insurmountable Rep + cash | One bad season into a Crisis card in Year 2 |
| **The Prestige Play** | Academics 4 / Admin 2 | Alumni compounding — by Year 5, donations rival tuition | Cash crunch in Years 1–2 before alumni scale |
| **The Fortress** | Student Affairs 4 / Academics 3 | Demographic cliff barely touches them | Being out-recruited early and never catching up in raw size |
| **The Oracle** | Admin 4 / balanced elsewhere | Perfect information + crisis immunity; never surprised | Lower ceiling everywhere; loses the score tiebreak if the game goes the distance |

If playtesting shows any archetype winning >35% or <10% of games, tune the numbers in §3/§8 — the levers are all in the tables.

---

## 11. Digital Implementation Notes (MVP scope)

- **Architecture fit:** turn-based simultaneous resolution is ideal for a Supabase backend — one `games` table, one `game_state` JSONB snapshot per round, realtime channel for phase transitions. No tick loop, no websocket game server needed. Vanilla JS/canvas or lightweight framework front end — well within your existing stack.
- **MVP cut (playable prototype):** 2–4 players, all six departments, Fortune/Crisis decks at 12 cards each, 4 fixed Annual Disruptions, no poaching, no hidden treasury (show everything). Add bluffing/poaching/full decks in v2.
- **Solo mode later:** 2–3 AI universities with archetype scripts (§10 is literally the AI design doc) makes this playable day one without a lobby.
- **Balance harness:** because resolution is deterministic given the RNG seed, you can Monte Carlo thousands of games headlessly to validate the Year 5–6 elimination pressure and archetype win rates before any human playtests.

---

## 12. Resolved Design Decisions (v1.1)

1. **Chance draws:** per-player Fortune/Crisis each round; Annual Disruptions remain all-player. A new shared **Higher Ed Headline** (§6.5) fires every round as a low-magnitude, perfectly symmetric all-player modifier.
2. **Poaching:** in. Exactly mean enough.
3. **Admin L3 foresight:** secret. The server reveals Year N+2's Disruption only to qualifying players; other players may infer it from behavior — that inference game is a feature, not a leak.
4. **Timer:** untimed casual mode at launch. Phase advances when all players confirm. Engine designed so a timed mode is a config flag, not a refactor.
5. **Tone:** satirical. Flavor text leans into the genre's abundant source material; mechanics text stays clean and unambiguous. Satire lives on the card, never in the rules.

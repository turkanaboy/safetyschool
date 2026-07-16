# Safety School Phase 1 Balance Report

**Overall:** PASS

## Evidence identity

- Schedule: `94767dd2d76ae019a19172ce2b32084a84f57a84adc9a7363a246774d85e1c86`
- Schedule method: complete 24-game cycles; 6 cyclic agent offsets at each of 2, 3, 4, 5 players; identical lineup and seat exposure in both program branches.
- Replay sample: first complete cycle per branch.
- Engine: 0.2.0 (state schema 2; replay schema 2)
- Config: 1.21.0 (`45df9be6af3b477f98724c3659a7511de9c390e64db7b8d516f83474714fadc0`)
- Cards: 1.3.0 (`d81fca95f5b8c7ac9bc32281cb922f4f4fd3111aae523fdf884830e68c8fda53`)
- Agent policy: 2.0.0 (`0175d86befbe75525f132794baff42abbf4e2a659aa20f2baec341740a9573e7`)
- Base seed: 20260715

## Branch results

### Programs disabled — PASS

| Metric | Value |
|---|---:|
| Games | 10008 |
| Median ending round | 28 |
| Ended before configured early-round cutoff | 4.64% |
| Reached Year 6 Health Score | 31.33% |
| Austerity escape rate | 29.45% |
| Replay identity | 100.00% |
| Maximum observed round | 30 |

Winner shares:

- steadyHand: 25.74%
- gambler: 17.76%
- prestigePlay: 15.21%
- fortress: 15.58%
- oracle: 19.83%
- random: 5.89%

Acceptance checks:

- All configured checks passed.

### Programs enabled — PASS

| Metric | Value |
|---|---:|
| Games | 10008 |
| Median ending round | 28 |
| Ended before configured early-round cutoff | 6.76% |
| Reached Year 6 Health Score | 31.83% |
| Austerity escape rate | 27.02% |
| Replay identity | 100.00% |
| Maximum observed round | 30 |

Winner shares:

- steadyHand: 21.61%
- gambler: 17.68%
- prestigePlay: 18.01%
- fortress: 20.01%
- oracle: 16.67%
- random: 6.03%

Winning portfolio shares:

- artsAndSciences: 28.97%
- business: 19.83%
- education: 25.91%
- engineering: 19.19%
- nursing: 22.09%
- publicAffairs: 17.76%

Acceptance checks:

- All configured checks passed.

## Denominators

- Programs disabled: 10008 games; 30475 austerity entrants; 24 replays.
- Programs enabled: 10008 games; 29459 austerity entrants; 24 replays.

## Config tuning

- Reduced annual upkeep cost disease from 1.05 to 1.03 and raised the State Emergency Appropriation from 5 to 8.
- Reshaped Student Affairs retention from 0.72 + 0.04/level (0.92 cap) to 0.678 + 0.077/level (0.945 cap), increasing differentiation between department levels.
- Reduced the Athletics cost multiplier from 1.5 to 1.1; improved levels 3-5 season odds; raised great seasons from 8 money / 8 reputation / 400 conversions to 14 / 12 / 1,800 and good seasons from 2 / 2 to 3 / 3.
- Reduced Nursing upkeep from 2 to 1.75 and kept Arts & Sciences, Education, and Public Affairs at their original 1 upkeep.
- Reduced Business open cost from 8 to 5 and upkeep from 1.5 to 1.25; raised pull from 150 to 210.
- Reduced Engineering open cost from 15 to 10 and upkeep from 2.5 to 1.5; raised pull from 80 to 135 and annual donation bonus from 0.0005 to 0.0006 per alumnus.

## Human playtesting caveat

Human playtesting is still required for fun, pacing, comprehension, and whether the satire lands. This report proves deterministic execution and configured statistical targets only.

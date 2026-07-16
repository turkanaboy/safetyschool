# Safety School Phase 1 Balance Report

**Overall:** PASS

## Evidence identity

- Schedule: `b4a6489170bdbb732ef7880b8584011f3d1a6a8d7c40ff7d936f924b710457c0`
- Config: 1.8.0 (`d9b4653782cf8b4ff8c9b41374a4f1430b9dbbc6e30c13a9834141238e671d17`)
- Cards: 1.3.0 (`d81fca95f5b8c7ac9bc32281cb922f4f4fd3111aae523fdf884830e68c8fda53`)
- Agent policy: 1.5.0 (`16c3c6a5db7f730f196a241791ed97e2fe6091f72d9e592cdee807595840fce7`)
- Base seed: 20260715

## Branch results

### Programs disabled — PASS

| Metric | Value |
|---|---:|
| Games | 10008 |
| Median ending round | 28 |
| Ended before configured early-round cutoff | 4.10% |
| Reached Year 6 Health Score | 25.12% |
| Austerity escape rate | 25.48% |
| Replay identity | 100.00% |
| Maximum observed round | 30 |

Winner shares:

- steadyHand: 18.09%
- gambler: 24.35%
- prestigePlay: 19.98%
- fortress: 16.03%
- oracle: 19.27%
- random: 2.28%

Acceptance checks:

- All configured checks passed.

### Programs enabled — PASS

| Metric | Value |
|---|---:|
| Games | 10008 |
| Median ending round | 28 |
| Ended before configured early-round cutoff | 5.91% |
| Reached Year 6 Health Score | 30.26% |
| Austerity escape rate | 23.61% |
| Replay identity | 100.00% |
| Maximum observed round | 30 |

Winner shares:

- steadyHand: 16.40%
- gambler: 24.30%
- prestigePlay: 15.86%
- fortress: 23.81%
- oracle: 17.41%
- random: 2.23%

Winning portfolio shares:

- artsAndSciences: 25.33%
- business: 24.88%
- education: 17.23%
- engineering: 13.02%
- nursing: 24.45%
- publicAffairs: 17.93%

Acceptance checks:

- All configured checks passed.

## Denominators

- Programs disabled: 10008 games; 30223 austerity entrants; 24 replays.
- Programs enabled: 10008 games; 28573 austerity entrants; 24 replays.

## Config tuning

- Reduced annual upkeep cost disease from 1.05 to 1.03 and raised the State Emergency Appropriation from 5 to 8.
- Raised Student Affairs retention from 0.72 + 0.04/level (0.92 cap) to 0.75 + 0.045/level (0.94 cap).
- Improved Athletics levels 3-5 odds and raised a great season from 8 money / 8 reputation / 400 next-round conversions to 12 / 10 / 500.
- Reduced all program upkeep; reduced Engineering open cost from 15 to 12 and raised its pull from 80 to 100.
- Reduced Business open cost from 8 to 6 and raised its pull from 150 to 175.

## Human playtesting caveat

Human playtesting is still required for fun, pacing, comprehension, and whether the satire lands. This report proves deterministic execution and configured statistical targets only.

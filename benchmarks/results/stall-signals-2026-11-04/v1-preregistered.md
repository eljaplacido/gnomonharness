# Stall-signal replay (LP5)

Module: `packages/gnomon-core/dist/stall_signals.js`. Tune: **r1h**. Held out: **m1**.
A priori: cycle_min_calls=6 no_progress_calls=8 cusum=k0.5/h4.
Tuned (128/448 grid points met fire_success <= 5% on r1h): **cycle_min_calls=6 no_progress_calls=20 cusum=k0.6/h3**.

## Inventory

| campaign | trails | with calls | scored | success | failed | stall_or_cap | bash stamped | bash target cut | builds |
|---|---|---|---|---|---|---|---|---|---|
| bud | 59 | 59 | 59 | 46 | 13 | 6 | 98% | 0% | gnomon/0.3.3+c3bcb99, gnomon/0.3.3+d59e6c1 |
| bud2 | 4 | 4 | 4 | 4 | 0 | 0 | 100% | 0% | gnomon/0.3.3+c3bcb99, gnomon/0.3.3+d59e6c1 |
| c2d | 0 |||||||||
| g1 | 0 |||||||||
| g1c | 0 |||||||||
| g1r | 0 |||||||||
| g2 | 0 |||||||||
| g2b | 0 |||||||||
| g2br | 0 |||||||||
| gvc | 0 |||||||||
| idx | 0 |||||||||
| lean | 100 | 100 | 99 | 80 | 19 | 6 | 98% | 0% | gnomon/0.3.2+68abc51, gnomon/0.3.2+eb56ab0 |
| m1 | 121 | 121 | 115 | 73 | 42 | 28 | 99% | 0% | gnomon/0.3.3+166a9d3, gnomon/0.3.3+d59e6c1 |
| m2 | 70 | 70 | 69 | 47 | 22 | 9 | 97% | 0% | gnomon/0.4.0+be4fc0d |
| p1h | 32 | 32 | 32 | 27 | 5 | 0 | 0% | 86% | gnomon/0.3.1+7012c5a |
| p2 | excluded: Harbor layout; campaign in progress |||||||||
| p2g | excluded: Harbor layout; campaign in progress |||||||||
| peers | 40 | 39 | 39 | 31 | 8 | 3 | 0% | 59% | gnomon/0.3.1+7012c5a |
| r1 | 87 | 87 | 87 | 65 | 22 | 10 | 93% | 0% | gnomon/0.3.3+d59e6c1 |
| r1h | 78 | 78 | 76 | 65 | 11 | 5 | 97% | 0% | gnomon/0.3.3+d59e6c1 |
| r2 | 0 |||||||||
| r3 | 0 |||||||||
| r3r | 4 | 4 | 4 | 4 | 0 | 0 | 99% | 0% | gnomon/0.4.0+be4fc0d |
| s1 | 47 | 47 | 47 | 30 | 17 | 9 | 99% | 0% | gnomon/0.3.3+8078df0 |
| ux1 | 0 |||||||||
| ux1w | 0 |||||||||
| ux2 | 0 |||||||||
| winp | 0 |||||||||

Nudge simulation vs recorded `first_nudge_step` (single-role runs where either fired): 281 compared, 238 exact, 264 within 3 steps, 0 recorded-only, 11 simulated-only.

## Tuned thresholds

| campaign | role | flag | recall stall/cap, lead >= 2 [95% CI] | fire on success [95% CI] | recall failed | lead median (IQR) | >= 2 before nudge | nudge - flag median |
|---|---|---|---|---|---|---|---|---|
| r1h | tune | ANY | 20% (1/5) [4, 62] | 5% (3/65) [2, 13] | 18% (2/11) | 3 (3-3) | 0% (0/1) | -36 |
| r1h | tune | limit_cycle | 20% (1/5) [4, 62] | 2% (1/65) [0, 8] | 9% (1/11) | 2 (2-2) | 0% (0/1) | -37 |
| r1h | tune | no_progress | 0% (0/5) [0, 43] | 2% (1/65) [0, 8] | 9% (1/11) | n/a (n/a-n/a) | n/a | n/a |
| r1h | tune | novelty_cusum | 20% (1/5) [4, 62] | 3% (2/65) [1, 11] | 9% (1/11) | 3 (3-3) | 0% (0/1) | -36 |
| r1h | tune | existing_nudge | 60% (3/5) [23, 88] | 58% (38/65) [46, 70] | 45% (5/11) | 27 (17-33) | - | - |
| m1 | held-out | ANY | 54% (15/28) [36, 70] | 0% (0/73) [0, 5] | 40% (17/42) | 16 (10.5-174) | 0% (0/15) | -38 |
| m1 | held-out | limit_cycle | 21% (6/28) [10, 40] | 0% (0/73) [0, 5] | 17% (7/42) | 77 (2-161.8) | 0% (0/6) | -56.5 |
| m1 | held-out | no_progress | 32% (9/28) [18, 51] | 0% (0/73) [0, 5] | 26% (11/42) | 131 (23-163) | 0% (0/9) | -23 |
| m1 | held-out | novelty_cusum | 50% (14/28) [33, 67] | 0% (0/73) [0, 5] | 36% (15/42) | 12.5 (6.8-174.3) | 0% (0/14) | -42 |
| m1 | held-out | existing_nudge | 96% (27/28) [82, 99] | 51% (37/73) [39, 62] | 76% (32/42) | 49 (20.5-96) | - | - |
| bud | other | ANY | 50% (3/6) [19, 81] | 7% (3/46) [2, 18] | 38% (5/13) | 29 (18.5-65) | 0% (0/3) | -29 |
| bud | other | limit_cycle | 17% (1/6) [3, 56] | 0% (0/46) [0, 8] | 8% (1/13) | 2 (2-2) | 0% (0/1) | -88 |
| bud | other | no_progress | 33% (2/6) [10, 70] | 7% (3/46) [2, 18] | 23% (3/13) | 54.5 (31.3-77.8) | 0% (0/2) | -18.5 |
| bud | other | novelty_cusum | 17% (1/6) [3, 56] | 0% (0/46) [0, 8] | 15% (2/13) | 29 (29-29) | 0% (0/1) | -61 |
| bud | other | existing_nudge | 83% (5/6) [44, 97] | 46% (21/46) [32, 60] | 54% (7/13) | 38 (37-90) | - | - |
| bud2 | other | ANY | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| bud2 | other | limit_cycle | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| bud2 | other | no_progress | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| bud2 | other | novelty_cusum | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| bud2 | other | existing_nudge | n/a  | 50% (2/4) [15, 85] | n/a | n/a (n/a-n/a) | - | - |
| lean | other | ANY | 33% (2/6) [10, 70] | 1% (1/80) [0, 7] | 11% (2/19) | 84 (51-117) | 0% (0/2) | -21 |
| lean | other | limit_cycle | 0% (0/6) [0, 39] | 0% (0/80) [0, 5] | 0% (0/19) | n/a (n/a-n/a) | n/a | n/a |
| lean | other | no_progress | 17% (1/6) [3, 56] | 1% (1/80) [0, 7] | 5% (1/19) | 150 (150-150) | 0% (0/1) | -8 |
| lean | other | novelty_cusum | 17% (1/6) [3, 56] | 0% (0/80) [0, 5] | 5% (1/19) | 18 (18-18) | 0% (0/1) | -34 |
| lean | other | existing_nudge | 50% (3/6) [19, 81] | 44% (35/80) [33, 55] | 26% (5/19) | 52 (52-105) | - | - |
| m2 | other | ANY | 11% (1/9) [2, 44] | 0% (0/47) [0, 8] | 9% (2/22) | 66 (66-66) | 0% (0/1) | -9 |
| m2 | other | limit_cycle | 0% (0/9) [0, 30] | 0% (0/47) [0, 8] | 0% (0/22) | n/a (n/a-n/a) | n/a | n/a |
| m2 | other | no_progress | 11% (1/9) [2, 44] | 0% (0/47) [0, 8] | 5% (1/22) | 66 (66-66) | 0% (0/1) | -9 |
| m2 | other | novelty_cusum | 0% (0/9) [0, 30] | 0% (0/47) [0, 8] | 5% (1/22) | n/a (n/a-n/a) | n/a | n/a |
| m2 | other | existing_nudge | 44% (4/9) [19, 73] | 60% (28/47) [45, 72] | 45% (10/22) | 47.5 (15.8-78.3) | - | - |
| p1h | other | ANY | n/a  | 0% (0/27) [0, 12] | 20% (1/5) | n/a (n/a-n/a) | n/a | n/a |
| p1h | other | limit_cycle | n/a  | 0% (0/27) [0, 12] | 0% (0/5) | n/a (n/a-n/a) | n/a | n/a |
| p1h | other | no_progress | n/a  | 0% (0/27) [0, 12] | 20% (1/5) | n/a (n/a-n/a) | n/a | n/a |
| p1h | other | novelty_cusum | n/a  | 0% (0/27) [0, 12] | 0% (0/5) | n/a (n/a-n/a) | n/a | n/a |
| p1h | other | existing_nudge | n/a  | 59% (16/27) [41, 75] | 40% (2/5) | n/a (n/a-n/a) | - | - |
| peers | other | ANY | 67% (2/3) [21, 94] | 10% (3/31) [3, 25] | 38% (3/8) | 32 (29.5-34.5) | 0% (0/2) | -23.5 |
| peers | other | limit_cycle | 33% (1/3) [6, 79] | 0% (0/31) [0, 11] | 13% (1/8) | 26 (26-26) | 0% (0/1) | -47 |
| peers | other | no_progress | 33% (1/3) [6, 79] | 6% (2/31) [2, 21] | 13% (1/8) | 25 (25-25) | 0% (0/1) | -13 |
| peers | other | novelty_cusum | 67% (2/3) [21, 94] | 6% (2/31) [2, 21] | 38% (3/8) | 32 (29.5-34.5) | 0% (0/2) | -23.5 |
| peers | other | existing_nudge | 67% (2/3) [21, 94] | 55% (17/31) [38, 71] | 75% (6/8) | 55.5 (46.8-64.3) | - | - |
| r1 | other | ANY | 10% (1/10) [2, 40] | 2% (1/65) [0, 8] | 9% (2/22) | 3 (3-3) | 100% (1/1) | n/a |
| r1 | other | limit_cycle | 10% (1/10) [2, 40] | 0% (0/65) [0, 6] | 5% (1/22) | 3 (3-3) | 100% (1/1) | n/a |
| r1 | other | no_progress | 0% (0/10) [0, 28] | 0% (0/65) [0, 6] | 0% (0/22) | n/a (n/a-n/a) | n/a | n/a |
| r1 | other | novelty_cusum | 10% (1/10) [2, 40] | 2% (1/65) [0, 8] | 9% (2/22) | 2 (2-2) | 100% (1/1) | n/a |
| r1 | other | existing_nudge | 30% (3/10) [11, 60] | 52% (34/65) [40, 64] | 36% (8/22) | 39 (20.5-61.5) | - | - |
| r3r | other | ANY | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| r3r | other | limit_cycle | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| r3r | other | no_progress | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| r3r | other | novelty_cusum | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| r3r | other | existing_nudge | n/a  | 100% (4/4) [51, 100] | n/a | n/a (n/a-n/a) | - | - |
| s1 | other | ANY | 22% (2/9) [6, 55] | 3% (1/30) [1, 17] | 12% (2/17) | 22 (18-26) | 0% (0/2) | -33.5 |
| s1 | other | limit_cycle | 0% (0/9) [0, 30] | 0% (0/30) [0, 11] | 0% (0/17) | n/a (n/a-n/a) | n/a | n/a |
| s1 | other | no_progress | 22% (2/9) [6, 55] | 0% (0/30) [0, 11] | 12% (2/17) | 22 (18-26) | 0% (0/2) | -33.5 |
| s1 | other | novelty_cusum | 0% (0/9) [0, 30] | 3% (1/30) [1, 17] | 0% (0/17) | n/a (n/a-n/a) | n/a | n/a |
| s1 | other | existing_nudge | 56% (5/9) [27, 81] | 47% (14/30) [30, 64] | 35% (6/17) | 46 (39-50) | - | - |

## A-priori thresholds

| campaign | role | flag | recall stall/cap, lead >= 2 [95% CI] | fire on success [95% CI] | recall failed | lead median (IQR) | >= 2 before nudge | nudge - flag median |
|---|---|---|---|---|---|---|---|---|
| r1h | tune | ANY | 40% (2/5) [12, 77] | 23% (15/65) [15, 35] | 27% (3/11) | 4.5 (4.3-4.8) | 0% (0/2) | -18.5 |
| r1h | tune | limit_cycle | 20% (1/5) [4, 62] | 2% (1/65) [0, 8] | 9% (1/11) | 2 (2-2) | 0% (0/1) | -37 |
| r1h | tune | no_progress | 40% (2/5) [12, 77] | 23% (15/65) [15, 35] | 27% (3/11) | 4.5 (4.3-4.8) | 0% (0/2) | -18.5 |
| r1h | tune | novelty_cusum | 0% (0/5) [0, 43] | 3% (2/65) [1, 11] | 0% (0/11) | n/a (n/a-n/a) | n/a | n/a |
| r1h | tune | existing_nudge | 60% (3/5) [23, 88] | 58% (38/65) [46, 70] | 45% (5/11) | 27 (17-33) | - | - |
| m1 | held-out | ANY | 61% (17/28) [42, 76] | 14% (10/73) [8, 23] | 45% (19/42) | 37 (12-169) | 29% (5/17) | -15 |
| m1 | held-out | limit_cycle | 21% (6/28) [10, 40] | 0% (0/73) [0, 5] | 17% (7/42) | 77 (2-161.8) | 0% (0/6) | -56.5 |
| m1 | held-out | no_progress | 57% (16/28) [39, 73] | 14% (10/73) [8, 23] | 43% (18/42) | 42.5 (12-173) | 31% (5/16) | -13 |
| m1 | held-out | novelty_cusum | 32% (9/28) [18, 51] | 0% (0/73) [0, 5] | 24% (10/42) | 169 (8-171) | 0% (0/9) | -47 |
| m1 | held-out | existing_nudge | 96% (27/28) [82, 99] | 51% (37/73) [39, 62] | 76% (32/42) | 49 (20.5-96) | - | - |
| bud | other | ANY | 67% (4/6) [30, 90] | 24% (11/46) [14, 38] | 46% (6/13) | 24.5 (17-50) | 50% (2/4) | -7.5 |
| bud | other | limit_cycle | 17% (1/6) [3, 56] | 0% (0/46) [0, 8] | 8% (1/13) | 2 (2-2) | 0% (0/1) | -88 |
| bud | other | no_progress | 67% (4/6) [30, 90] | 24% (11/46) [14, 38] | 46% (6/13) | 24.5 (17-50) | 50% (2/4) | -7.5 |
| bud | other | novelty_cusum | 0% (0/6) [0, 39] | 0% (0/46) [0, 8] | 0% (0/13) | n/a (n/a-n/a) | n/a | n/a |
| bud | other | existing_nudge | 83% (5/6) [44, 97] | 46% (21/46) [32, 60] | 54% (7/13) | 38 (37-90) | - | - |
| bud2 | other | ANY | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| bud2 | other | limit_cycle | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| bud2 | other | no_progress | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| bud2 | other | novelty_cusum | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| bud2 | other | existing_nudge | n/a  | 50% (2/4) [15, 85] | n/a | n/a (n/a-n/a) | - | - |
| lean | other | ANY | 33% (2/6) [10, 70] | 8% (6/80) [3, 15] | 16% (3/19) | 83.5 (44.3-122.8) | 50% (1/2) | -21.5 |
| lean | other | limit_cycle | 0% (0/6) [0, 39] | 0% (0/80) [0, 5] | 0% (0/19) | n/a (n/a-n/a) | n/a | n/a |
| lean | other | no_progress | 17% (1/6) [3, 56] | 8% (6/80) [3, 15] | 11% (2/19) | 162 (162-162) | 100% (1/1) | 4 |
| lean | other | novelty_cusum | 17% (1/6) [3, 56] | 0% (0/80) [0, 5] | 5% (1/19) | 5 (5-5) | 0% (0/1) | -47 |
| lean | other | existing_nudge | 50% (3/6) [19, 81] | 44% (35/80) [33, 55] | 26% (5/19) | 52 (52-105) | - | - |
| m2 | other | ANY | 44% (4/9) [19, 73] | 17% (8/47) [9, 30] | 23% (5/22) | 7 (5.8-24.8) | 75% (3/4) | 3 |
| m2 | other | limit_cycle | 0% (0/9) [0, 30] | 0% (0/47) [0, 8] | 0% (0/22) | n/a (n/a-n/a) | n/a | n/a |
| m2 | other | no_progress | 44% (4/9) [19, 73] | 17% (8/47) [9, 30] | 23% (5/22) | 7 (5.8-24.8) | 75% (3/4) | 3 |
| m2 | other | novelty_cusum | 0% (0/9) [0, 30] | 0% (0/47) [0, 8] | 0% (0/22) | n/a (n/a-n/a) | n/a | n/a |
| m2 | other | existing_nudge | 44% (4/9) [19, 73] | 60% (28/47) [45, 72] | 45% (10/22) | 47.5 (15.8-78.3) | - | - |
| p1h | other | ANY | n/a  | 30% (8/27) [16, 48] | 40% (2/5) | n/a (n/a-n/a) | n/a | n/a |
| p1h | other | limit_cycle | n/a  | 0% (0/27) [0, 12] | 0% (0/5) | n/a (n/a-n/a) | n/a | n/a |
| p1h | other | no_progress | n/a  | 30% (8/27) [16, 48] | 40% (2/5) | n/a (n/a-n/a) | n/a | n/a |
| p1h | other | novelty_cusum | n/a  | 0% (0/27) [0, 12] | 0% (0/5) | n/a (n/a-n/a) | n/a | n/a |
| p1h | other | existing_nudge | n/a  | 59% (16/27) [41, 75] | 40% (2/5) | n/a (n/a-n/a) | - | - |
| peers | other | ANY | 67% (2/3) [21, 94] | 26% (8/31) [14, 43] | 50% (4/8) | 32 (29-35) | 0% (0/2) | -23.5 |
| peers | other | limit_cycle | 33% (1/3) [6, 79] | 0% (0/31) [0, 11] | 13% (1/8) | 26 (26-26) | 0% (0/1) | -47 |
| peers | other | no_progress | 67% (2/3) [21, 94] | 26% (8/31) [14, 43] | 50% (4/8) | 24 (17-31) | 0% (0/2) | -31.5 |
| peers | other | novelty_cusum | 67% (2/3) [21, 94] | 3% (1/31) [1, 16] | 25% (2/8) | 16.5 (13.3-19.8) | 0% (0/2) | -39 |
| peers | other | existing_nudge | 67% (2/3) [21, 94] | 55% (17/31) [38, 71] | 75% (6/8) | 55.5 (46.8-64.3) | - | - |
| r1 | other | ANY | 20% (2/10) [6, 51] | 15% (10/65) [9, 26] | 14% (3/22) | 35 (19-51) | 50% (1/2) | -17 |
| r1 | other | limit_cycle | 10% (1/10) [2, 40] | 0% (0/65) [0, 6] | 5% (1/22) | 3 (3-3) | 100% (1/1) | n/a |
| r1 | other | no_progress | 10% (1/10) [2, 40] | 15% (10/65) [9, 26] | 9% (2/22) | 67 (67-67) | 0% (0/1) | -17 |
| r1 | other | novelty_cusum | 0% (0/10) [0, 28] | 2% (1/65) [0, 8] | 0% (0/22) | n/a (n/a-n/a) | n/a | n/a |
| r1 | other | existing_nudge | 30% (3/10) [11, 60] | 52% (34/65) [40, 64] | 36% (8/22) | 39 (20.5-61.5) | - | - |
| r3r | other | ANY | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| r3r | other | limit_cycle | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| r3r | other | no_progress | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| r3r | other | novelty_cusum | n/a  | 0% (0/4) [0, 49] | n/a | n/a (n/a-n/a) | n/a | n/a |
| r3r | other | existing_nudge | n/a  | 100% (4/4) [51, 100] | n/a | n/a (n/a-n/a) | - | - |
| s1 | other | ANY | 56% (5/9) [27, 81] | 20% (6/30) [10, 37] | 29% (5/17) | 42 (6-42) | 20% (1/5) | -16 |
| s1 | other | limit_cycle | 0% (0/9) [0, 30] | 0% (0/30) [0, 11] | 0% (0/17) | n/a (n/a-n/a) | n/a | n/a |
| s1 | other | no_progress | 56% (5/9) [27, 81] | 20% (6/30) [10, 37] | 29% (5/17) | 42 (6-42) | 20% (1/5) | -16 |
| s1 | other | novelty_cusum | 0% (0/9) [0, 30] | 0% (0/30) [0, 11] | 0% (0/17) | n/a (n/a-n/a) | n/a | n/a |
| s1 | other | existing_nudge | 56% (5/9) [27, 81] | 47% (14/30) [30, 64] | 35% (6/17) | 46 (39-50) | - | - |

## Criterion (held out: m1, tuned, ANY)

recall stall/cap 54% (15/28) [36, 70] (needs >= 30%); fire on success 0% (0/73) [0, 5] (needs < 5%): **MET**.

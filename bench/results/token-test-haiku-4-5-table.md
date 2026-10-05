Model: claude-haiku-4-5-20251001. Runs per mode: 10.

### Task fix-bugs: fix four bugs the failing tests point at

| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 1 | yes | 12 | 58 | 2.6k | 219.0k | 12.5k | 234.1k | $0.0598 | 34s |
| agentx | 1 | yes | 12 | 58 | 2.5k | 212.5k | 39.2k | 254.3k | $0.1124 | 29s |
| agentx-lean | 1 | yes | 12 | 98 | 2.6k | 415.7k | 13.5k | 431.9k | $0.0818 | 35s |
| claude | 2 | yes | 12 | 98 | 2.5k | 390.7k | 11.4k | 404.7k | $0.0745 | 34s |
| agentx | 2 | yes | 12 | 90 | 2.3k | 385.2k | 13.8k | 401.4k | $0.0777 | 32s |
| agentx-lean | 2 | yes | 12 | 90 | 2.5k | 379.6k | 13.3k | 395.5k | $0.0771 | 33s |
| claude | 3 | yes | 12 | 66 | 2.4k | 256.0k | 11.4k | 269.9k | $0.0606 | 30s |
| agentx | 3 | yes | 12 | 58 | 2.3k | 237.2k | 13.7k | 253.3k | $0.0629 | 30s |
| agentx-lean | 3 | yes | 12 | 90 | 2.3k | 379.4k | 13.2k | 395.1k | $0.0762 | 30s |
| claude | 4 | yes | 12 | 58 | 2.5k | 221.0k | 11.4k | 235.0k | $0.0574 | 26s |
| agentx | 4 | yes | 12 | 58 | 2.6k | 237.7k | 14.0k | 254.3k | $0.0646 | 32s |
| agentx-lean | 4 | yes | 12 | 58 | 2.6k | 234.4k | 13.4k | 250.5k | $0.0634 | 28s |
| claude | 5 | yes | 12 | 74 | 2.6k | 289.3k | 11.6k | 303.6k | $0.0651 | 30s |
| agentx | 5 | yes | 11 | 82 | 2.4k | 345.8k | 13.3k | 361.6k | $0.0735 | 34s |
| agentx-lean | 5 | yes | 12 | 98 | 2.4k | 413.5k | 13.2k | 429.2k | $0.0798 | 34s |
| claude | 6 | yes | 12 | 66 | 2.3k | 253.4k | 11.3k | 267.0k | $0.0595 | 28s |
| agentx | 6 | yes | 12 | 98 | 2.6k | 421.1k | 14.0k | 437.8k | $0.0831 | 39s |
| agentx-lean | 6 | yes | 12 | 58 | 2.3k | 233.1k | 13.0k | 248.5k | $0.0609 | 27s |
| claude | 7 | yes | 12 | 66 | 2.5k | 256.5k | 11.5k | 270.6k | $0.0612 | 31s |
| agentx | 7 | yes | 12 | 98 | 2.4k | 421.7k | 13.8k | 438.1k | $0.0820 | 34s |
| agentx-lean | 7 | yes | 12 | 90 | 2.4k | 380.1k | 13.3k | 395.9k | $0.0768 | 31s |
| claude | 8 | yes | 12 | 98 | 2.5k | 392.2k | 11.6k | 406.3k | $0.0751 | 33s |
| agentx | 8 | yes | 12 | 58 | 2.5k | 237.9k | 13.9k | 254.4k | $0.0641 | 32s |
| agentx-lean | 8 | yes | 12 | 66 | 2.4k | 269.5k | 13.2k | 285.2k | $0.0656 | 28s |
| claude | 9 | yes | 12 | 58 | 2.5k | 219.9k | 11.5k | 233.9k | $0.0575 | 26s |
| agentx | 9 | yes | 12 | 90 | 2.5k | 386.3k | 13.9k | 402.8k | $0.0788 | 35s |
| agentx-lean | 9 | yes | 12 | 58 | 2.4k | 232.5k | 13.1k | 248.0k | $0.0612 | 30s |
| claude | 10 | yes | 12 | 90 | 2.8k | 359.4k | 11.8k | 374.1k | $0.0736 | 39s |
| agentx | 10 | yes | 12 | 90 | 2.9k | 387.5k | 14.4k | 404.9k | $0.0824 | 37s |
| agentx-lean | 10 | yes | 12 | 90 | 2.6k | 380.4k | 13.5k | 396.6k | $0.0783 | 50s |

Medians per mode:

| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|
| claude | 10/10 | 12 | 270.2k | 256.3k | $0.0609 | 30s |
| agentx | 10/10 | 12 | 381.5k | 365.5k | $0.0783 | 33s |
| agentx-lean | 10/10 | 12 | 395.3k | 379.5k | $0.0765 | 31s |

### Task implement: write two functions the tests specify

| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 1 | yes | 6 | 50 | 2.7k | 177.4k | 8.7k | 188.9k | $0.0488 | 28s |
| agentx | 1 | yes | 8 | 50 | 2.0k | 190.4k | 10.7k | 203.1k | $0.0504 | 24s |
| agentx-lean | 1 | yes | 7 | 42 | 1.8k | 155.1k | 9.8k | 166.8k | $0.0443 | 21s |
| claude | 2 | yes | 9 | 74 | 2.3k | 268.9k | 8.7k | 280.0k | $0.0561 | 28s |
| agentx | 2 | yes | 6 | 42 | 3.1k | 158.4k | 11.5k | 173.0k | $0.0542 | 28s |
| agentx-lean | 2 | yes | 11 | 74 | 4.6k | 313.5k | 16.4k | 334.6k | $0.0873 | 47s |
| claude | 3 | yes | 8 | 66 | 2.2k | 238.2k | 8.5k | 249.0k | $0.0520 | 27s |
| agentx | 3 | yes | 8 | 50 | 2.6k | 190.8k | 11.3k | 204.7k | $0.0548 | 25s |
| agentx-lean | 3 | yes | 10 | 82 | 3.4k | 340.2k | 15.2k | 359.0k | $0.0817 | 40s |
| claude | 4 | yes | 7 | 58 | 2.2k | 208.8k | 8.3k | 219.4k | $0.0486 | 28s |
| agentx | 4 | yes | 8 | 66 | 4.1k | 262.6k | 12.7k | 279.4k | $0.0720 | 39s |
| agentx-lean | 4 | yes | 7 | 58 | 1.9k | 221.1k | 9.8k | 232.8k | $0.0511 | 28s |
| claude | 5 | yes | 8 | 58 | 2.6k | 213.3k | 9.9k | 225.9k | $0.0543 | 28s |
| agentx | 5 | yes | 7 | 42 | 1.8k | 157.3k | 10.3k | 169.5k | $0.0455 | 24s |
| agentx-lean | 5 | yes | 11 | 90 | 3.3k | 365.2k | 14.3k | 383.0k | $0.0818 | 39s |
| claude | 6 | yes | 6 | 42 | 1.5k | 145.9k | 7.6k | 155.1k | $0.0374 | 19s |
| agentx | 6 | yes | 8 | 66 | 2.0k | 258.5k | 10.7k | 271.4k | $0.0576 | 28s |
| agentx-lean | 6 | yes | 11 | 74 | 3.6k | 309.2k | 15.5k | 328.4k | $0.0799 | 39s |
| claude | 7 | yes | 10 | 82 | 6.1k | 326.7k | 14.5k | 347.4k | $0.0922 | 54s |
| agentx | 7 | yes | 10 | 82 | 3.0k | 332.1k | 12.9k | 348.1k | $0.0741 | 39s |
| agentx-lean | 7 | yes | 7 | 42 | 3.9k | 157.1k | 11.8k | 172.8k | $0.0586 | 33s |
| claude | 8 | yes | 7 | 50 | 1.9k | 176.3k | 8.1k | 186.3k | $0.0435 | 21s |
| agentx | 8 | yes | 8 | 50 | 2.0k | 190.2k | 10.6k | 202.8k | $0.0501 | 25s |
| agentx-lean | 8 | yes | 7 | 58 | 2.0k | 219.7k | 9.9k | 231.7k | $0.0517 | 25s |
| claude | 9 | yes | 10 | 82 | 4.1k | 311.4k | 11.6k | 327.1k | $0.0747 | 45s |
| agentx | 9 | yes | 6 | 42 | 2.2k | 157.7k | 10.7k | 170.7k | $0.0484 | 26s |
| agentx-lean | 9 | yes | 7 | 50 | 2.0k | 186.9k | 9.9k | 198.8k | $0.0483 | 22s |
| claude | 10 | yes | 12 | 98 | 3.5k | 388.3k | 12.9k | 404.8k | $0.0825 | 52s |
| agentx | 10 | yes | 10 | 82 | 4.4k | 330.6k | 13.5k | 348.6k | $0.0820 | 52s |
| agentx-lean | 10 | yes | 7 | 58 | 1.9k | 220.8k | 9.7k | 232.5k | $0.0509 | 31s |

Medians per mode:

| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|
| claude | 10/10 | 8 | 237.5k | 225.8k | $0.0532 | 28s |
| agentx | 10/10 | 8 | 203.9k | 190.6k | $0.0545 | 27s |
| agentx-lean | 10/10 | 7 | 232.6k | 221.0k | $0.0551 | 32s |

### Task trace: find the causes of a reported bug across six files

| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 1 | yes | 19 | 66 | 4.0k | 251.9k | 14.3k | 270.4k | $0.0741 | 40s |
| agentx | 1 | yes | 17 | 138 | 4.6k | 607.0k | 17.2k | 628.9k | $0.1181 | 60s |
| agentx-lean | 1 | yes | 17 | 58 | 3.0k | 233.4k | 14.7k | 251.1k | $0.0678 | 34s |
| claude | 2 | yes | 19 | 114 | 3.4k | 456.2k | 13.6k | 473.3k | $0.0898 | 45s |
| agentx | 2 | yes | 18 | 98 | 3.9k | 426.5k | 16.4k | 446.8k | $0.0948 | 48s |
| agentx-lean | 2 | yes | 16 | 98 | 3.4k | 419.4k | 15.4k | 438.2k | $0.0897 | 45s |
| claude | 3 | yes | 18 | 98 | 3.4k | 393.7k | 13.3k | 410.4k | $0.0831 | 44s |
| agentx | 3 | yes | 17 | 82 | 3.1k | 355.8k | 15.6k | 374.6k | $0.0825 | 48s |
| agentx-lean | 3 | yes | 16 | 58 | 3.3k | 234.2k | 15.1k | 252.7k | $0.0702 | 44s |
| claude | 4 | yes | 16 | 66 | 3.2k | 251.9k | 13.0k | 268.1k | $0.0672 | 37s |
| agentx | 4 | yes | 17 | 98 | 3.5k | 426.2k | 16.1k | 445.9k | $0.0923 | 44s |
| agentx-lean | 4 | yes | 17 | 98 | 3.5k | 418.7k | 15.5k | 437.8k | $0.0903 | 43s |
| claude | 5 | yes | 16 | 66 | 3.7k | 254.5k | 13.5k | 271.7k | $0.0711 | 40s |
| agentx | 5 | yes | 17 | 74 | 2.9k | 303.5k | 15.2k | 321.7k | $0.0754 | 38s |
| agentx-lean | 5 | yes | 16 | 66 | 4.3k | 270.5k | 16.1k | 290.9k | $0.0807 | 47s |
| claude | 6 | yes | 16 | 90 | 3.2k | 362.4k | 13.2k | 379.0k | $0.0789 | 39s |
| agentx | 6 | yes | 17 | 66 | 5.3k | 275.3k | 17.7k | 298.3k | $0.0892 | 52s |
| agentx-lean | 6 | yes | 19 | 114 | 5.1k | 479.3k | 15.1k | 499.6k | $0.1040 | 61s |
| claude | 7 | yes | 16 | 90 | 3.6k | 364.8k | 13.7k | 382.2k | $0.0822 | 44s |
| agentx | 7 | yes | 16 | 66 | 3.8k | 275.1k | 16.3k | 295.2k | $0.0790 | 43s |
| agentx-lean | 7 | yes | 19 | 154 | 3.5k | 662.9k | 15.9k | 682.5k | $0.1157 | 63s |
| claude | 8 | yes | 16 | 98 | 2.8k | 390.9k | 12.9k | 406.7k | $0.0790 | 38s |
| agentx | 8 | yes | 17 | 66 | 4.0k | 273.2k | 16.6k | 293.8k | $0.0808 | 42s |
| agentx-lean | 8 | yes | 17 | 66 | 5.0k | 278.2k | 16.8k | 300.1k | $0.0867 | 49s |
| claude | 9 | yes | 17 | 74 | 3.4k | 284.8k | 13.3k | 301.6k | $0.0720 | 42s |
| agentx | 9 | yes | 16 | 66 | 3.4k | 272.1k | 15.9k | 291.4k | $0.0761 | 47s |
| agentx-lean | 9 | yes | 17 | 66 | 4.8k | 270.1k | 16.5k | 291.4k | $0.0840 | 50s |
| claude | 10 | yes | 17 | 74 | 5.0k | 302.8k | 16.2k | 324.1k | $0.0875 | 62s |
| agentx | 10 | yes | 16 | 90 | 3.1k | 394.7k | 15.7k | 413.6k | $0.0862 | 38s |
| agentx-lean | 10 | yes | 19 | 154 | 5.3k | 673.0k | 17.6k | 696.0k | $0.1290 | 68s |

Medians per mode:

| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|
| claude | 10/10 | 16.5 | 351.5k | 332.6k | $0.0790 | 41s |
| agentx | 10/10 | 17 | 348.2k | 329.7k | $0.0843 | 46s |
| agentx-lean | 10/10 | 17 | 368.9k | 348.4k | $0.0882 | 48s |

Against the bare CLI (AgentX median over bare median, 95% bootstrap interval; every run counts):

| Metric | Mode | Task | Runs (AgentX/bare) | Ratio | 95% interval | Verdict |
|---|---|---|---|---|---|---|
| tokens | agentx | fix-bugs | 10/10 | 1.41 (+41%) | 0.79 to 1.62 | no clear difference |
| tokens | agentx | implement | 10/10 | 0.86 (-14%) | 0.62 to 1.33 | no clear difference |
| tokens | agentx | trace | 10/10 | 0.99 (-1%) | 0.76 to 1.44 | no clear difference |
| tokens | agentx | all tasks | 30/30 | 1.06 (+6%) | 0.83 to 1.28 | no clear difference |
| tokens | agentx-lean | fix-bugs | 10/10 | 1.46 (+46%) | 0.83 to 1.68 | no clear difference |
| tokens | agentx-lean | implement | 10/10 | 0.98 (-2%) | 0.71 to 1.56 | no clear difference |
| tokens | agentx-lean | trace | 10/10 | 1.05 (+5%) | 0.74 to 1.66 | no clear difference |
| tokens | agentx-lean | all tasks | 30/30 | 1.15 (+15%) | 0.88 to 1.42 | no clear difference |
| cost | agentx | fix-bugs | 10/10 | 1.29 (+29%) | 1.02 to 1.38 | costs more |
| cost | agentx | implement | 10/10 | 1.03 (+3%) | 0.72 to 1.37 | no clear difference |
| cost | agentx | trace | 10/10 | 1.07 (+7%) | 0.97 to 1.22 | no clear difference |
| cost | agentx | all tasks | 30/30 | 1.12 (+12%) | 0.97 to 1.24 | no clear difference |
| cost | agentx-lean | fix-bugs | 10/10 | 1.26 (+26%) | 0.96 to 1.31 | no clear difference |
| cost | agentx-lean | implement | 10/10 | 1.04 (+4%) | 0.74 to 1.64 | no clear difference |
| cost | agentx-lean | trace | 10/10 | 1.12 (+12%) | 0.98 to 1.36 | no clear difference |
| cost | agentx-lean | all tasks | 30/30 | 1.13 (+13%) | 0.97 to 1.32 | no clear difference |

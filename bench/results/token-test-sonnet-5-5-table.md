Model: claude-sonnet-5-5. Runs per mode: 10.

### Task fix-bugs: fix four bugs the failing tests point at

| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 1 | yes | 4 | 8 | 475 | 123.2k | 9.6k | 133.3k | $0.0676 | 9s |
| agentx | 1 | yes | 4 | 8 | 495 | 137.1k | 15.7k | 153.2k | $0.0950 | 9s |
| agentx-lean | 1 | yes | 5 | 10 | 498 | 160.4k | 10.1k | 170.9k | $0.0773 | 11s |
| claude | 2 | yes | 4 | 8 | 484 | 123.2k | 9.6k | 133.3k | $0.0678 | 9s |
| agentx | 2 | yes | 4 | 8 | 528 | 138.2k | 12.7k | 151.5k | $0.0838 | 10s |
| agentx-lean | 2 | yes | 4 | 8 | 413 | 125.3k | 9.7k | 135.4k | $0.0681 | 8s |
| claude | 3 | yes | 4 | 8 | 524 | 123.8k | 9.9k | 134.2k | $0.0696 | 9s |
| agentx | 3 | yes | 4 | 8 | 522 | 138.2k | 12.7k | 151.4k | $0.0836 | 8s |
| agentx-lean | 3 | yes | 4 | 8 | 413 | 125.3k | 9.7k | 135.5k | $0.0682 | 8s |
| claude | 4 | yes | 4 | 8 | 408 | 123.0k | 9.4k | 132.8k | $0.0664 | 8s |
| agentx | 4 | yes | 4 | 8 | 527 | 138.2k | 12.7k | 151.4k | $0.0837 | 9s |
| agentx-lean | 4 | yes | 4 | 8 | 420 | 125.3k | 9.7k | 135.5k | $0.0682 | 9s |
| claude | 5 | yes | 4 | 8 | 414 | 123.0k | 9.4k | 132.8k | $0.0665 | 8s |
| agentx | 5 | yes | 4 | 8 | 473 | 138.9k | 13.0k | 152.4k | $0.0845 | 9s |
| agentx-lean | 5 | yes | 4 | 8 | 483 | 125.3k | 9.7k | 135.6k | $0.0689 | 10s |
| claude | 6 | yes | 4 | 8 | 515 | 123.2k | 9.6k | 133.3k | $0.0682 | 9s |
| agentx | 6 | yes | 4 | 8 | 522 | 138.2k | 12.7k | 151.4k | $0.0836 | 8s |
| agentx-lean | 6 | yes | 4 | 8 | 416 | 125.3k | 9.7k | 135.4k | $0.0682 | 8s |
| claude | 7 | yes | 4 | 8 | 413 | 123.0k | 9.4k | 132.8k | $0.0665 | 9s |
| agentx | 7 | yes | 4 | 8 | 526 | 138.9k | 13.1k | 152.5k | $0.0853 | 9s |
| agentx-lean | 7 | yes | 4 | 8 | 412 | 125.5k | 9.8k | 135.7k | $0.0685 | 11s |
| claude | 8 | yes | 4 | 8 | 521 | 123.8k | 9.9k | 134.2k | $0.0696 | 9s |
| agentx | 8 | yes | 4 | 8 | 522 | 138.2k | 12.7k | 151.4k | $0.0836 | 9s |
| agentx-lean | 8 | yes | 4 | 8 | 411 | 125.3k | 9.7k | 135.5k | $0.0681 | 8s |
| claude | 9 | yes | 4 | 8 | 478 | 123.2k | 9.6k | 133.3k | $0.0677 | 9s |
| agentx | 9 | yes | 4 | 8 | 468 | 138.2k | 12.6k | 151.3k | $0.0829 | 9s |
| agentx-lean | 9 | yes | 4 | 8 | 479 | 125.3k | 9.7k | 135.5k | $0.0688 | 9s |
| claude | 10 | yes | 4 | 8 | 414 | 123.0k | 9.4k | 132.8k | $0.0665 | 8s |
| agentx | 10 | yes | 4 | 8 | 547 | 139.0k | 13.2k | 152.8k | $0.0860 | 9s |
| agentx-lean | 10 | yes | 4 | 8 | 463 | 125.3k | 9.7k | 135.5k | $0.0685 | 9s |

Medians per mode:

| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|
| claude | 10/10 | 4 | 133.3k | 123.2k | $0.0677 | 9s |
| agentx | 10/10 | 4 | 151.4k | 138.2k | $0.0837 | 9s |
| agentx-lean | 10/10 | 4 | 135.5k | 125.3k | $0.0684 | 9s |

### Task implement: write two functions the tests specify

| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 1 | yes | 3 | 6 | 809 | 89.3k | 8.9k | 99.0k | $0.0617 | 9s |
| agentx | 1 | yes | 3 | 6 | 829 | 99.8k | 12.1k | 112.7k | $0.0766 | 10s |
| agentx-lean | 1 | yes | 3 | 6 | 875 | 90.9k | 9.3k | 101.1k | $0.0640 | 10s |
| claude | 2 | yes | 3 | 6 | 831 | 89.3k | 8.9k | 99.1k | $0.0619 | 8s |
| agentx | 2 | yes | 3 | 6 | 824 | 99.8k | 12.1k | 112.7k | $0.0765 | 9s |
| agentx-lean | 2 | yes | 3 | 6 | 820 | 90.9k | 9.2k | 101.0k | $0.0633 | 10s |
| claude | 3 | yes | 3 | 6 | 820 | 89.3k | 8.9k | 99.0k | $0.0618 | 9s |
| agentx | 3 | yes | 3 | 6 | 863 | 99.8k | 12.1k | 112.8k | $0.0771 | 10s |
| agentx-lean | 3 | yes | 3 | 6 | 764 | 90.9k | 9.2k | 100.9k | $0.0625 | 9s |
| claude | 4 | yes | 3 | 6 | 820 | 89.3k | 8.9k | 99.0k | $0.0618 | 9s |
| agentx | 4 | yes | 3 | 6 | 833 | 99.8k | 12.1k | 112.7k | $0.0767 | 11s |
| agentx-lean | 4 | yes | 3 | 6 | 798 | 90.9k | 9.2k | 100.9k | $0.0630 | 9s |
| claude | 5 | yes | 3 | 6 | 820 | 89.3k | 8.9k | 99.0k | $0.0618 | 10s |
| agentx | 5 | yes | 3 | 6 | 894 | 99.7k | 12.2k | 112.8k | $0.0775 | 10s |
| agentx-lean | 5 | yes | 3 | 6 | 978 | 90.9k | 9.4k | 101.3k | $0.0655 | 10s |
| claude | 6 | yes | 3 | 6 | 849 | 89.3k | 9.0k | 99.1k | $0.0622 | 11s |
| agentx | 6 | yes | 3 | 6 | 861 | 99.8k | 12.1k | 112.8k | $0.0770 | 10s |
| agentx-lean | 6 | yes | 3 | 6 | 744 | 90.9k | 9.1k | 100.8k | $0.0622 | 9s |
| claude | 7 | yes | 3 | 6 | 820 | 89.3k | 8.9k | 99.0k | $0.0618 | 9s |
| agentx | 7 | yes | 3 | 6 | 856 | 99.8k | 12.1k | 112.8k | $0.0770 | 10s |
| agentx-lean | 7 | yes | 4 | 6 | 934 | 91.1k | 9.4k | 101.4k | $0.0653 | 11s |
| claude | 8 | yes | 3 | 6 | 820 | 89.3k | 8.9k | 99.0k | $0.0618 | 9s |
| agentx | 8 | yes | 3 | 6 | 870 | 99.8k | 12.1k | 112.8k | $0.0772 | 11s |
| agentx-lean | 8 | yes | 3 | 6 | 830 | 90.9k | 9.2k | 101.0k | $0.0634 | 10s |
| claude | 9 | yes | 3 | 6 | 763 | 89.3k | 8.9k | 98.9k | $0.0610 | 10s |
| agentx | 9 | yes | 3 | 6 | 940 | 99.9k | 12.2k | 113.1k | $0.0784 | 11s |
| agentx-lean | 9 | yes | 3 | 6 | 614 | 90.9k | 9.0k | 100.5k | $0.0604 | 10s |
| claude | 10 | yes | 3 | 6 | 820 | 89.3k | 8.9k | 99.0k | $0.0618 | 9s |
| agentx | 10 | yes | 3 | 6 | 865 | 99.8k | 12.1k | 112.8k | $0.0771 | 9s |
| agentx-lean | 10 | yes | 3 | 6 | 753 | 90.9k | 9.1k | 100.8k | $0.0623 | 11s |

Medians per mode:

| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|
| claude | 10/10 | 3 | 99.0k | 89.3k | $0.0618 | 9s |
| agentx | 10/10 | 3 | 112.8k | 99.8k | $0.0771 | 10s |
| agentx-lean | 10/10 | 3 | 100.9k | 90.9k | $0.0631 | 10s |

### Task trace: find the causes of a reported bug across six files

| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 1 | yes | 3 | 6 | 664 | 90.1k | 9.6k | 100.3k | $0.0630 | 10s |
| agentx | 1 | yes | 4 | 8 | 818 | 138.2k | 13.3k | 152.3k | $0.0889 | 11s |
| agentx-lean | 1 | yes | 4 | 8 | 764 | 125.4k | 10.1k | 136.4k | $0.0733 | 12s |
| claude | 2 | yes | 4 | 6 | 849 | 90.1k | 10.4k | 101.4k | $0.0683 | 11s |
| agentx | 2 | yes | 4 | 8 | 752 | 137.3k | 12.4k | 150.5k | $0.0848 | 12s |
| agentx-lean | 2 | yes | 4 | 8 | 872 | 125.3k | 10.4k | 136.6k | $0.0755 | 11s |
| claude | 3 | yes | 3 | 6 | 874 | 89.7k | 9.3k | 99.9k | $0.0641 | 12s |
| agentx | 3 | yes | 4 | 8 | 799 | 138.2k | 13.3k | 152.3k | $0.0888 | 12s |
| agentx-lean | 3 | yes | 4 | 8 | 759 | 125.5k | 9.9k | 136.2k | $0.0725 | 11s |
| claude | 4 | yes | 3 | 6 | 704 | 90.1k | 9.6k | 100.4k | $0.0634 | 10s |
| agentx | 4 | yes | 3 | 6 | 770 | 100.3k | 12.3k | 113.3k | $0.0770 | 10s |
| agentx-lean | 4 | yes | 4 | 8 | 837 | 125.3k | 10.4k | 136.6k | $0.0752 | 11s |
| claude | 5 | yes | 4 | 8 | 804 | 124.3k | 9.7k | 134.8k | $0.0719 | 11s |
| agentx | 5 | yes | 4 | 8 | 785 | 138.2k | 13.3k | 152.3k | $0.0886 | 11s |
| agentx-lean | 5 | yes | 5 | 10 | 989 | 162.4k | 11.2k | 174.6k | $0.0873 | 14s |
| claude | 6 | yes | 6 | 12 | 1.1k | 194.3k | 10.9k | 206.3k | $0.0939 | 18s |
| agentx | 6 | yes | 4 | 8 | 818 | 138.2k | 13.3k | 152.3k | $0.0889 | 10s |
| agentx-lean | 6 | yes | 4 | 8 | 762 | 124.4k | 9.6k | 134.8k | $0.0708 | 12s |
| claude | 7 | yes | 3 | 6 | 741 | 90.1k | 9.4k | 100.3k | $0.0632 | 10s |
| agentx | 7 | yes | 4 | 8 | 792 | 138.2k | 13.3k | 152.3k | $0.0888 | 10s |
| agentx-lean | 7 | yes | 4 | 8 | 771 | 125.9k | 9.7k | 136.4k | $0.0719 | 13s |
| claude | 8 | yes | 3 | 6 | 747 | 90.1k | 9.4k | 100.3k | $0.0632 | 10s |
| agentx | 8 | yes | 6 | 12 | 1.1k | 217.0k | 13.8k | 231.9k | $0.1095 | 14s |
| agentx-lean | 8 | yes | 4 | 8 | 823 | 125.9k | 9.9k | 136.6k | $0.0731 | 12s |
| claude | 9 | yes | 4 | 8 | 856 | 124.0k | 10.7k | 135.5k | $0.0760 | 11s |
| agentx | 9 | yes | 4 | 8 | 772 | 137.3k | 12.5k | 150.6k | $0.0850 | 11s |
| agentx-lean | 9 | yes | 4 | 8 | 787 | 125.3k | 10.4k | 136.5k | $0.0746 | 13s |
| claude | 10 | yes | 4 | 8 | 785 | 124.3k | 9.7k | 134.8k | $0.0716 | 11s |
| agentx | 10 | yes | 4 | 8 | 790 | 138.2k | 13.3k | 152.2k | $0.0886 | 11s |
| agentx-lean | 10 | yes | 4 | 8 | 779 | 125.3k | 10.5k | 136.6k | $0.0750 | 11s |

Medians per mode:

| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|
| claude | 10/10 | 3.5 | 100.9k | 90.1k | $0.0662 | 11s |
| agentx | 10/10 | 4 | 152.3k | 138.2k | $0.0887 | 11s |
| agentx-lean | 10/10 | 4 | 136.5k | 125.4k | $0.0740 | 12s |

Against the bare CLI (AgentX median over bare median, 95% bootstrap interval; every run counts):

| Metric | Mode | Task | Runs (AgentX/bare) | Ratio | 95% interval | Verdict |
|---|---|---|---|---|---|---|
| tokens | agentx | fix-bugs | 10/10 | 1.14 (+14%) | 1.14 to 1.15 | uses more |
| tokens | agentx | implement | 10/10 | 1.14 (+14%) | 1.14 to 1.14 | uses more |
| tokens | agentx | trace | 10/10 | 1.51 (+51%) | 1.12 to 1.52 | uses more |
| tokens | agentx | all tasks | 30/30 | 1.25 (+25%) | 1.13 to 1.26 | uses more |
| tokens | agentx-lean | fix-bugs | 10/10 | 1.02 (+2%) | 1.01 to 1.02 | uses more; within 10% |
| tokens | agentx-lean | implement | 10/10 | 1.02 (+2%) | 1.02 to 1.02 | uses more; within 10% |
| tokens | agentx-lean | trace | 10/10 | 1.35 (+35%) | 1.01 to 1.36 | uses more |
| tokens | agentx-lean | all tasks | 30/30 | 1.12 (+12%) | 1.02 to 1.12 | uses more |
| cost | agentx | fix-bugs | 10/10 | 1.24 (+24%) | 1.23 to 1.27 | costs more |
| cost | agentx | implement | 10/10 | 1.25 (+25%) | 1.24 to 1.25 | costs more |
| cost | agentx | trace | 10/10 | 1.34 (+34%) | 1.20 to 1.40 | costs more |
| cost | agentx | all tasks | 30/30 | 1.27 (+27%) | 1.23 to 1.30 | costs more |
| cost | agentx-lean | fix-bugs | 10/10 | 1.01 (+1%) | 1.00 to 1.03 | no clear difference; within 10% |
| cost | agentx-lean | implement | 10/10 | 1.02 (+2%) | 1.01 to 1.04 | costs more; within 10% |
| cost | agentx-lean | trace | 10/10 | 1.12 (+12%) | 1.01 to 1.18 | costs more |
| cost | agentx-lean | all tasks | 30/30 | 1.05 (+5%) | 1.01 to 1.07 | costs more; within 10% |

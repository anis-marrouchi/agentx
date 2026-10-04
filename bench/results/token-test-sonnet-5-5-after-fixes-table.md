Model: claude-sonnet-5-5. Runs per mode: 10.

### Task fix-bugs: fix four bugs the failing tests point at

| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 1 | yes | 4 | 8 | 511 | 123.2k | 9.6k | 133.3k | $0.0681 | 8s |
| agentx | 1 | yes | 4 | 8 | 526 | 133.9k | 12.7k | 147.1k | $0.0828 | 8s |
| agentx-lean | 1 | yes | 5 | 10 | 481 | 160.3k | 10.0k | 170.8k | $0.0770 | 10s |
| claude | 2 | yes | 4 | 8 | 538 | 123.2k | 9.6k | 133.4k | $0.0685 | 9s |
| agentx | 2 | yes | 4 | 8 | 474 | 133.9k | 12.6k | 147.0k | $0.0821 | 9s |
| agentx-lean | 2 | yes | 4 | 8 | 414 | 125.3k | 9.7k | 135.4k | $0.0681 | 11s |
| claude | 3 | yes | 4 | 8 | 523 | 123.1k | 9.5k | 133.2k | $0.0680 | 11s |
| agentx | 3 | yes | 4 | 8 | 526 | 133.9k | 12.7k | 147.1k | $0.0828 | 12s |
| agentx-lean | 3 | yes | 4 | 8 | 418 | 125.3k | 9.7k | 135.4k | $0.0682 | 11s |
| claude | 4 | yes | 4 | 8 | 491 | 123.1k | 9.5k | 133.1k | $0.0676 | 11s |
| agentx | 4 | yes | 4 | 8 | 386 | 133.8k | 12.5k | 146.7k | $0.0807 | 11s |
| agentx-lean | 4 | yes | 4 | 8 | 535 | 125.4k | 9.9k | 135.8k | $0.0699 | 12s |
| claude | 5 | yes | 4 | 8 | 519 | 123.1k | 9.5k | 133.2k | $0.0680 | 11s |
| agentx | 5 | yes | 4 | 8 | 407 | 133.8k | 12.5k | 146.7k | $0.0809 | 11s |
| agentx-lean | 5 | yes | 4 | 8 | 414 | 125.3k | 9.7k | 135.4k | $0.0682 | 12s |
| claude | 6 | yes | 5 | 10 | 505 | 158.3k | 10.0k | 168.8k | $0.0769 | 13s |
| agentx | 6 | yes | 4 | 8 | 516 | 133.9k | 12.6k | 147.1k | $0.0825 | 13s |
| agentx-lean | 6 | yes | 4 | 8 | 418 | 125.3k | 9.7k | 135.4k | $0.0682 | 11s |
| claude | 7 | yes | 4 | 8 | 519 | 123.1k | 9.5k | 133.2k | $0.0680 | 12s |
| agentx | 7 | yes | 4 | 8 | 526 | 133.9k | 12.7k | 147.1k | $0.0828 | 12s |
| agentx-lean | 7 | yes | 4 | 8 | 529 | 125.5k | 9.9k | 136.0k | $0.0701 | 13s |
| claude | 8 | yes | 4 | 8 | 512 | 123.4k | 9.7k | 133.6k | $0.0686 | 9s |
| agentx | 8 | yes | 4 | 8 | 454 | 133.8k | 12.5k | 146.8k | $0.0814 | 10s |
| agentx-lean | 8 | yes | 5 | 10 | 483 | 160.3k | 10.0k | 170.8k | $0.0770 | 10s |
| claude | 9 | yes | 4 | 8 | 466 | 123.2k | 9.5k | 133.2k | $0.0675 | 8s |
| agentx | 9 | yes | 4 | 8 | 638 | 133.9k | 12.7k | 147.2k | $0.0839 | 10s |
| agentx-lean | 9 | yes | 5 | 10 | 524 | 160.3k | 10.1k | 170.9k | $0.0776 | 10s |
| claude | 10 | yes | 4 | 8 | 512 | 123.2k | 9.6k | 133.3k | $0.0682 | 8s |
| agentx | 10 | yes | 4 | 8 | 472 | 134.6k | 13.0k | 148.1k | $0.0836 | 9s |
| agentx-lean | 10 | yes | 4 | 8 | 527 | 125.3k | 9.7k | 135.5k | $0.0693 | 11s |

Medians per mode:

| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|
| claude | 10/10 | 4 | 133.3k | 123.2k | $0.0681 | 10s |
| agentx | 10/10 | 4 | 147.1k | 133.9k | $0.0826 | 10s |
| agentx-lean | 10/10 | 4 | 135.7k | 125.4k | $0.0696 | 11s |

### Task implement: write two functions the tests specify

| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 1 | yes | 3 | 6 | 820 | 89.3k | 8.9k | 99.0k | $0.0618 | 9s |
| agentx | 1 | yes | 3 | 6 | 888 | 96.5k | 12.1k | 109.5k | $0.0765 | 10s |
| agentx-lean | 1 | yes | 3 | 6 | 740 | 90.9k | 9.1k | 100.8k | $0.0621 | 10s |
| claude | 2 | yes | 3 | 6 | 817 | 89.3k | 8.9k | 99.0k | $0.0618 | 11s |
| agentx | 2 | yes | 3 | 6 | 848 | 96.6k | 12.1k | 109.5k | $0.0762 | 12s |
| agentx-lean | 2 | yes | 3 | 6 | 869 | 90.8k | 9.3k | 100.9k | $0.0639 | 12s |
| claude | 3 | yes | 3 | 6 | 737 | 89.3k | 8.9k | 98.9k | $0.0607 | 10s |
| agentx | 3 | yes | 4 | 6 | 842 | 96.8k | 12.2k | 109.8k | $0.0765 | 11s |
| agentx-lean | 3 | yes | 3 | 6 | 752 | 90.9k | 9.1k | 100.8k | $0.0623 | 12s |
| claude | 4 | yes | 3 | 6 | 763 | 89.3k | 8.9k | 98.9k | $0.0610 | 11s |
| agentx | 4 | yes | 3 | 6 | 767 | 96.6k | 12.0k | 109.4k | $0.0751 | 11s |
| agentx-lean | 4 | yes | 6 | 6 | 990 | 91.0k | 9.7k | 101.7k | $0.0668 | 13s |
| claude | 5 | yes | 3 | 6 | 822 | 89.3k | 8.9k | 99.0k | $0.0618 | 11s |
| agentx | 5 | yes | 3 | 6 | 846 | 96.6k | 12.1k | 109.5k | $0.0761 | 12s |
| agentx-lean | 5 | yes | 3 | 6 | 853 | 90.8k | 9.3k | 100.9k | $0.0637 | 12s |
| claude | 6 | yes | 3 | 6 | 805 | 89.3k | 8.9k | 99.0k | $0.0616 | 11s |
| agentx | 6 | yes | 3 | 6 | 823 | 96.6k | 12.1k | 109.5k | $0.0758 | 12s |
| agentx-lean | 6 | yes | 3 | 6 | 860 | 90.9k | 9.3k | 101.0k | $0.0638 | 12s |
| claude | 7 | yes | 3 | 6 | 732 | 89.3k | 8.8k | 98.9k | $0.0606 | 10s |
| agentx | 7 | yes | 3 | 6 | 956 | 96.6k | 12.2k | 109.8k | $0.0777 | 13s |
| agentx-lean | 7 | yes | 3 | 6 | 853 | 90.9k | 9.2k | 101.0k | $0.0637 | 11s |
| claude | 8 | yes | 3 | 6 | 824 | 89.3k | 8.9k | 99.0k | $0.0619 | 9s |
| agentx | 8 | yes | 3 | 6 | 803 | 96.6k | 12.1k | 109.5k | $0.0756 | 10s |
| agentx-lean | 8 | yes | 3 | 6 | 821 | 90.9k | 9.2k | 100.9k | $0.0632 | 9s |
| claude | 9 | yes | 3 | 6 | 813 | 89.3k | 8.9k | 99.0k | $0.0617 | 8s |
| agentx | 9 | yes | 3 | 6 | 934 | 96.6k | 12.2k | 109.7k | $0.0774 | 11s |
| agentx-lean | 9 | yes | 3 | 6 | 773 | 90.9k | 9.2k | 100.8k | $0.0626 | 9s |
| claude | 10 | yes | 3 | 6 | 730 | 89.3k | 8.8k | 98.9k | $0.0606 | 8s |
| agentx | 10 | yes | 3 | 6 | 740 | 96.6k | 12.0k | 109.3k | $0.0747 | 9s |
| agentx-lean | 10 | yes | 4 | 6 | 953 | 91.0k | 9.4k | 101.4k | $0.0655 | 10s |

Medians per mode:

| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|
| claude | 10/10 | 3 | 99.0k | 89.3k | $0.0617 | 10s |
| agentx | 10/10 | 3 | 109.5k | 96.6k | $0.0762 | 11s |
| agentx-lean | 10/10 | 3 | 100.9k | 90.9k | $0.0637 | 11s |

### Task trace: find the causes of a reported bug across six files

| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 1 | yes | 3 | 6 | 756 | 90.1k | 9.5k | 100.3k | $0.0635 | 9s |
| agentx | 1 | yes | 3 | 6 | 698 | 97.0k | 12.2k | 109.8k | $0.0751 | 9s |
| agentx-lean | 1 | yes | 3 | 6 | 696 | 91.7k | 9.9k | 102.3k | $0.0648 | 10s |
| claude | 2 | yes | 3 | 6 | 775 | 90.1k | 9.5k | 100.4k | $0.0637 | 12s |
| agentx | 2 | yes | 3 | 6 | 715 | 97.5k | 12.6k | 110.8k | $0.0771 | 12s |
| agentx-lean | 2 | yes | 3 | 6 | 737 | 91.2k | 9.3k | 101.2k | $0.0627 | 12s |
| claude | 3 | yes | 3 | 6 | 700 | 90.1k | 9.4k | 100.2k | $0.0627 | 13s |
| agentx | 3 | yes | 3 | 6 | 725 | 97.5k | 12.8k | 111.0k | $0.0779 | 12s |
| agentx-lean | 3 | yes | 3 | 6 | 732 | 91.7k | 9.7k | 102.2k | $0.0645 | 12s |
| claude | 4 | yes | 3 | 6 | 815 | 89.6k | 9.1k | 99.5k | $0.0623 | 12s |
| agentx | 4 | yes | 3 | 6 | 745 | 97.5k | 12.6k | 110.8k | $0.0774 | 12s |
| agentx-lean | 4 | yes | 5 | 8 | 992 | 125.4k | 9.8k | 136.3k | $0.0744 | 15s |
| claude | 5 | yes | 3 | 6 | 784 | 90.1k | 9.5k | 100.4k | $0.0638 | 12s |
| agentx | 5 | yes | 3 | 6 | 680 | 97.0k | 12.2k | 109.8k | $0.0749 | 12s |
| agentx-lean | 5 | yes | 3 | 6 | 701 | 91.2k | 9.3k | 101.2k | $0.0623 | 12s |
| claude | 6 | yes | 3 | 6 | 742 | 90.1k | 9.4k | 100.3k | $0.0632 | 12s |
| agentx | 6 | yes | 3 | 6 | 673 | 97.5k | 12.6k | 110.7k | $0.0765 | 12s |
| agentx-lean | 6 | yes | 3 | 6 | 714 | 91.2k | 9.3k | 101.2k | $0.0625 | 12s |
| claude | 7 | yes | 6 | 12 | 1.1k | 194.3k | 10.9k | 206.3k | $0.0937 | 14s |
| agentx | 7 | yes | 3 | 6 | 688 | 97.0k | 12.2k | 109.8k | $0.0750 | 10s |
| agentx-lean | 7 | yes | 4 | 8 | 903 | 126.7k | 10.1k | 137.7k | $0.0749 | 12s |
| claude | 8 | yes | 3 | 6 | 739 | 90.1k | 9.4k | 100.3k | $0.0632 | 11s |
| agentx | 8 | yes | 4 | 8 | 821 | 135.3k | 13.0k | 149.1k | $0.0871 | 12s |
| agentx-lean | 8 | yes | 3 | 6 | 707 | 91.7k | 9.8k | 102.3k | $0.0648 | 10s |
| claude | 9 | yes | 3 | 6 | 753 | 90.1k | 9.5k | 100.3k | $0.0634 | 9s |
| agentx | 9 | yes | 3 | 6 | 797 | 97.5k | 12.7k | 111.0k | $0.0782 | 10s |
| agentx-lean | 9 | yes | 3 | 6 | 670 | 91.2k | 9.3k | 101.1k | $0.0620 | 9s |
| claude | 10 | yes | 3 | 6 | 667 | 90.1k | 9.6k | 100.4k | $0.0631 | 9s |
| agentx | 10 | yes | 4 | 8 | 806 | 133.9k | 13.3k | 148.0k | $0.0881 | 11s |
| agentx-lean | 10 | yes | 3 | 6 | 705 | 91.7k | 9.7k | 102.2k | $0.0643 | 11s |

Medians per mode:

| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|
| claude | 10/10 | 3 | 100.3k | 90.1k | $0.0633 | 12s |
| agentx | 10/10 | 3 | 110.8k | 97.5k | $0.0772 | 12s |
| agentx-lean | 10/10 | 3 | 102.2k | 91.7k | $0.0644 | 12s |

Against the bare CLI (AgentX median over bare median, 95% bootstrap interval; every run counts):

| Metric | Mode | Task | Runs (AgentX/bare) | Ratio | 95% interval | Verdict |
|---|---|---|---|---|---|---|
| tokens | agentx | fix-bugs | 10/10 | 1.10 (+10%) | 1.10 to 1.10 | uses more |
| tokens | agentx | implement | 10/10 | 1.11 (+11%) | 1.11 to 1.11 | uses more |
| tokens | agentx | trace | 10/10 | 1.10 (+10%) | 1.09 to 1.29 | uses more |
| tokens | agentx | all tasks | 30/30 | 1.10 (+10%) | 1.10 to 1.16 | uses more |
| tokens | agentx-lean | fix-bugs | 10/10 | 1.02 (+2%) | 1.02 to 1.28 | uses more |
| tokens | agentx-lean | implement | 10/10 | 1.02 (+2%) | 1.02 to 1.02 | uses more; within 10% |
| tokens | agentx-lean | trace | 10/10 | 1.02 (+2%) | 1.01 to 1.19 | uses more |
| tokens | agentx-lean | all tasks | 30/30 | 1.02 (+2%) | 1.01 to 1.10 | uses more |
| cost | agentx | fix-bugs | 10/10 | 1.21 (+21%) | 1.19 to 1.22 | costs more |
| cost | agentx | implement | 10/10 | 1.24 (+24%) | 1.22 to 1.26 | costs more |
| cost | agentx | trace | 10/10 | 1.22 (+22%) | 1.19 to 1.30 | costs more |
| cost | agentx | all tasks | 30/30 | 1.22 (+22%) | 1.21 to 1.25 | costs more |
| cost | agentx-lean | fix-bugs | 10/10 | 1.02 (+2%) | 1.00 to 1.13 | costs more |
| cost | agentx-lean | implement | 10/10 | 1.03 (+3%) | 1.01 to 1.05 | costs more; within 10% |
| cost | agentx-lean | trace | 10/10 | 1.02 (+2%) | 0.98 to 1.10 | no clear difference; within 10% |
| cost | agentx-lean | all tasks | 30/30 | 1.02 (+2%) | 1.01 to 1.06 | costs more; within 10% |

Model: claude-sonnet-5-5. Runs per mode: 10.

### Task trace: find the causes of a reported bug across six files

| Mode | Run | Correct | Turns | Input | Output | Cache read | Cache write | Total tokens | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|---|---|---|---|
| claude | 1 | yes | 3 | 6 | 747 | 90.1k | 9.4k | 100.3k | $0.0633 | 10s |
| agentx | 1 | yes | 3 | 6 | 674 | 100.7k | 12.6k | 113.9k | $0.0772 | 10s |
| agentx-lean | 1 | yes | 3 | 6 | 701 | 91.7k | 9.7k | 102.2k | $0.0643 | 10s |
| claude | 2 | yes | 4 | 8 | 832 | 124.4k | 9.8k | 135.0k | $0.0725 | 12s |
| agentx | 2 | yes | 3 | 6 | 709 | 100.7k | 12.6k | 114.0k | $0.0776 | 10s |
| agentx-lean | 2 | yes | 3 | 6 | 729 | 91.7k | 9.9k | 102.4k | $0.0652 | 10s |
| claude | 3 | yes | 4 | 8 | 746 | 124.0k | 10.4k | 135.2k | $0.0741 | 11s |
| agentx | 3 | yes | 4 | 8 | 757 | 138.2k | 13.3k | 152.2k | $0.0883 | 10s |
| agentx-lean | 3 | yes | 6 | 12 | 1.1k | 196.0k | 10.8k | 207.9k | $0.0931 | 14s |
| claude | 4 | yes | 3 | 6 | 767 | 90.1k | 9.6k | 100.5k | $0.0641 | 10s |
| agentx | 4 | yes | 6 | 12 | 1.0k | 216.1k | 13.1k | 230.2k | $0.1057 | 14s |
| agentx-lean | 4 | yes | 5 | 8 | 950 | 125.3k | 10.8k | 137.0k | $0.0776 | 12s |
| claude | 5 | yes | 4 | 8 | 812 | 124.4k | 9.8k | 135.0k | $0.0721 | 12s |
| agentx | 5 | yes | 6 | 12 | 1.1k | 218.5k | 14.1k | 233.7k | $0.1109 | 18s |
| agentx-lean | 5 | yes | 3 | 6 | 730 | 91.7k | 9.7k | 102.2k | $0.0646 | 10s |
| claude | 6 | yes | 4 | 8 | 796 | 124.0k | 10.7k | 135.5k | $0.0755 | 10s |
| agentx | 6 | yes | 4 | 8 | 796 | 138.2k | 13.3k | 152.2k | $0.0887 | 12s |
| agentx-lean | 6 | yes | 3 | 6 | 686 | 91.7k | 9.7k | 102.1k | $0.0640 | 10s |
| claude | 7 | yes | 3 | 6 | 708 | 90.1k | 9.4k | 100.2k | $0.0628 | 10s |
| agentx | 7 | yes | 4 | 8 | 798 | 139.5k | 12.9k | 153.2k | $0.0875 | 13s |
| agentx-lean | 7 | yes | 3 | 6 | 741 | 91.7k | 9.7k | 102.2k | $0.0646 | 11s |
| claude | 8 | yes | 5 | 8 | 1.0k | 124.4k | 10.1k | 135.5k | $0.0756 | 12s |
| agentx | 8 | yes | 3 | 6 | 706 | 100.7k | 12.6k | 114.0k | $0.0776 | 10s |
| agentx-lean | 8 | yes | 4 | 8 | 812 | 126.6k | 10.1k | 137.5k | $0.0738 | 11s |
| claude | 9 | yes | 3 | 6 | 716 | 90.1k | 9.6k | 100.4k | $0.0635 | 9s |
| agentx | 9 | yes | 6 | 12 | 1.0k | 216.6k | 13.6k | 231.2k | $0.1077 | 13s |
| agentx-lean | 9 | yes | 4 | 8 | 813 | 126.6k | 10.1k | 137.5k | $0.0738 | 13s |
| claude | 10 | yes | 3 | 6 | 658 | 90.1k | 9.6k | 100.3k | $0.0629 | 10s |
| agentx | 10 | yes | 3 | 6 | 684 | 100.2k | 12.2k | 113.0k | $0.0756 | 9s |
| agentx-lean | 10 | yes | 3 | 6 | 728 | 91.7k | 9.7k | 102.1k | $0.0644 | 10s |

Medians per mode:

| Mode | Correct | Turns | Total tokens | Cache read | Cost (CLI) | Wall |
|---|---|---|---|---|---|---|
| claude | 10/10 | 3.5 | 117.7k | 107.1k | $0.0681 | 10s |
| agentx | 10/10 | 4 | 152.2k | 138.2k | $0.0879 | 11s |
| agentx-lean | 10/10 | 3 | 102.3k | 91.7k | $0.0649 | 10s |

Against the bare CLI (AgentX median over bare median, 95% bootstrap interval; every run counts):

| Metric | Mode | Task | Runs (AgentX/bare) | Ratio | 95% interval | Verdict |
|---|---|---|---|---|---|---|
| tokens | agentx | trace | 10/10 | 1.29 (+29%) | 0.84 to 1.96 | no clear difference |
| tokens | agentx-lean | trace | 10/10 | 0.87 (-13%) | 0.76 to 1.37 | no clear difference |
| cost | agentx | trace | 10/10 | 1.29 (+29%) | 1.07 to 1.56 | costs more |
| cost | agentx-lean | trace | 10/10 | 0.95 (-5%) | 0.87 to 1.16 | no clear difference |

# Session briefing

Open **Briefing** (`/monitor`) in the dashboard. It combines reviews from the
primary daemon, configured dashboard daemons, and discovered mesh peers. Every
participating daemon must run a version with the monitor; unavailable or older
nodes remain visibly unavailable.

Set **Time available** and **Focus today**. The default is 15 minutes and normal
focus. The page presents at most three human actions within that budget. Estimated
minutes are guidance, not measured effort. Urgent work beyond capacity stays
counted in the deferred section. Agent follow-ups are separate from actions that
need you. Nothing is executed automatically. Mark actions done, defer them, or
bring them back; those choices persist on the owning node. Capacity preferences
are saved in this browser. Exact duplicate action text within the same node and session is grouped;
marking it updates all grouped occurrences. Broader semantic duplicates may remain.

The capacity band shows how much of the budget the selected actions consume, and
flags urgent work that did not fit. The three most recent session briefings are
listed initially; the rest sit behind one row. Each briefing carries counts for
warnings, decisions, round trips and context notes; expanding it shows the findings
themselves with evidence, task links, and related running tasks.

## Automatic AgentX reviews

With SQLite available, each newly ended task trace enters a durable review queue.
The queue checks every five seconds, runs one reviewer at a time, and resumes
pending reviews after daemon restart. Installation does not backfill old history.
Failed reviews remain visible and can be retried explicitly. Monitoring is separate
from agent execution and does not delay the task's response.

The reviewer uses the installed Claude CLI with the premium `opus` alias by default.
Set `AGENTX_MONITOR_MODEL` on the daemon to your preferred highest-capability model
ID or alias. Claude CLI authentication must be available to the daemon account.
Model access is account-dependent; the monitor does not claim to benchmark models
across vendors or silently downgrade when access fails. Each review displays its
requested model. Reviews consume the configured provider's quota.

The reviewer has no tools or MCP servers, disables hooks, uses an isolated temporary
working directory, and receives bounded trace evidence over stdin. It reviews the
prompt, final response and last 60 trace steps, not the complete native transcript.
It must state coverage limitations, cite evidence, and distinguish observations
from uncertainty. Context suggestions do not modify session files or memory.

## Open external CLIs

Under **Connect a CLI session**, select a node and discover its CLIs. Recognized
Claude, Codex, Gemini and OpenCode executables and common Node launchers can be registered. Discovery
is limited to processes owned by the daemon account. Other launchers and CLIs can
be registered manually. A PID is not a native session ID and does not identify a
turn boundary. Registering a process alone cannot read its terminal or transcript.

Claude sessions already using AgentX attach hooks are also listed by their native
session ID. Register one of these and future prompt/stop hooks automatically queue
reviews. This path captures the user prompt and final assistant response only.
The adapter uses the documented [Claude hook payloads](https://code.claude.com/docs/en/hooks).
Repeated stop delivery is deduplicated. It does not attach an agent identity, alter
hook behavior, or take control of the CLI.

For other runtimes, register the native ID and invoke the generic command from the
runtime's stop callback or your CLI wrapper:

```sh
agentx monitor register --session SESSION_ID --runtime codex --label 'Release work'
agentx monitor ended --session SESSION_ID --run UNIQUE_TURN_ID --transcript /path/to/transcript.jsonl
```

Use a stable run ID for retries and a new ID for each actual turn. Only the last
90 KB of the local transcript file is submitted. This adapter works with text,
JSON, or JSONL; it does not install vendor-specific hooks. A transcript can also
be submitted directly in the dashboard. Set `AGENTX_DAEMON_URL` and `MESH_TOKEN`
for a remote daemon, or pass `--url`. Configure hooks on the node owning the CLI.

The HTTP equivalents are `POST /monitor/register` with `{id,runtime,label}` and
`POST /monitor/ended` with `{sessionId,runId,transcript}`. Both use existing mesh
authentication. The dashboard proxies only known node URLs and keeps tokens out
of browser payloads. Run reviews begin only after registration.

The briefing lists the 100 most recent reviews per node. Outstanding actions are
queried independently across all stored reviews, initially 500 per node. Use
**Load older outstanding actions**, inside the deferred row, to view the rest of the
backlog; the expanded view pauses automatic refresh until you press Refresh.

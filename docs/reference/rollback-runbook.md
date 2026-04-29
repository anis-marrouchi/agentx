# AgentX rollback runbook

Operational recipes for reverting agentx when things misbehave in production.
This doc covers WHAT to run; WHY each lever exists is documented in the
architecture notes (private).

## Decision tree — which lever to pull

```
production is misbehaving
│
├── single dispatch source acting up?
│   └── pull lever 1: per-source flag to "off"
│
├── ledger producing wrong decisions in shadow mode?
│   └── pull lever 2: system-wide flag back to "shadow" or "off"
│
├── recent deploy actively breaking things, levers 1+2 didn't help?
│   └── pull lever 3: revert to last good commit
│
└── catastrophic failure, repo state untrustworthy?
    └── pull lever 4: hard reset to v0.18.0-pre-rescue tag
```

Pull the lowest-numbered lever that fits. Don't reach for lever 4 first.

---

## Lever 1 — Per-source flag flip

When the intent ledger is authoritative for a specific source (gitlab,
workflow, telegram, cron, mesh) and that source starts misbehaving, fall
back to the legacy dispatch path for just that source. Other sources keep
running on the ledger.

```bash
ssh -i ~/.ssh/id_mac clawd@64.226.102.124 \
  "sudo systemctl set-environment INTENT_LEDGER_FALLBACK=1 && \
   sudo systemctl set-environment INTENT_LEDGER_SOURCES_GITLAB=off && \
   sudo systemctl restart agentx"
```

Replace `GITLAB` with the misbehaving source name. Verify:

```bash
ssh -i ~/.ssh/id_mac clawd@64.226.102.124 \
  "sudo journalctl -u agentx --since '30 seconds ago' | grep -E 'ledger.*source.*gitlab.*off|legacy fallback'"
```

To re-enable: unset the env var via `sudo systemctl unset-environment INTENT_LEDGER_SOURCES_GITLAB` and restart.

## Lever 2 — System-wide ledger mode flip

When the ledger as a whole is misbehaving (divergence reports look wrong,
write contention is high, schema migration went sideways).

```bash
# Back to shadow (still recording, but legacy decides):
ssh -i ~/.ssh/id_mac clawd@64.226.102.124 \
  "sudo systemctl set-environment INTENT_LEDGER_MODE=shadow && \
   sudo systemctl restart agentx"

# Or fully off:
ssh -i ~/.ssh/id_mac clawd@64.226.102.124 \
  "sudo systemctl set-environment INTENT_LEDGER_MODE=off && \
   sudo systemctl restart agentx"
```

Verify:

```bash
ssh -i ~/.ssh/id_mac clawd@64.226.102.124 \
  "curl -sS http://localhost:19900/health 2>/dev/null && \
   sudo journalctl -u agentx --since '1 minute ago' | grep -i 'intent.ledger.mode'"
```

## Lever 3 — Revert recent commit

When a specific commit broke things and lever 1 or 2 doesn't help.

```bash
# On the workstation
git log --oneline -10
git revert <bad-commit>
npm run build
rsync -avz --delete -e "ssh -i ~/.ssh/id_mac" \
  /Users/macbookpro/Developer/noqta/agentx/dist/ \
  clawd@64.226.102.124:/home/clawd/agentx/dist/
ssh -i ~/.ssh/id_mac clawd@64.226.102.124 \
  "sudo systemctl restart agentx && sleep 5 && sudo systemctl is-active agentx"
```

Pushing the revert to origin can wait — get production healthy first, then `git push`.

## Lever 4 — Hard reset to pre-rescue tag

Catastrophic. Use only when repo state is untrustworthy and the rescue
work needs to be wholesale undone. Loses uncommitted local work.

```bash
# On the workstation
git fetch --tags origin
git status                                    # confirm what's about to be lost
git stash push -m "pre-rollback"              # save anything uncommitted
git reset --hard v0.18.0-pre-rescue
npm run build
rsync -avz --delete -e "ssh -i ~/.ssh/id_mac" \
  /Users/macbookpro/Developer/noqta/agentx/dist/ \
  clawd@64.226.102.124:/home/clawd/agentx/dist/
ssh -i ~/.ssh/id_mac clawd@64.226.102.124 \
  "sudo systemctl restart agentx && sleep 5 && \
   sudo journalctl -u agentx --since '30 seconds ago' --no-pager | tail -20"
```

After production is healthy, decide what to do with the stashed work
(`git stash list`, `git stash pop`, etc.). Do not rush this decision.

Note: a hard reset rewrites local master. If `master` is already pushed
past the tag, force-pushing to origin overrides the remote and is
destructive to anyone else who fetched. Coordinate before
`git push --force origin master`.

---

## Reading divergence reports during shadow mode

When the ledger is in `mode=shadow`, every dispatch produces both a
ledger decision and a legacy outcome. Mismatches are logged with the
prefix `[ledger-divergence]`.

```bash
ssh -i ~/.ssh/id_mac clawd@64.226.102.124 \
  "sudo journalctl -u agentx --since '1 hour ago' | grep '\\[ledger-divergence\\]'"
```

A small number of mismatches during the first 24h after enabling shadow
is expected (the ledger sees events the legacy path missed, and vice
versa). Persistent or growing mismatch counts mean the ledger logic
needs work before promoting any source to authoritative.

---

## Health check shortcut

```bash
ssh -i ~/.ssh/id_mac clawd@64.226.102.124 \
  "sudo systemctl is-active agentx && \
   curl -sS http://localhost:19900/health && \
   sudo journalctl -u agentx --since '1 minute ago' | grep -iE 'error|fail|crashed' | head -5"
```

Active service + responsive HTTP + no recent error lines = healthy.
Anything else = investigate before applying any rollback.

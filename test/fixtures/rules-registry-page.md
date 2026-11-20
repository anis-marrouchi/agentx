---
title: "Rules Registry"
type: decision
owner: pm-agent
access: public
created: 2026-11-15
last_updated: 2026-11-20
---

# Rules Registry

Mirrors the live page of 2026-11-20 (21 rows): every Scope cell and the
shape of every "Applies to" cell are as written there. People, client and
channel names are replaced (the repository is public).

## The rules

| Rule | Scope | Applies to | Decided | Enforced in | Check |
|---|---|---|---|---|---|
| [[Keep Things Moving Fleet Rule Decision]]: one home, owner, status | fleet | everyone | owner 2026-10-17 | each agent CLAUDE.md | COO, Mondays |
| [[Every New Issue Is Complete When It Is Created]]: estimate, milestone, checklist | fleet | anyone who creates a GitLab issue | owner 2026-11-11 | global CLAUDE.md | PM at triage |
| Planner block tracking: each planner block has one tracking issue | team | every team member whose week is planned; not the owner until he enrols | owner 2026-11-10 | planner build | PM, each planned day |
| [[Workflow Changes Are Built Inside the Existing AgentX Workflow]] | fleet | any change to how work flows | owner 2026-11-07 | skill | PM at review |
| [[Team Words Are the Standard for Everyone]] | fleet | all writing about people's work | owner 2026-11-10 | local CLAUDE.md files | word list owner |
| Clean up before reporting done (stop own dev servers, browsers, scripts) | mesh:MacBook-Local | every local agent | owner 2026-10-25 | global CLAUDE.md | none yet |
| Open every reply to the owner with its subject | fleet | every reply to or relayed to the owner | owner 2026-11-04 | global CLAUDE.md | none yet |
| No guessed times: a due time comes from the doer, the owner or a real fact | fleet | every agent giving a time | owner 2026-11-14 | global CLAUDE.md | R8 weekly score |
| **R4** No due time without a check time | fleet | every agent | owner 2026-11-15 | global CLAUDE.md | R8 weekly score |
| **R5** Standing orders become standing jobs, never closed as done | fleet | every agent receiving "every day / every week" | owner 2026-11-15 | global CLAUDE.md | R8 weekly score |
| A schedule wakes an agent, it never runs a script | fleet | every agent that creates or owns a scheduled job | owner 2026-11-17 | schedules | PM |
| **R1** One owner per channel for "no empty day" | project:Channel One; project:Channel Two | Nadia | owner 2026-11-15 | Nadia's CLAUDE.md | R3 daily watch |
| **R2** 5 days of stock; below that, the next batch starts the same day | project:Channel One; project:Channel Two | Nadia | owner 2026-11-15 | Nadia's CLAUDE.md | R3 daily watch |
| **R3** Daily stock watch inside an AgentX workflow | run:daily | Nadia (the channel workflow runs as marketing-agent) | owner 2026-11-15 | AgentX workflow | Workflows page |
| **R6** Monthly plan and cost cap per channel, one yes | project:Channel One; project:Channel Two | Nadia asks, the owner approves (monthly) | owner 2026-11-15 | Nadia's CLAUDE.md | 7 days before month end |
| **R7** Posting runs off the Mac, sign-in check each morning | project:Channel One; project:Channel Two | DevOps | owner 2026-11-15 | rented server | R3 daily watch |
| **R8** Weekly score, Monday | run:weekly | Hakim | owner 2026-11-15 | channel workflow node | the owner reads it |
| [[YouTube Publish Approval Rule]] | project:AgentX YouTube | agentx-channel | see article | see article | see article |
| [[Team Member WhatsApp Writing Rule]] | agent:cx-agent; agent:pm-agent | CX, Hakim (messages to a team member) | see article | see article | see article |
| [[Decision: Add Verifiable-Success-Criteria Rule to All Agents]] | mesh:Clawd Server | clawd agents | see article | see article | see article |
| The owner's word comes first | agent:pm-agent | Hakim | owner 2026-11-07 | pm-workspace CLAUDE.md | the owner |

## How to add a rule

1. One row per rule.

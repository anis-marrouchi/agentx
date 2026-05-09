---
title: "Workflows — when, why, and when NOT"
---

# Workflows — when, why, and when NOT

> **Honest disclaimer up front:** for ~95% of use cases, **an agent with a good prompt + tool calls beats a workflow.** Reach for workflows only when one of three specific things is true. If you're not sure, write a prompt first. Workflows are a power tool, not a default.

This page exists because workflows are the most-asked-about and least-understood feature in AgentX. It's a real, sharp tool — but a wrong one for most jobs. Here's the 30-second decision tree, three cases where workflows actually beat an agent prompt, three runnable examples, and a list of times you should *not* reach for workflows.

## The 30-second decision tree

Ask these three questions in order. **First yes wins.** If all three are no, skip workflows entirely.

1. **Does this procedure pause and wait — for a human, a timer, or an external signal — for hours, days, or weeks?** (e.g., "send onboarding email, wait 24h, send reminder if no signup, wait 7d, escalate to AM")
2. **Does this involve cross-agent or cross-channel state that must survive a daemon restart and be replayable?** (e.g., GitLab MR opens → reviewer agent runs → human approves on Slack → deployment agent ships)
3. **Does the procedure need to be operator-visible as a diagram so non-technical staff can audit and edit it?** (e.g., a PM who wants to see "step 1 sends form, step 2 routes by label, step 3 calls HubSpot")

If none of these is yes — **write an agent prompt instead.** It will be:
- 10× shorter
- Easier to debug (one prompt, one chat, one trace)
- Faster to iterate (edit prompt, re-test in seconds)
- More LLM-native (the model is the engine, not a node type)

## Three cases where workflows actually win

These are the only three cases where the agent-prompt alternative breaks down.

### Case 1: Pause-and-resume across days/weeks

An agent loop cannot reliably wait 5 days for a Telegram user to fill out a form, with reminders. Workflows can — `userTask` + `signal.wait` + `timer.boundary` give you durable pause points that survive restarts.

### Case 2: Cross-agent / cross-channel state

When a procedure spans agents and channels (GitLab webhook → reviewer agent → human on Slack → deployment agent → channel send) and each step needs to be replayable, workflows give you persisted run state and trace replay. An agent prompt can't carry state through three different processes.

### Case 3: Operator-visible procedure

When a non-technical operator needs to *see* what the procedure does, a DAG in the visual editor is more honest than a 400-line prompt. The diagram *is* the documentation; an agent prompt is a wall of text.

## Three worked examples

### Example 1 — Lead capture from Telegram → HubSpot (Case 1: pause-resume)

**The pain without workflows.** A single agent that classifies a message and pushes to HubSpot is fine — *until* the lead doesn't include their email and you need to ask, wait, and resume. An agent loop that's "stuck waiting for a reply" is fragile: the daemon restarts, the prompt context drifts, the agent forgets it was waiting.

**The workflow win.** [`examples/workflows/lead-capture.yaml`](../examples/workflows/lead-capture.yaml) ships a runnable version. The workflow:

1. Triggers on a Telegram message in a specific chat
2. Runs a classifier agent (sales / support / newsletter / other)
3. Branches on the result — "sales" routes to extraction, anything else replies with a generic ack
4. Extracts `{name, email, company}` via `extract.structured`
5. Pushes to HubSpot via a registered action
6. Replies on the same Telegram thread

```yaml
# (excerpt — full file at examples/workflows/lead-capture.yaml)
id: lead-capture
nodes:
  - id: start
    type: trigger.channel
    config: { source: telegram-message, filter: { chatId: "-1001234567890" } }

  - id: classify
    type: agent
    config:
      agentId: lead-classifier
      prompt: |
        Classify into: sales | support | newsletter | other.
        Reply RESULT: <category>.
        Message: {{start.text}}

  - id: route
    type: branch
    config:
      cases:
        - when: { kind: equals, params: { path: classify.result, value: sales } }
          to: extract
      default: ack_only

  - id: extract
    type: action.builtin
    config:
      name: extract.structured
      input:
        text: "{{start.text}}"
        schema:
          type: object
          properties:
            name:    { type: string }
            email:   { type: string }
            company: { type: string }
          required: [email]

  - id: push_to_hubspot
    type: action.run
    config:
      actionId: hubspot-create-contact
      inputs:
        email:     "{{extract.data.email}}"
        firstname: "{{extract.data.name}}"
        company:   "{{extract.data.company}}"

  - id: reply_sales
    type: action.send
    config:
      channel: "{{start.channel}}"
      chatId:  "{{start.chatId}}"
      text: "Thanks {{extract.data.name}} — we'll be in touch shortly."
```

**Try it:**
```
agentx workflow validate examples/workflows/lead-capture.yaml
agentx workflow run lead-capture --watch
```

**When you do NOT need a workflow for this**: if your lead messages always include name + email in one shot and you don't need to retry HubSpot calls or branch on intent, **write an agent prompt** that does the same thing in 8 lines. The workflow is *only* worth it when (a) the action call must retry on flakes, (b) you need an audit trail of "which lead became a HubSpot contact," and (c) you'll add user tasks (form-fill) later.

---

### Example 2 — GitLab MR review with human-in-the-loop (Case 2: cross-agent state)

**The pain without workflows.** An MR opens. A reviewer agent runs. Sometimes the agent's review is clear-cut (LGTM or fail). Sometimes a human must look. The human is on Slack, not GitLab. After the human's call, the deployment agent should ship — or not. Stuffing this into one prompt: how does the agent know the human said yes hours later? Where's the state stored? What if the daemon restarts mid-review?

**The workflow win.** A workflow ties three independent agents and two channels together with persisted state.

```yaml
id: mr-review
title: GitLab MR review with optional human approval

nodes:
  - id: start
    type: trigger.channel
    config: { source: gitlab-mr-opened }

  - id: review
    type: agent
    config:
      agentId: code-reviewer
      prompt: |
        Review MR !{{start.iid}} in {{start.project}}.
        Decide: lgtm | needs-human | fail
        Reply RESULT: <decision>

  - id: route
    type: branch
    config:
      cases:
        - when: { kind: equals, params: { path: review.result, value: lgtm } }
          to: deploy
        - when: { kind: equals, params: { path: review.result, value: needs-human } }
          to: ask_human
      default: notify_fail

  - id: ask_human
    type: action.send
    config:
      channel: slack
      chatId: "C0123-engineers"
      text: |
        :eyes: MR !{{start.iid}} needs human review.
        Reply `approve {{run.id}}` or `reject {{run.id}}`.

  - id: wait_for_human
    type: signal.wait
    config:
      signalKey: "mr-review:{{run.id}}"
      timeoutMs: 86400000  # 24h

  - id: human_route
    type: branch
    config:
      cases:
        - when: { kind: equals, params: { path: wait_for_human.signal, value: approve } }
          to: deploy
      default: notify_fail

  - id: deploy
    type: agent
    config:
      agentId: deployer
      prompt: "Deploy MR !{{start.iid}} to staging."

  - id: notify_fail
    type: action.send
    config:
      channel: slack
      chatId: "C0123-engineers"
      text: "MR !{{start.iid}} review failed; not deploying."
```

**The win:** the run *survives daemon restart* between `ask_human` and `wait_for_human`. The signal bus persists. When a human types `approve <run-id>` in Slack, the workflow resumes from where it paused. No agent prompt can do that without losing context.

**When you do NOT need a workflow for this**: if you trust the reviewer agent fully (no human in the loop ever), use a single agent that reviews and deploys in one shot. The workflow is *only* earned when human-in-the-loop is real and the wait is hours.

---

### Example 3 — Customer onboarding with multi-day timers (Case 1 + 2)

**The pain without workflows.** A new signup needs: welcome email → 24h timer → if no activity, reminder → 7d timer → if still no activity, escalate to AM. Across 8 days. With reliable replay if the daemon goes down. An agent prompt has zero of these primitives.

**The workflow win.**

```yaml
id: onboarding
title: 7-day onboarding with reminders + escalation

nodes:
  - id: start
    type: trigger.channel
    config: { source: app-signup }

  - id: send_welcome
    type: action.send
    config:
      channel: email
      to: "{{start.email}}"
      subject: "Welcome to AcmeApp"
      body: "..."

  - id: wait_24h
    type: timer.boundary
    config: { delayMs: 86400000 }   # 24h

  - id: check_active
    type: action.builtin
    config:
      name: db.query
      input:
        sql: "SELECT last_active_at FROM users WHERE id = $1"
        params: ["{{start.userId}}"]

  - id: route_24h
    type: branch
    config:
      cases:
        - when: { kind: notNull, params: { path: check_active.rows.0.last_active_at } }
          to: done_active
      default: send_reminder

  - id: send_reminder
    type: action.send
    config:
      channel: email
      to: "{{start.email}}"
      subject: "Quick start guide"
      body: "..."

  - id: wait_7d
    type: timer.boundary
    config: { delayMs: 604800000 }  # 7d

  - id: check_active_2
    type: action.builtin
    config:
      name: db.query
      input:
        sql: "SELECT last_active_at FROM users WHERE id = $1"
        params: ["{{start.userId}}"]

  - id: route_7d
    type: branch
    config:
      cases:
        - when: { kind: notNull, params: { path: check_active_2.rows.0.last_active_at } }
          to: done_active
      default: escalate_am

  - id: escalate_am
    type: action.send
    config:
      channel: slack
      chatId: "C0987-am-team"
      text: "User {{start.email}} signed up 7d ago, 0 activity. Take a look."

  - id: done_active
    type: end
    config: { status: completed }
```

**The win:** 8-day procedure with two independent timers, two database checks, two branches, and durable resume. **No agent loop holds context for 8 days** — the LLM doesn't have that kind of working memory and you'd burn tokens re-deriving state. Workflows pay for themselves the moment the first timer fires.

**When you do NOT need a workflow for this**: if your "onboarding" is a single welcome email and that's it, just call your email API on signup. The workflow earns its keep when the procedure spans days *and* has branching *and* needs the audit trail.

## When you should NOT reach for workflows

Honest list. If any of these is true, write an agent prompt instead — workflows will be a foot-gun.

| Anti-pattern | Use this instead |
|---|---|
| "I want to classify a message and reply" | Agent + prompt + cross-channel `/send`. Done. |
| "I want to extract structured fields and call an API" | `action.builtin` directly from an agent's tool list — no workflow needed. |
| "I want to schedule a job every Monday" | `agentx schedule "every Monday at 9am" --agent X`. Cron. |
| "I want a chatbot that branches on intent" | Agent + prompt with the branches encoded in natural language. The LLM does the routing. |
| "I want to test workflows for the sake of testing them" | Don't. Test agents with prompts; reach for workflows when you have a real durable-procedure pain. |
| "I want a visual diagram of what my agent does" | Diagram an agent's prompt as a flowchart in `docs/`. The flowchart is for humans; the agent runs from the prompt. |

## How to validate this is working

Run this self-audit before adding a workflow to your project:

1. Could I do this with an agent prompt + tool calls? If yes — try the prompt first. Save the workflow for after that fails.
2. Does this run in <60 seconds end-to-end? If yes — one agent. The workflow's pause-resume / state machinery is overhead.
3. Does the operator need to see the procedure as a diagram? If no — keep the workflow file private and use it as code.
4. Is one of the three cases (pause-resume / cross-agent state / operator-visible procedure) *actually true* for this case? If you're hand-waving — it isn't, and you should drop the workflow.

If 4 is no, **write a prompt.** That's the path with the highest ROI for SMB-agency users.

## Further reading

- [Workflows YAML spec](./architecture/workflows-yaml.md) — full schema reference
- [Typed workflow DSL plan](./architecture/typed-workflow-dsl-plan.md) — design rationale
- [`examples/workflows/`](../examples/workflows/) — runnable examples (lead-capture, grant-application, whatsapp-client-support)
- [Karpathy's LLM-Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — the broader philosophy on "the LLM is the engine; don't wrap it in five layers." Workflows are a justified wrapper *only* when the three cases above apply. Most of the time, the LLM-as-engine pattern wins.

---

## A note on this document

This page exists because the AgentX founder said: "I don't get the benefit nor how to use [workflows]." That's the most important signal a feature can get. Workflows are kept in AgentX *not* because they're a default tool, but because the three cases above are real for some users (durable procedures, cross-agent state, operator-visible diagrams). For everyone else — agent prompts win. This doc is the honest answer to "when should I care?"

If after reading this you still don't see when to use workflows for *your* product, the answer is probably **"never."** That's a valid answer. Skip the feature; you won't miss it.

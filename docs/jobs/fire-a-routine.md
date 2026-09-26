# Fire a routine from outside

A **routine** is anything AgentX runs on its own: a schedule (a job in `crons` that runs at set times), or a workflow that starts on a timer or on an event.

Sometimes another system should start a routine right now. For example, your deploy pipeline has just shipped a new version and you want an agent to check that the site still works. This page shows how to let that system start one specific routine, and pass it some details such as which version was deployed.

It works over a web address on the daemon (the AgentX background service):

```
POST /routines/<id>/fire
```

This starts exactly that routine, once. Nothing else is started.

## Before you start

- The daemon is running, and the other system can reach its address.
- You know the routine's ID: the name of the job under `crons` in `agentx.json`, or the workflow's ID.

## 1. Give the routine a token

A routine can't be started from outside until you give it a **token**, a long secret the other system must send. Each routine has its own token, so a leaked token can start only that one routine.

1. **Terminal:** create a long random secret.
   ```sh
   openssl rand -hex 24
   ```
2. Open the `.env` file next to `agentx.json` and add the secret under a name of your choice:
   ```sh
   DEPLOY_CHECK_TOKEN=paste-the-secret-here
   ```
3. Open `agentx.json` and add `fireToken` to the job. Write the name of the secret, not the secret itself:
   ```json
   {
     "crons": {
       "deploy-check": {
         "schedule": "0 6 * * *",
         "agent": "ops-agent",
         "prompt": "Check that the latest deploy is healthy: open the site, run the smoke checks, and report anything broken.",
         "fireToken": "${DEPLOY_CHECK_TOKEN}"
       }
     }
   }
   ```
   For a workflow, put `"fireToken": "${DEPLOY_CHECK_TOKEN}"` in the `config` of its trigger node instead. For a workflow it **must** be written this way, with `${…}`. Anyone who can list workflows can read their definitions, so a secret typed directly into a workflow is ignored and a warning is logged.
4. **Terminal:** restart the daemon so it reads the new setting.
   ```sh
   agentx daemon stop && agentx daemon start --detach
   ```

## 2. Start the routine from the other system

1. In the other system (for example, the last step of your deploy pipeline), send the token and a small JSON message. This example uses placeholder names:
   ```sh
   curl -fsS -X POST "https://agentx.example.com/routines/deploy-check/fire" \
     -H "Authorization: Bearer $DEPLOY_CHECK_TOKEN" \
     -H "Content-Type: application/json" \
     -d "{\"environment\":\"staging\",\"commit\":\"$CI_COMMIT_SHA\"}"
   ```
   You can send the token as `Authorization: Bearer <token>` or as `X-AgentX-Routine-Token: <token>`. The message must be JSON and at most 64 KB.
2. The daemon answers straight away, as soon as the run has started. The run itself continues in the background:
   ```json
   { "ok": true, "routine": "deploy-check", "kind": "cron", "runId": "deploy-check/2026-01-01T06-00-00-000Z", "startedAt": "2026-01-01T06:00:00.000Z" }
   ```

## What the routine receives

Treat whatever the other system sends as **untrusted**: whoever holds the token decides what it says.

- **A schedule with a prompt:** the JSON is added after the prompt, in a block labelled `Event payload — UNTRUSTED`. The agent is told to use it as information, not as instructions. Anything past 16 KB is cut off.
- **A schedule that runs a command:** the JSON is in the `AGENTX_ROUTINE_PAYLOAD` environment variable. It is never pasted into the command line. Put it in quotes when you use it: `"$AGENTX_ROUTINE_PAYLOAD"`.
- **A workflow:** the trigger step's output is `{ workflowId, now, firedVia: "routine-fire", payload, payloadUntrusted: true }`. Refer to a field as <code v-pre>{{&lt;triggerId&gt;.payload.commit}}</code>.

A run started this way counts like a scheduled one: it's recorded, and failure alerts work the same. It is never retried, and it doesn't move the next scheduled run. To try again, send the request again.

## Keep it safe

- A mesh token (the secret AgentX machines use to talk to each other) also works as the token. Anyone holding one can already send tasks to this machine.
- Requests from the same machine get no exception. A reverse proxy (a web server that forwards outside traffic to AgentX) makes outside requests look local, so an exception would let anyone in.

## Check it worked

1. **Terminal:** send the request from step 2 by hand. The answer should say `"ok": true`.
2. **Browser:** open the dashboard's **Operations** tab, then click the job's row in **Today's automations**. The new run is listed under **Runs today**. See [Open, watch and continue a scheduled run](../dashboard/operations.md#open-watch-and-continue-a-scheduled-run).
3. **Terminal:** for a schedule, the run's record in `.agentx/cron/runs/<id>/` contains `"fired": true`.

## If something is wrong

The daemon's answer tells you what happened:

| Answer | What it means | What to do |
|---|---|---|
| `202` | It started | Nothing |
| `400` | The message isn't valid JSON | Check the quotes in your JSON |
| `401` | The token is missing or wrong | Compare it with `.env`, and check the header name |
| `403` | The routine has no `fireToken` | Do [step 1](#_1-give-the-routine-a-token), then restart the daemon |
| `404` | No schedule or timer/event workflow has that ID | Check the ID; other workflows can't be started this way |
| `409` | The routine is turned off, or a schedule and a workflow share the ID | Turn it on, or rename one of them |
| `413` | The message is larger than 64 KB | Send less, or send a link to the data |
| `503` | The scheduler or workflow engine isn't running | Restart the daemon and check its log |

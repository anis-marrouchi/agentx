# Fire a routine from outside

A routine is a schedule (`crons.<id>`) or a workflow that starts on a timer (`trigger.cron`) or an event (`trigger.hook`). Another system, such as a deploy pipeline or a monitor, can start one specific routine right away and give it some JSON to work with:

```
POST /routines/<id>/fire
```

This starts exactly that routine, once. The generic webhooks work differently: `/webhook/<agent>/<source>` sends the event to an agent, and `on:hook` starts every workflow listening for it.

## Allow a routine to be fired

A routine can't be fired until you give it a token. Put the secret in the daemon's environment (for example in `.env`) and reference it from the config. Don't write the secret itself into the config.

For a schedule, in `agentx.json`:

```json
{
  "crons": {
    "deploy-verifier": {
      "schedule": "0 6 * * *",
      "agent": "ops-agent",
      "prompt": "Check that the latest deploy is healthy: open the site, run the smoke checks, and report anything broken.",
      "fireToken": "${DEPLOY_VERIFIER_TOKEN}"
    }
  }
}
```

For a workflow, set `fireToken` in the `config` of its trigger node. It **must** be an env reference such as `"${DEPLOY_VERIFIER_TOKEN}"`, because anyone who can list workflows can read their definitions. A literal value is ignored and a warning is logged.

The daemon reads config at start, so restart it after adding the token.

## Call it

Send the token as `Authorization: Bearer <token>` or `X-AgentX-Routine-Token: <token>`. The body must be JSON and at most 64 KB. Here is a "deploy verifier" step at the end of a CD pipeline. The host and variable names are placeholders:

```sh
curl -fsS -X POST "https://agentx.example.com/routines/deploy-verifier/fire" \
  -H "Authorization: Bearer $DEPLOY_VERIFIER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"environment\":\"staging\",\"commit\":\"$CI_COMMIT_SHA\",\"pipeline\":\"$CI_PIPELINE_URL\"}"
```

The daemon replies `202 Accepted` as soon as the run starts. The run itself continues in the background.

```json
{ "ok": true, "routine": "deploy-verifier", "kind": "cron", "runId": "deploy-verifier/2026-01-01T06-00-00-000Z", "startedAt": "2026-01-01T06:00:00.000Z" }
```

For a schedule, `runId` names the run record under `.agentx/cron/runs/`. That record has `"fired": true`. Like every agent run record there, it also stores `taskId` (the run's Task page ID), `traceId` and, when the runtime reported one, `sessionId`. Runs that were queued, forwarded to another node or answered by an attached session have no `taskId`. See [Open, watch and continue a scheduled run](../dashboard/operations.md#open-watch-and-continue-a-scheduled-run). For a workflow, `runId` is the ID of the workflow run.

| Status | Meaning |
|---|---|
| 202 | Started |
| 400 | The body isn't valid JSON |
| 401 | The token is missing or wrong |
| 403 | The routine has no `fireToken`, so it can't be fired |
| 404 | No schedule or event/timer workflow has that ID |
| 409 | The routine is disabled, or the ID names both a schedule and a workflow |
| 413 | The body is larger than 64 KB |
| 503 | The scheduler or workflow engine isn't running |

## What the routine receives

The body counts as **untrusted**. Whoever holds the token decides what it contains.

- **Scheduled prompt:** the JSON is added after the prompt in a fenced block labelled `Event payload — UNTRUSTED`. The agent is told to treat it as data, not instructions. Anything past 16 KB is cut off.
- **Scheduled command:** the JSON is passed in the `AGENTX_ROUTINE_PAYLOAD` environment variable. It is never inserted into the command line. Quote it if you use it: `"$AGENTX_ROUTINE_PAYLOAD"`.
- **Workflow:** the trigger node's output is `{ workflowId, now, firedVia: "routine-fire", payload, payloadUntrusted: true }`. Refer to the fields as <code v-pre>{{&lt;triggerId&gt;.payload.commit}}</code>.

A fired run is recorded and counted like a scheduled one. Failure alerts and auto-disable work the same way. It is never retried, though, and it doesn't move the next scheduled run. If you want another attempt, fire the routine again.

## Security notes

- Every routine has its own token, so a leaked token can only start that one routine.
- A mesh token (`MESH_TOKEN` or a peer token) also works as the Bearer token. Any holder of one can already send tasks to this node.
- Requests from the same machine get **no** exemption, unlike other mesh endpoints. A reverse proxy usually forwards outside requests from `127.0.0.1`, so an exemption would let anyone through.

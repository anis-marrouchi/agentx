# Watch GitLab work

Connect GitLab when an agent needs to respond to issues, merge requests, comments, or pipeline events. Use a test project and a narrow event set first. Give the agent the smallest token scope that lets it do the job.

::: info In the browser
Open **Settings → Channels** to review the GitLab connection and agent assignment. Trigger one test event in GitLab, then check **Activity** to see whether the event reached AgentX and which agent received it.
:::

A webhook must be able to reach the AgentX daemon. If GitLab shows delivery but AgentX shows nothing, check the webhook URL and daemon status. If AgentX records the event but no answer follows, check the assigned agent and model login. See [It's not answering](../help/its-not-answering.md).

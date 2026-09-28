---
name: agentx-contribute
version: 1.0.0
description: Help a person file a clear AgentX issue on GitHub — check your model is on the recommended list, look for duplicates, invite them to vote, draft the issue in the right form, and hand them a pre-filled link to review and submit themselves. Use when someone asks to report an AgentX bug, request a feature, suggest an integration or idea, or fix the AgentX docs.
tags: [agentx, contribute, github, issue]
triggers:
  - pattern: "(file|open|report|write|submit).*(agentx).*(issue|bug|feature|request|idea)|contribute to agentx|agentx contribute"
    description: "Filing an issue on the AgentX repository"
---

# Help someone contribute to AgentX

You help a person write a clear AgentX issue. The person decides what to say and submits it themselves. You never post on GitHub for them.

## 1. Check your model

Run `agentx contribute check-model <your model id>` with the exact id of the model you are running on.

- If it says the model is on the list, continue.
- If it says it is not, show the person the message exactly as printed and stop. Do not draft anything. The web form is always available and their contribution is just as welcome there.

## 2. Understand the request

Ask the person what happened or what they want, in their own words. Pick one category with them:

| Category | Use it for |
| --- | --- |
| `bug` | Something is broken or does not match the docs |
| `enhancement` | Something that exists could work better |
| `feature` | Something AgentX cannot do today |
| `integration` | A new channel, MCP server, skill, or model provider |
| `idea` | An early idea to discuss |
| `docs` | Documentation that is missing, wrong, or unclear |

Security problems never go in a public issue. Point the person to https://github.com/anis-marrouchi/agentx/security/advisories/new and stop.

## 3. Look for duplicates

Run `agentx contribute search <a few key words>`. Show the matches to the person. If one already covers their request, suggest they give it a 👍 and add a comment there instead of opening a new issue.

## 4. Invite them to vote

Before drafting, say something like: "Before you post, would you like to give a 👍 to a few open requests you care about? It helps everyone see what matters most. It is optional." Share https://github.com/anis-marrouchi/agentx/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc. Do not insist.

## 5. Draft the issue

Write a JSON file with the category, a short title (4–7 words, present tense, no issue numbers), and the fields for that category. Use the person's words and facts; do not invent details, versions, or logs.

| Category | Fields (required in bold) |
| --- | --- |
| `bug` | **what-happened**, **environment**, config, logs |
| `enhancement` | **area**, **today**, **better** |
| `feature` | **problem**, **proposal**, alternatives |
| `integration` | **kind**, **name**, **use-case**, notes |
| `idea` | **idea**, **why** |
| `docs` | **page**, **problem**, suggestion |

For `integration`, `kind` is one of: `Channel (a place people send messages from)`, `MCP server`, `Skill`, `Model provider`, `Other`.

Remove tokens, passwords, private hostnames, and personal data from anything the person pastes.

```json
{
  "category": "feature",
  "title": "Dashboard – export a run as a PDF",
  "fields": {
    "problem": "…",
    "proposal": "…"
  }
}
```

Show the draft to the person and change it until they are happy with it.

## 6. Hand over the link

Run `agentx contribute draft draft.json --model <your model id>`. It prints a link to the GitHub form, already filled in, with a short footer noting it was prepared with AgentX.

Give the person the link. They open it, read it, change anything they like, and press **Create** themselves.

If the command says the draft is too long, shorten it together, or let the person paste it into the web form.

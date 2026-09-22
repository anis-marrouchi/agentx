# Chat from any dashboard page

Requires a running dashboard and daemon plus an agent with a working model connection. See [core setup](../requirements.md#core-setup).

Use **Ask an agent** to ask about what you are looking at without leaving the dashboard. The floating input at the bottom sends your question and opens a conversation drawer; the right-edge **Ask an agent** handle opens the drawer directly.

## Ask a question

1. Open a dashboard page, such as **Monitor** or **Activity**.
2. Open **Ask an agent** and choose an **Agent**. Choose a **Node** when you want to send the request to a mesh peer.
3. Type in the bottom input and send, for example: “Summarize what needs my attention on this page.”
4. Read the reply in the drawer and continue the conversation.

The request includes the page path and tab. Pages that provide richer context also attach their current filters, counts, or visible rows. This is structured page context, not a screenshot or unrestricted browser access. The selected agent handles the request with its configured runtime and tools, so action requests can do real work.

## Continue or start over

Use **History** for stored conversations and **New** for a fresh thread. The browser remembers the selected thread; the conversation itself is stored by the dashboard backend. Close the drawer with its close button or Escape. Drag the panel edge to resize it; use the bottom grip to tuck away the input bar.

If the selector says **agents unavailable**, check the daemon connection. If a remote agent fails, check [mesh connectivity](../jobs/tailscale.md). Model calls use the selected agent's normal provider and billing.

The workflow editor has a separate **Ask AI to build…** assistant that proposes workflow graphs. See [Describe an automation](../automations/describe-it.md) for that flow.

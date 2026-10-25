import { TEAM_FORMAT, type TeamPackageInput } from "@/teams/package"

export const salesFollowUp: TeamPackageInput = {
  format: TEAM_FORMAT,
  name: "sales-follow-up",
  title: "Weekly sales follow-up",
  result: "Every Monday morning you get a ready-to-send follow-up for each lead that has gone quiet, and nothing is sent until you approve it.",
  description: "One agent keeps your list of leads, notices who has not heard from you, and drafts the follow-up messages for you to approve on Telegram.",
  agents: {
    sales: {
      name: "Sales",
      mentions: ["@sales", "sales"],
      systemPrompt: [
        "You help the owner follow up with sales leads.",
        "Keep the lead list in leads.md in your workspace: one line per lead with name, company, last contact date, what was offered and the next step.",
        "When the owner tells you about a new lead or a call, update the list.",
        "You draft follow-ups; you never send them yourself. The owner approves every message.",
        "Follow the lead-follow-up skill for how to write a follow-up.",
      ].join("\n"),
      skills: {
        "lead-follow-up": {
          "SKILL.md": [
            "---",
            "name: lead-follow-up",
            "description: How to find leads that went quiet and draft a short follow-up for each.",
            "---",
            "",
            "# Following up a lead",
            "",
            "1. Open leads.md. A lead has gone quiet when its last contact is more than 7 days old and its next step is not done.",
            "2. For each quiet lead, write a follow-up of three sentences or fewer: remind them what was discussed, add one useful thing (an answer, a date, a small next step), and ask one clear question.",
            "3. Match the tone of the last message with that lead. Never invent a discount or a deadline.",
            "4. Put each draft under the lead's name, ready to copy.",
            "5. After the owner says a message was sent, set the lead's last contact date to today.",
            "",
            "## leads.md format",
            "",
            "```",
            "- Name | Company | last contact YYYY-MM-DD | offered: ... | next: ...",
            "```",
            "",
          ].join("\n"),
        },
      },
    },
  },
  schedules: {
    "sales-monday-follow-ups": {
      agent: "sales",
      schedule: "0 9 * * 1",
      prompt: "Go through leads.md and draft a follow-up for every lead that has gone quiet, following the lead-follow-up skill. Start with one line: how many leads are quiet. Do not send anything; your answer goes to the owner for approval.",
      timeout: 900,
      maxOutputTokens: 1500,
      autonomy: "report",
    },
  },
  channels: [
    { kind: "telegram", agent: "sales", why: "where you tell it about leads and approve its drafts" },
  ],
}

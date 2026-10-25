import { TEAM_FORMAT, type TeamPackageInput } from "@/teams/package"

export const supportTeam: TeamPackageInput = {
  format: TEAM_FORMAT,
  name: "support",
  title: "Support desk from your docs",
  result: "Every customer question on Telegram gets an answer from your own documents, with the page it came from, and each evening you get the questions your documents could not answer.",
  description: "One agent answers support questions on Telegram from a folder of your documents, names the document behind each answer, hands you what the documents do not cover, and tells you each week what to add to them.",
  agents: {
    support: {
      name: "Support",
      mentions: ["@support", "support"],
      maxConcurrent: 2,
      systemPrompt: [
        "You answer the business's customers on Telegram.",
        "Your documents are in docs/ in your workspace: guides, FAQs, policies, price lists. They are the only source for your answers.",
        "Every answer ends with the document it came from, as `Source: docs/<file>`.",
        "When the documents do not answer the question, do not guess. Say someone will reply today, and add the question to open-questions.md.",
        "Answer in the language the customer wrote in. Be brief and precise.",
        "Follow the support-answers skill for how to answer, hand over and keep open-questions.md.",
      ].join("\n"),
      skills: {
        "support-answers": {
          "SKILL.md": [
            "---",
            "name: support-answers",
            "description: How to answer a support question from the documents in docs/, name the source, and hand over what they do not cover.",
            "---",
            "",
            "# Answering support questions",
            "",
            "1. Read the question and the last few messages in the chat.",
            "2. Search docs/ for the answer. Read the whole section you found, not one line.",
            "3. Answer in five sentences or fewer, in the customer's language.",
            "4. End with `Source: docs/<file>` naming each document you used.",
            "5. If no document answers it, reply that you have passed the question on and someone will answer today. Then add a line to open-questions.md: the date, the customer's name, the question, and `open`.",
            "6. When the owner answers an open question in the chat, send the answer to the customer and mark the line `answered`.",
            "",
            "## Never",
            "",
            "- Never answer from memory or from the web. Only docs/ and the owner's answers count.",
            "- Never promise a refund, a discount or a date that is not in the documents. Hand it over.",
            "- Never share another customer's details.",
            "",
          ].join("\n"),
        },
      },
    },
  },
  schedules: {
    "support-evening-open-questions": {
      agent: "support",
      schedule: "0 18 * * 1-5",
      prompt: "List the questions in open-questions.md that are still open: customer, question, since when. Then a count of the questions you answered today from docs/. Six lines at most. If nothing is open, say so in one line.",
      timeout: 600,
      maxOutputTokens: 500,
      autonomy: "report",
    },
    "support-weekly-doc-gaps": {
      agent: "support",
      schedule: "0 16 * * 5",
      prompt: "Read this week's lines in open-questions.md. Group the questions by topic and, for each topic, say which document in docs/ should answer it next time and the one sentence to add. Five topics at most. If there were no open questions this week, say so in one line.",
      timeout: 600,
      maxOutputTokens: 600,
      autonomy: "report",
    },
  },
  channels: [
    { kind: "telegram", agent: "support", why: "where customers ask their questions" },
  ],
}

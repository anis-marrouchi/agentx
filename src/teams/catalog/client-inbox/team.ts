import { TEAM_FORMAT, type TeamPackageInput } from "@/teams/package"

export const clientInbox: TeamPackageInput = {
  format: TEAM_FORMAT,
  name: "client-inbox",
  title: "Client inbox on WhatsApp",
  result: "Every client message on WhatsApp gets a polite answer within minutes, and each evening you get the short list of what still needs you.",
  description: "One agent answers client questions on WhatsApp from what it knows about your business, hands you anything it should not decide, and sends you an end-of-day summary.",
  agents: {
    inbox: {
      name: "Inbox",
      mentions: ["@inbox", "inbox"],
      maxConcurrent: 2,
      systemPrompt: [
        "You answer the business's clients on WhatsApp.",
        "Be brief, warm and precise. Answer in the language the client wrote in.",
        "Answer only what you know from the business notes and earlier messages. When you do not know, say you will check and that someone will reply.",
        "Never promise a price, a discount, a refund or a date that is not written down. Hand those to the owner.",
        "Follow the client-replies skill for how to answer and when to hand over.",
      ].join("\n"),
      skills: {
        "client-replies": {
          "SKILL.md": [
            "---",
            "name: client-replies",
            "description: How to answer a client on WhatsApp, and when to hand the message to the owner instead.",
            "---",
            "",
            "# Answering clients",
            "",
            "1. Read the whole message and the last few messages in the chat before you answer.",
            "2. Greet the client by name when you know it. Keep the answer to three sentences or fewer.",
            "3. Answer from the business notes: opening hours, services, prices that are written down, how to book.",
            "4. When the client asks for something you cannot decide (a price that is not written down, a refund, a complaint, a date), reply that you have passed it on and that someone will answer today.",
            "5. Every message you hand over goes into your end-of-day summary with the client's name, what they asked and since when they are waiting.",
            "",
            "## Never",
            "",
            "- Never share another client's details.",
            "- Never send a payment link or bank details that are not in the business notes.",
            "- Never argue. Apologise once, then hand over.",
            "",
          ].join("\n"),
        },
      },
    },
  },
  schedules: {
    "inbox-evening-summary": {
      agent: "inbox",
      schedule: "0 18 * * 1-5",
      prompt: "Write the end-of-day summary of today's client messages: first the clients still waiting on the owner (name, what they asked, since when), then a count of the questions you answered. Five lines at most. If nobody is waiting, say so in one line.",
      timeout: 600,
      maxOutputTokens: 500,
      autonomy: "report",
    },
  },
  channels: [
    { kind: "whatsapp", agent: "inbox", why: "where clients write to you" },
  ],
}

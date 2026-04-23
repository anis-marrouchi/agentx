import { defineConfig } from "vitepress"
import { withMermaid } from "vitepress-plugin-mermaid"

export default withMermaid(defineConfig({
  title: "AgentX",
  description: "The AI operations layer for small & medium businesses. Route Telegram, WhatsApp, Slack, Discord, GitLab, crons, webhooks, and mesh tasks to AI agents on Claude, OpenAI, or any LLM. Web wizard for non-technical operators, CLI for engineers. Self-hosted.",
  lastUpdated: true,
  cleanUrls: true,

  head: [
    ["link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#0ea5e9" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "AgentX — AI operations layer for small & medium businesses" }],
    ["meta", { property: "og:description", content: "Plug in Telegram, WhatsApp, Slack, Discord, or GitLab. Set schedules. Watch your agents work. Web wizard for non-technical operators, CLI for engineers. Self-hosted." }],
  ],

  themeConfig: {
    logo: "/logo.png",
    siteTitle: "AgentX",

    nav: [
      { text: "Install", link: "/install" },
      { text: "Concepts", link: "/concepts" },
      { text: "Journey", link: "/journey/01-telegram-qa-bot" },
      { text: "Reference", link: "/reference/cli" },
      { text: "Blog ↗", link: "https://noqta.tn/en/blog" },
      { text: "GitHub", link: "https://github.com/anis-marrouchi/agentx" },
    ],

    sidebar: {
      "/": [
        {
          text: "Start here",
          items: [
            { text: "What is AgentX?", link: "/" },
            { text: "Install", link: "/install" },
            { text: "Concepts", link: "/concepts" },
          ],
        },
        {
          text: "Journey (simple → advanced)",
          items: [
            { text: "1. Telegram Q&A bot", link: "/journey/01-telegram-qa-bot" },
            { text: "2. Scheduled reports", link: "/journey/02-scheduled-reports" },
            { text: "3. Multi-agent group", link: "/journey/03-multi-agent-group" },
            { text: "4. Cross-channel · planned", link: "/journey/04-cross-channel" },
            { text: "5. Hooks & webhooks · planned", link: "/journey/05-hooks-webhooks" },
            { text: "6. Shared wiki", link: "/journey/06-shared-wiki" },
            { text: "7. Business layer", link: "/journey/07-business-layer" },
            { text: "8. Mesh federation", link: "/journey/08-mesh-federation" },
            { text: "9. Deterministic services · planned", link: "/journey/09-deterministic-services" },
            { text: "10. MCP server · planned", link: "/journey/10-mcp-server" },
            { text: "11. Production hardening · planned", link: "/journey/11-production-hardening" },
          ],
        },
        {
          text: "Reference",
          items: [
            { text: "CLI", link: "/reference/cli" },
            { text: "Config schema", link: "/reference/config-schema" },
            { text: "Communication matrix", link: "/reference/communication-matrix" },
            { text: "Context strategies", link: "/reference/context-strategies" },
            { text: "WhatsApp as a data source", link: "/reference/whatsapp-ingest" },
            { text: "Telegram without the jargon", link: "/reference/telegram-setup" },
            { text: "Boards (Kanban)", link: "/reference/boards" },
            { text: "Slack channel", link: "/reference/slack" },
            { text: "Scoped API tokens", link: "/reference/tokens" },
            { text: "Public agents", link: "/reference/public-agents" },
            { text: "Intent knowledge graph", link: "/reference/graph" },
            { text: "Workflows", link: "/reference/workflows" },
            { text: "Tailscale mesh VPN", link: "/reference/tailscale-setup" },
            { text: "agentx doctor", link: "/reference/doctor" },
          ],
        },
        {
          text: "Roadmap",
          items: [
            { text: "What's next", link: "/roadmap/whats-next" },
            { text: "UX v2 — zero manual config edits", link: "/roadmap/ux-v2" },
            { text: "Business layer v2", link: "/roadmap/business-layer-v2" },
          ],
        },
        {
          text: "Meta",
          items: [
            { text: "Migrate from OpenClaw", link: "/migration/from-openclaw" },
            { text: "Contributing", link: "/contributing" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/anis-marrouchi/agentx" },
      { icon: "twitter", link: "https://twitter.com/anis_marrouchi" },
    ],

    editLink: {
      pattern: "https://github.com/anis-marrouchi/agentx/edit/master/docs/:path",
      text: "Edit this page on GitHub",
    },

    search: {
      provider: "local",
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "© 2025–present Anis Marrouchi",
    },
  },

  mermaid: {
    theme: "default",
  },

  ignoreDeadLinks: [
    /^https?:\/\/localhost/,
    /^https?:\/\/100\./,
  ],
}))

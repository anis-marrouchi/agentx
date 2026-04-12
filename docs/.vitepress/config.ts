import { defineConfig } from "vitepress"
import { withMermaid } from "vitepress-plugin-mermaid"

export default withMermaid(defineConfig({
  title: "AgentX",
  description: "Self-hosted multi-agent orchestrator. Telegram, WhatsApp, Discord, GitLab, crons, webhooks, mesh — routed to Claude, OpenAI, or any LLM.",
  lastUpdated: true,
  cleanUrls: true,

  head: [
    ["link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#0ea5e9" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "AgentX" }],
    ["meta", { property: "og:description", content: "Self-hosted multi-agent orchestrator." }],
  ],

  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "AgentX",

    nav: [
      { text: "Install", link: "/install" },
      { text: "Concepts", link: "/concepts" },
      { text: "Journey", link: "/journey/01-telegram-qa-bot" },
      { text: "Reference", link: "/reference/cli" },
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
            { text: "6. Shared wiki · planned", link: "/journey/06-shared-wiki" },
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

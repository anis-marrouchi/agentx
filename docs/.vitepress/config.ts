import { defineConfig } from "vitepress"

const groups = [
  { text: "Start here", items: [
    { text: "Meet AgentX", link: "/" }, { text: "What it is", link: "/what-it-is" },
    { text: "See it first", link: "/see-it-first" },
    { text: "Visual walkthrough", link: "/tutorials/first-workflow" }, { text: "Before you start", link: "/requirements" }, { text: "Install", link: "/install" },
    { text: "Your first agent", link: "/first-agent" }, { text: "Connect Telegram", link: "/connect-telegram" },
  ] },
  { text: "Running it day to day", items: [
    { text: "Dashboard", link: "/dashboard/" }, { text: "Monitor", link: "/dashboard/monitor" },
    { text: "Live", link: "/dashboard/live" }, { text: "Operations", link: "/dashboard/operations" },
    { text: "Activity", link: "/dashboard/activity" }, { text: "Workflows", link: "/dashboard/workflows" },
    { text: "Settings", link: "/dashboard/settings" },
    { text: "In-page chat", link: "/dashboard/chat" }, { text: "Desktop assistant", link: "/dashboard/voice" },
    { text: "Terminal UI (OpenCode)", link: "/dashboard/tui" },
  ] },
  { text: "Automations", items: [
    { text: "Overview", link: "/automations/" }, { text: "Describe what you want", link: "/automations/describe-it" },
    { text: "Check that it worked", link: "/automations/check-it-worked" },
  ] },
  { text: "Common jobs", items: [
    { text: "Answer questions", link: "/jobs/answer-questions" }, { text: "Send a daily report", link: "/jobs/daily-report" },
    { text: "Watch GitLab", link: "/jobs/watch-gitlab" }, { text: "Add a second machine", link: "/jobs/second-machine" },
    { text: "Tailscale setup", link: "/jobs/tailscale" }, { text: "Keep it safe", link: "/jobs/keep-it-safe" },
    { text: "Fire a routine from outside", link: "/jobs/fire-a-routine" },
  ] },
  { text: "When something goes wrong", items: [
    { text: "It's not answering", link: "/help/its-not-answering" }, { text: "Run a health check", link: "/help/doctor" },
    { text: "Understand costs", link: "/help/costs" },
  ] },
  { text: "Go deeper", items: [
    { text: "Record a VS Code walkthrough", link: "/tutorials/record-vscode" },
    { text: "Architecture", link: "/architecture/overview" },
    { text: "Jev and typed decisions", link: "/architecture/jev" },
  ] },
  { text: "Reference for engineers", items: [
    { text: "CLI", link: "/reference/cli" }, { text: "Configuration", link: "/reference/config" },
    { text: "Channels", link: "/reference/channels" }, { text: "Workflow schema", link: "/reference/workflow-schema" },
    { text: "Agent-to-agent (A2A)", link: "/reference/a2a" },
    { text: "Dashboard map", link: "/reference/dashboard-map" }, { text: "Glossary", link: "/reference/glossary" },
  ] },
]

export default defineConfig({
  title: "AgentX",
  description: "Put an AI teammate on the tools your team already uses.",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", href: "/agentx-symbol.png", type: "image/png" }],
    ["meta", { property: "og:title", content: "AgentX — an AI teammate for your team" }],
    ["meta", { property: "og:description", content: "Set up agents, connect your tools, and see what needs you." }],
    ["meta", { property: "og:image", content: "/agentx-symbol.png" }],
  ],
  themeConfig: {
    logo: "/agentx-symbol.png",
    nav: [
      { text: "Start here", link: "/" }, { text: "Dashboard", link: "/dashboard/" },
      { text: "Automations", link: "/automations/" }, { text: "Common jobs", link: "/jobs/answer-questions" },
      { text: "Reference", link: "/reference/cli" }, { text: "GitHub", link: "https://github.com/anis-marrouchi/agentx" },
    ],
    sidebar: groups,
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/anis-marrouchi/agentx" }],
    editLink: { pattern: "https://github.com/anis-marrouchi/agentx/edit/main/docs/:path" },
    footer: { message: "Released under the MIT License." },
  },
})

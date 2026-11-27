// Settings › Business: the rows the pane draws, the one source search reads
// (panes.ts, condition 1).
import type { SettingsRowDef } from "../panes"

// People › Business (#2101 ST3a): the org chart and what the PM gate reads.
export const BUSINESS_ROWS = [
  { id: "layer", label: "Business layer", help: "Off in agentx.json: the PM gate and the activity graph read none of this", words: "business enabled on off" },
  { id: "org", label: "Org chart", help: "Who reports to whom, with each member's role. The same editor as the Org page.", words: "reports to role member dotted line acts for working hours people" },
  { id: "projects", label: "Projects", help: "The PM of each drives the PM gate", words: "pm gate add project team lead repo" },
  { id: "clients", label: "Clients", help: "A client exists once a project or a contact names it. Set one up to treat it differently.", words: "kind respond within standing authorizations own internal" },
  { id: "contacts", label: "Contact map", help: "Which client a Telegram or WhatsApp chat belongs to. Unmapped chats count as internal.", words: "chat client telegram whatsapp mapping" },
  { id: "boards", label: "Boards", help: "Task boards over GitLab projects. A column maps a dropped card to a label.", words: "columns gitlab task board label kanban" },
] as const satisfies readonly SettingsRowDef[]

// Settings › Mesh: the rows the pane draws, the one source search reads
// (panes.ts, condition 1).
import type { SettingsRowDef } from "../panes"

// Connections › Mesh (#2101 ST3b): mesh on, the peers with the health check
// under Advanced, and the tokens.
export const MESH_ROWS = [
  { id: "mesh-on", label: "Mesh on", help: "Share work between your AgentX machines", words: "mesh peers machines link enable" },
  { id: "peers", label: "Peers", help: "The machines this one talks to", words: "mesh peer machine add remove address" },
  { id: "mh-interval", label: "Health check every", help: "How often this machine checks each peer answers. 5 to 3600.", words: "mesh health interval seconds", open: "mesh-advanced" },
  { id: "mh-timeout", label: "Gives up after", help: "A peer that has not answered by then counts as down. 1 to 60.", words: "mesh health check timeout seconds", open: "mesh-advanced" },
  { id: "tokens", label: "Tokens", help: "Keys for software: a chat bridge, another machine, a script. Give each the fewest scopes that work.", words: "token key api scope revoke make" },
] as const satisfies readonly SettingsRowDef[]

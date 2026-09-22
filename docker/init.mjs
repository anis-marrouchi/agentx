// First-run configuration for two containers sharing /data. Keep existing
// installs intact; the web wizard adds agents to this empty configuration.
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"

if (existsSync("agentx.json")) {
  console.log("Existing agentx.json retained.")
} else {
  const env = existsSync(".env") ? readFileSync(".env", "utf8") : ""
  if (!/^MESH_TOKEN=\S+/m.test(env)) {
    appendFileSync(".env", `\nMESH_TOKEN=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 })
  }
  writeFileSync("agentx.json", JSON.stringify({
    node: { id: "docker", name: "My Team", bind: "0.0.0.0:18800" },
    agents: {},
    channels: {},
    crons: {},
    mesh: { enabled: false, peers: [] },
    dashboard: {
      enabled: true, bind: "0.0.0.0", port: 4202,
      daemonUrl: "http://daemon:18800", token: "${MESH_TOKEN}",
    },
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  console.log("Created Docker configuration. Open http://127.0.0.1:4202/setup to add an agent.")
}

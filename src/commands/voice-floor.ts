import { Command } from "commander"
import { spawn } from "child_process"
import chalk from "chalk"
import { describeFloor, type FloorView } from "@/voice/floor"

// --- agentx voice floor: one speaker at a time (#924) ---
//
// A demo, a recording or any script that speaks or draws by itself takes
// the floor first: agents' spoken answers, notices and the character then
// wait until it lets go. See src/voice/floor.ts and
// src/daemon/voice-floor-api.ts.
//
//   agentx voice floor                        who holds it
//   agentx voice floor run --as "Tour" --sound -- python3 tour.py
//                                             hold it for as long as the
//                                             command runs
//   agentx voice floor take --as "Tour" --seconds 300   prints the id
//   agentx voice floor renew <id> / release <id>
//   agentx voice floor stop                   the owner takes it back

const DAEMON = process.env.AGENTX_DAEMON_URL ?? "http://127.0.0.1:18800"

/** One request to the floor routes: the status with the body, since a
 *  refusal (409, 410) says who holds the floor. */
export async function floorRequest(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const token = process.env.MESH_TOKEN
  const res = await fetch(`${DAEMON}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((e) => { throw new Error(`daemon not reachable at ${DAEMON}: ${e?.message ?? e}`) })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

interface TakeOpts { as?: string; seconds?: string; sound?: boolean; hide?: boolean; pid?: string; agent?: string; json?: boolean }

const takeBody = (opts: TakeOpts, pid?: number) => ({
  holder: opts.as ?? "",
  ...(opts.seconds ? { seconds: Number(opts.seconds) } : {}),
  ...(opts.sound ? { sound: true } : {}),
  ...(opts.hide ? { hide: true } : {}),
  ...(opts.agent ? { agentId: opts.agent } : {}),
  ...(pid ?? opts.pid ? { pid: Number(pid ?? opts.pid) } : {}),
})

function fail(e: unknown): never {
  console.log(chalk.red(`  ${(e as any)?.message ?? e}`))
  process.exit(1)
}

const holding = (cmd: Command) => cmd
  .requiredOption("--as <name>", 'who takes it, as the owner reads it: "Product tour"')
  .option("--seconds <n>", "how long, unless renewed or released first (voice.floor.defaultSeconds when unset)")
  .option("--sound", "it plays sound of its own: a microphone that opened by itself ignores what it hears")
  .option("--hide", "a recording: the character and every bubble stay hidden")
  .option("--agent <id>", "the agent it speaks for, if any")

export const floor = new Command()
  .name("floor")
  .description("who may speak and show a bubble: see who holds the floor, or take it for a demo, a recording or a script")
  .option("--json", "the floor as JSON")
  .action(async (opts: { json?: boolean }) => {
    try {
      const { data } = await floorRequest("GET", "/voice/floor")
      console.log(opts.json ? JSON.stringify(data) : `  ${describeFloor(data as FloorView)}`)
    } catch (e) { fail(e) }
  })

holding(floor.command("take"))
  .description("take the floor; prints the id that renews and releases it")
  .option("--pid <pid>", "the holder's process: the floor is freed when it is gone")
  .option("--json", "the reply as JSON")
  .action(async (opts: TakeOpts) => {
    try {
      const { status, data } = await floorRequest("POST", "/voice/floor", takeBody(opts))
      if (opts.json) console.log(JSON.stringify(data))
      else if (status === 201) console.log(data.id)
      else console.log(chalk.red(`  ${data.error ?? `daemon ${status}`}`))
      if (status !== 201) process.exit(status === 409 ? 2 : 1)
    } catch (e) { fail(e) }
  })

floor.command("renew <id>")
  .description("keep the floor longer, from now")
  .option("--seconds <n>", "how long (voice.floor.defaultSeconds when unset)")
  .action(async (id: string, opts: { seconds?: string }) => {
    try {
      const { status, data } = await floorRequest("POST", `/voice/floor/${encodeURIComponent(id)}/renew`, opts.seconds ? { seconds: Number(opts.seconds) } : {})
      if (status !== 200) { console.log(chalk.red(`  ${data.error ?? `daemon ${status}`}`)); process.exit(status === 410 ? 2 : 1) }
      console.log(`  ${describeFloor(data as FloorView)}`)
    } catch (e) { fail(e) }
  })

floor.command("release <id>")
  .description("let go of the floor: what waited is said now")
  .action(async (id: string) => {
    try {
      const { data } = await floorRequest("POST", `/voice/floor/${encodeURIComponent(id)}/release`, {})
      console.log(data.released ? "  released" : chalk.dim("  it was not held with this id (any more)"))
    } catch (e) { fail(e) }
  })

floor.command("stop")
  .description("take the floor back from whoever holds it (the owner's call; the stop hotkey does it too)")
  .action(async () => {
    try {
      const { data } = await floorRequest("DELETE", "/voice/floor")
      console.log(data.revoked ? "  the floor is free" : chalk.dim("  nobody held it"))
    } catch (e) { fail(e) }
  })

holding(floor.command("run"))
  .description("hold the floor for as long as a command runs: agentx voice floor run --as \"Tour\" --sound -- python3 tour.py")
  .argument("<command...>", "the command and its arguments, after --")
  .action(async (command: string[], opts: TakeOpts) => {
    let took
    try { took = await floorRequest("POST", "/voice/floor", takeBody(opts, process.pid)) } catch (e) { fail(e) }
    if (took.status !== 201) {
      console.error(chalk.red(`  ${took.data.error ?? `daemon ${took.status}`}`))
      process.exit(took.status === 409 ? 2 : 1)
    }
    const id = took.data.id as string
    const seconds = Math.max(5, Math.round(((took.data.expiresAt as number) - Date.now()) / 1000))
    // The command and what it runs speak and point under this floor.
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, AGENTX_FLOOR: id } })
    let taken = false
    let over = false
    // Renewed well inside its time, and checked every two seconds: the
    // floor gone (the owner's stop) ends the command, which no longer
    // has the right to speak.
    const lost = async (r: { status: number; data: any } | null) => {
      if (r?.status !== 410 || taken || over) return
      // A daemon that restarted has forgotten the hold: nobody took it,
      // so it is taken again under the same id and the command goes on.
      const now = r.data?.floor as FloorView | undefined
      if (now && !now.held && now.ended === null) {
        const again = await floorRequest("POST", "/voice/floor", { ...takeBody(opts, process.pid), seconds, id }).catch(() => null)
        if (again?.status === 201 || over) return
      }
      taken = true
      console.error(chalk.yellow("  the floor was taken back: stopping"))
      child.kill("SIGTERM")
      // A command that ignores the request is ended.
      setTimeout(() => child.kill("SIGKILL"), 5000).unref()
    }
    const renew = setInterval(() => void floorRequest("POST", `/voice/floor/${id}/renew`, { seconds }).catch(() => null).then(lost), (seconds * 1000) / 3)
    const check = setInterval(() => void floorRequest("GET", `/voice/floor/${id}`).catch(() => null).then(lost), 2000)
    const end = async () => {
      over = true
      clearInterval(renew)
      clearInterval(check)
      await floorRequest("POST", `/voice/floor/${id}/release`, {}).catch(() => null)
    }
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig))
    child.on("error", async (e) => {
      await end()
      fail(e)
    })
    child.on("close", async (code, signal) => {
      await end()
      process.exit(taken ? 130 : code ?? (signal ? 1 : 0))
    })
  })

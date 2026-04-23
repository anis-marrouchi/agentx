import { Command } from "commander"
import chalk from "chalk"
import { ActorStore } from "@/actors/store"
import type { ActorChannel, Actor, Role } from "@/actors/types"

// --- agentx actor / role — identities for BPM workflows ---
//
// Actors are the humans a userTask node can be assigned to. Each actor
// carries one or more channel handles (telegram user id, whatsapp phone,
// slack member id, email address) so the task renderer knows where to
// deliver the notification.
//
// Roles group actors together with an assignment strategy. A userTask
// assigned to a role fans out (or round-robins, etc.) to its members.
//
// CLI:
//   agentx actor add <id> --name "Alice" --telegram 12345 --email a@co
//   agentx actor list
//   agentx actor show actor:alice
//   agentx actor remove actor:alice
//
//   agentx role create <id> --name "Reviewers" --strategy first-available
//   agentx role grant <role-id> <actor-id>
//   agentx role revoke <role-id> <actor-id>
//   agentx role list
//   agentx role show role:reviewers

export const actor = new Command()
  .name("actor")
  .description("manage actors (humans) that can be assigned to workflow userTasks")

actor
  .command("add")
  .description("add a new actor")
  .argument("<id>", "actor id (e.g. alice; 'actor:' prefix is added if missing)")
  .requiredOption("--name <name>", "human-readable name")
  .option("--email <email>", "email address")
  .option("--telegram <handle>", "Telegram user id (numeric)")
  .option("--whatsapp <phone>", "WhatsApp phone in E.164 (no +)")
  .option("--slack <memberId>", "Slack member id")
  .option("--discord <userId>", "Discord user id")
  .option("--timezone <tz>", "IANA timezone, e.g. Africa/Tunis")
  .option("--prefer <channel>", "mark this channel as preferred for task notifications", "")
  .action((rawId: string, opts: {
    name: string; email?: string
    telegram?: string; whatsapp?: string; slack?: string; discord?: string
    timezone?: string; prefer?: string
  }) => {
    const id = rawId.startsWith("actor:") ? rawId : `actor:${rawId}`
    const store = new ActorStore()
    if (store.getActor(id)) {
      console.error(chalk.red(`  actor "${id}" already exists. Use 'actor remove' first.`))
      process.exitCode = 1
      return
    }
    const channels: ActorChannel[] = []
    const add = (ch: ActorChannel["channel"], handle?: string) => {
      if (!handle) return
      channels.push({ channel: ch, handle, preferredForTasks: opts.prefer === ch || undefined })
    }
    add("telegram", opts.telegram)
    add("whatsapp", opts.whatsapp)
    add("slack",    opts.slack)
    add("discord",  opts.discord)
    if (opts.email) add("email", opts.email)
    if (channels.length === 0) {
      console.error(chalk.red("  at least one channel handle is required (--telegram, --whatsapp, --slack, --discord, --email)"))
      process.exitCode = 1
      return
    }
    const a: Actor = {
      id,
      name: opts.name,
      email: opts.email,
      channels,
      timezone: opts.timezone,
    }
    const saved = store.saveActor(a)
    console.log(chalk.green(`  ✓ actor "${saved.id}" saved (${saved.channels.length} channel${saved.channels.length === 1 ? "" : "s"})`))
  })

actor
  .command("list")
  .description("list all actors")
  .action(() => {
    const store = new ActorStore()
    const actors = store.listActors()
    if (!actors.length) {
      console.log(chalk.dim("  no actors yet. Try: agentx actor add alice --name 'Alice' --telegram 12345"))
      return
    }
    console.log()
    for (const a of actors) {
      const channels = a.channels.map((c) => `${c.channel}:${c.handle}${c.preferredForTasks ? "*" : ""}`).join(", ")
      console.log(`  ${chalk.cyan(a.id.padEnd(24))}  ${chalk.bold(a.name)}`)
      console.log(`    ${chalk.dim(channels)}`)
    }
    console.log()
    console.log(chalk.dim(`  ${actors.length} actor${actors.length === 1 ? "" : "s"}. * = preferred for tasks.`))
  })

actor
  .command("show")
  .description("print full JSON for an actor")
  .argument("<id>", "actor id (with or without 'actor:' prefix)")
  .action((rawId: string) => {
    const id = rawId.startsWith("actor:") ? rawId : `actor:${rawId}`
    const store = new ActorStore()
    const a = store.getActor(id)
    if (!a) { console.error(chalk.red(`  actor "${id}" not found`)); process.exitCode = 1; return }
    console.log(JSON.stringify(a, null, 2))
  })

actor
  .command("remove")
  .alias("rm")
  .description("remove an actor (does not clean up role memberships)")
  .argument("<id>", "actor id")
  .action((rawId: string) => {
    const id = rawId.startsWith("actor:") ? rawId : `actor:${rawId}`
    const store = new ActorStore()
    if (!store.deleteActor(id)) { console.error(chalk.red(`  actor "${id}" not found`)); process.exitCode = 1; return }
    console.log(chalk.green(`  ✓ actor "${id}" removed`))
  })

// --- roles ---

export const role = new Command()
  .name("role")
  .description("manage roles (groups of actors) for workflow userTasks")

role
  .command("create")
  .description("create a new role")
  .argument("<id>", "role id (e.g. reviewers; 'role:' prefix is added if missing)")
  .requiredOption("--name <name>", "human-readable name")
  .option("--strategy <strategy>", "first-available | round-robin | all | manager-of", "first-available")
  .action((rawId: string, opts: { name: string; strategy: string }) => {
    const id = rawId.startsWith("role:") ? rawId : `role:${rawId}`
    const store = new ActorStore()
    if (store.getRole(id)) { console.error(chalk.red(`  role "${id}" already exists`)); process.exitCode = 1; return }
    const strategy = opts.strategy as Role["assignmentStrategy"]
    const saved = store.saveRole({
      id, name: opts.name, members: [],
      assignmentStrategy: strategy,
      rotationCursor: 0,
    })
    console.log(chalk.green(`  ✓ role "${saved.id}" created (strategy: ${saved.assignmentStrategy})`))
  })

role
  .command("grant")
  .description("add an actor (or nested role) to a role's members")
  .argument("<roleId>", "target role")
  .argument("<memberId>", "actor:<id> or role:<id>")
  .action((rawRole: string, memberRaw: string) => {
    const roleId = rawRole.startsWith("role:") ? rawRole : `role:${rawRole}`
    const store = new ActorStore()
    const r = store.getRole(roleId)
    if (!r) { console.error(chalk.red(`  role "${roleId}" not found`)); process.exitCode = 1; return }
    const member = memberRaw.startsWith("actor:") ? { actor: memberRaw }
      : memberRaw.startsWith("role:") ? { role: memberRaw }
      : null
    if (!member) { console.error(chalk.red("  member must be 'actor:<id>' or 'role:<id>'")); process.exitCode = 1; return }
    // Dedup
    if (r.members.some((m) => JSON.stringify(m) === JSON.stringify(member))) {
      console.log(chalk.dim(`  already a member`)); return
    }
    const updated = store.saveRole({ ...r, members: [...r.members, member] })
    console.log(chalk.green(`  ✓ ${memberRaw} granted to ${roleId} (${updated.members.length} member${updated.members.length === 1 ? "" : "s"})`))
  })

role
  .command("revoke")
  .description("remove an actor or nested role from a role")
  .argument("<roleId>", "target role")
  .argument("<memberId>", "actor:<id> or role:<id>")
  .action((rawRole: string, memberRaw: string) => {
    const roleId = rawRole.startsWith("role:") ? rawRole : `role:${rawRole}`
    const store = new ActorStore()
    const r = store.getRole(roleId)
    if (!r) { console.error(chalk.red(`  role "${roleId}" not found`)); process.exitCode = 1; return }
    const before = r.members.length
    const nextMembers = r.members.filter((m) => {
      if ("actor" in m) return m.actor !== memberRaw
      return m.role !== memberRaw
    })
    if (nextMembers.length === before) { console.log(chalk.dim(`  "${memberRaw}" was not a member`)); return }
    store.saveRole({ ...r, members: nextMembers })
    console.log(chalk.green(`  ✓ ${memberRaw} revoked from ${roleId}`))
  })

role
  .command("list")
  .description("list all roles with member counts")
  .action(() => {
    const store = new ActorStore()
    const roles = store.listRoles()
    if (!roles.length) {
      console.log(chalk.dim("  no roles yet. Try: agentx role create reviewers --name 'Reviewers'"))
      return
    }
    console.log()
    for (const r of roles) {
      console.log(`  ${chalk.cyan(r.id.padEnd(24))}  ${chalk.bold(r.name)}  ${chalk.dim(r.assignmentStrategy)}`)
      for (const m of r.members) {
        const ref = "actor" in m ? m.actor : m.role
        console.log(`    ${chalk.dim("•")} ${ref}`)
      }
    }
    console.log()
    console.log(chalk.dim(`  ${roles.length} role${roles.length === 1 ? "" : "s"}.`))
  })

role
  .command("show")
  .description("print full JSON for a role, including resolved members")
  .argument("<id>", "role id")
  .action((rawId: string) => {
    const id = rawId.startsWith("role:") ? rawId : `role:${rawId}`
    const store = new ActorStore()
    const r = store.getRole(id)
    if (!r) { console.error(chalk.red(`  role "${id}" not found`)); process.exitCode = 1; return }
    const resolved = store.resolveMembers({ kind: "role", id: r.id })
    console.log(JSON.stringify({ ...r, _resolvedActors: resolved }, null, 2))
  })

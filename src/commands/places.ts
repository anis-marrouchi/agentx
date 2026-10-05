import { Command } from "commander"
import chalk from "chalk"
import { loadDaemonConfig } from "@/daemon/config"
import { openDb } from "@/storage/sqlite"
import { PlaceStore } from "@/places/store"
import { addPlace, addReminder, removePlace, removeReminder, type ApiAnswer, type PlacesSettings } from "@/places/api"

// --- agentx places: places and place reminders (#676) ---
//
// The same store and the same rules as the phone app and the dashboard's
// Places page, so an agent can set "remind me when I get to the school"
// from a chat. The Android shell picks changes up on its next sync.

export const placesCmd = new Command()
  .name("places")
  .description("places your Android phone watches, and the reminders that fire when you arrive or leave")

function open(): { store: PlaceStore; settings: PlacesSettings } {
  const db = openDb({ quiet: true })
  if (!db) throw new Error("the database could not be opened; run this from the folder that holds agentx.json")
  return { store: new PlaceStore(db), settings: loadDaemonConfig().places }
}

function run(fn: () => ApiAnswer, ok: (body: Record<string, any>) => string): void {
  try {
    const a = fn()
    if (a.status !== 200) throw new Error(String(a.body.error))
    console.log(chalk.green(`  ${ok(a.body)}`))
  } catch (e: any) {
    console.log(chalk.red(`  ${e.message}`))
    process.exit(1)
  }
}

placesCmd
  .command("list")
  .description("list places with their reminders")
  .option("--json", "print JSON")
  .action((opts) => {
    try {
      const { store, settings } = open()
      const places = store.listPlaces()
      const reminders = store.listReminders()
      if (opts.json) { console.log(JSON.stringify({ enabled: settings.enabled, places, reminders }, null, 2)); return }
      if (!settings.enabled) console.log(chalk.yellow("  Place reminders are off (places.enabled is false)."))
      if (!places.length) { console.log("  No places yet. Add one: agentx places add School --lat 48.85 --lon 2.29"); return }
      for (const p of places) {
        console.log(`  ${chalk.bold(p.name)}  ${chalk.dim(`${p.id} · ${p.lat}, ${p.lon} · ${p.radiusMeters} m`)}`)
        for (const r of reminders.filter((x) => x.placeId === p.id)) {
          const when = `${r.on === "enter" ? "on arrival" : "on leaving"}${r.repeat ? ", every time" : ", once"}${r.agent ? `, via ${r.agent}` : ""}`
          console.log(`    - ${r.text} ${chalk.dim(`(${when}) ${r.id}`)}`)
        }
      }
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

placesCmd
  .command("add <name>")
  .description("save a place")
  .requiredOption("--lat <latitude>", "latitude, e.g. 48.8584")
  .requiredOption("--lon <longitude>", "longitude, e.g. 2.2945")
  .option("--radius <meters>", "radius in metres (default: places.defaultRadiusMeters)")
  .action((name, opts) => {
    run(() => {
      const { store, settings } = open()
      return addPlace(store, settings, { name, lat: opts.lat, lon: opts.lon, radiusMeters: opts.radius })
    }, (b) => `Saved ${b.place.name} (${b.place.id}, ${b.place.radiusMeters} m). The phone picks it up on its next sync.`)
  })

placesCmd
  .command("remove <place>")
  .description("remove a place (by name or id) and its reminders")
  .action((place) => {
    run(() => {
      const { store } = open()
      return removePlace(store, { id: store.findPlace(place)?.id ?? place })
    }, () => `Removed ${place}.`)
  })

placesCmd
  .command("remind <place> <text>")
  .description("add a reminder that fires when you arrive at a place (by name or id)")
  .option("--leave", "fire when you leave instead")
  .option("--agent <id>", "hand the reminder to this agent; its answer is the notification")
  .option("--repeat", "fire every time, not only once")
  .action((place, text, opts) => {
    run(() => {
      const { store, settings } = open()
      return addReminder(store, settings, { place, text, on: opts.leave ? "exit" : "enter", agent: opts.agent, repeat: !!opts.repeat })
    }, (b) => `Reminder ${b.reminder.id} set for ${b.reminder.on === "enter" ? "arriving at" : "leaving"} ${place}.`)
  })

placesCmd
  .command("forget <reminderId>")
  .description("remove one reminder")
  .action((id) => {
    run(() => removeReminder(open().store, { id }), () => `Removed reminder ${id}.`)
  })

placesCmd
  .command("events")
  .description("the latest enter and leave events phones reported")
  .option("--limit <n>", "how many", "20")
  .action((opts) => {
    try {
      const { store } = open()
      const events = store.recentEvents(Math.max(1, Number(opts.limit) || 20))
      if (!events.length) { console.log("  No events yet."); return }
      for (const e of events) {
        const what = `${e.transition === "enter" ? "arrived at" : "left"} ${e.placeName}`
        console.log(`  ${new Date(e.at).toISOString()}  ${what}  ${chalk.dim(e.note ?? `${e.fired} reminder(s)`)}`)
      }
    } catch (e: any) {
      console.log(chalk.red(`  ${e.message}`))
      process.exit(1)
    }
  })

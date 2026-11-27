#!/usr/bin/env node
// The phone screens the Hub's Mobile app page shows in its tilting phone
// (#2459). They are the docs' phone app screenshots (capture-mobile.mjs,
// the app as shipped against its demo fixture), made small for the Hub.
//
// Refresh, after the phone app changes:
//   DOCS_SHOTS=app-light,desk,fleet,alerts pnpm docs:shots:mobile
//   pnpm hub:phone-screens
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const from = resolve(repo, "docs/public/screenshots/mobile-app")
const to = resolve(repo, "src/hub/assets/phone")

// Shot name in the docs → file name in the Hub. Order is the order shown.
const PHONE_SCREENS = [["app-light", "chat"], ["desk", "desk"], ["fleet", "fleet"], ["alerts", "alerts"]]

mkdirSync(to, { recursive: true })
for (const [shot, name] of PHONE_SCREENS) {
  const file = resolve(to, `${name}.webp`)
  await sharp(resolve(from, `${shot}.png`)).resize({ width: 390 }).webp({ quality: 80 }).toFile(file)
  console.log(`${shot}.png → src/hub/assets/phone/${name}.webp`)
}

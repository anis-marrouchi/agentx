// Run with `npm test` (compiles src/ to dist/ first).
import { test } from "node:test"
import assert from "node:assert/strict"
import place from "../dist/orb-place.js"

const { parsePlace, orbPlace, regrow } = place
const main = { x: 0, y: 25, width: 1440, height: 875 }
const side = { x: 1440, y: 0, width: 1920, height: 1080 }
const size = { width: 88, height: 88 }

test("a saved place is read back; anything else is no place", () => {
  assert.deepEqual(parsePlace({ x: 10.4, y: 20 }), { x: 10, y: 20 })
  assert.equal(parsePlace({ x: "1", y: 2 }), null)
  assert.equal(parsePlace(null), null)
})

test("first launch: bottom right of the main screen", () => {
  assert.deepEqual(orbPlace(null, size, [main], main), { x: 1440 - 88 - 24, y: 25 + 875 - 88 - 24 })
})

test("the saved place is kept while it is on a screen, dropped when that screen is gone", () => {
  const onSide = { x: 2000, y: 500 }
  assert.deepEqual(orbPlace(onSide, size, [main, side], main), onSide)
  assert.deepEqual(orbPlace(onSide, size, [main], main), orbPlace(null, size, [main], main))
})

test("growing for the pill keeps the orb where it is (top middle)", () => {
  const b = regrow({ x: 100, y: 200, width: 88, height: 88 }, 288, 140)
  assert.deepEqual(b, { x: 0, y: 200, width: 288, height: 140 })
  assert.equal(b.x + b.width / 2, 100 + 88 / 2)
})

test("C2: a window that grows past the work area is moved back onto it", () => {
  // The default bottom-right place: the pill grows down, off the screen.
  const at = orbPlace(null, size, [main], main)
  const b = place.regrow({ ...at, ...size }, 300, 200, main)
  assert.ok(b.x + b.width <= main.x + main.width, "right edge on the area")
  assert.ok(b.y + b.height <= main.y + main.height, "bottom edge on the area")
  assert.ok(b.x >= main.x && b.y >= main.y)
  assert.equal(b.width, 300)
  assert.equal(b.height, 200)
})

test("C2: a window already on the area is not moved", () => {
  const b = { x: 400, y: 300, width: 288, height: 140 }
  assert.deepEqual(place.clampTo(b, main), b)
})

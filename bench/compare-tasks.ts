// The tasks `pnpm bench:compare` hands to both sides (#455). Each is a
// small Node project and a prompt; the check afterwards is mechanical: the
// tests pass and no file under test/ changed. They grow in how much the
// agent has to find out for itself:
//
//   fix-bugs   the failing tests point at four bugs in two files.
//   implement  two functions are stubs; the tests are the spec.
//   trace      a bug report in plain words; four causes spread over six
//              files, the rules in a README. The prompt does not say
//              which files, or to run the tests first.
//
// `reference` holds the edits a correct run makes. Only the unit tests use
// it, to prove each task fails as written and passes once fixed; it is
// never written into the project the agent sees.

export interface CompareTask {
  id: string
  title: string
  prompt: string
  files: Record<string, string>
  reference: Record<string, string>
}

const PACKAGE_JSON = JSON.stringify({
  name: "bench-fixture", version: "1.0.0", private: true, type: "module",
  scripts: { test: "node --test" },
}, null, 2) + "\n"

const FIX_BUGS_STATS = `// Small statistics helpers.
export function mean(values) {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / (values.length + 1)
}

export function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export function mode(values) {
  if (values.length === 0) return null
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
  let best = null
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count }
  }
  return bestCount
}

export function range(values) {
  if (values.length === 0) return 0
  return Math.max(...values) - Math.min(...values)
}
`

const FIX_BUGS_FORMAT = `import { mean, median, mode, range } from "./stats.js"

/** One line per statistic, "name: value", joined by newlines. */
export function formatReport(values) {
  const lines = [
    \`mean: \${mean(values)}\`,
    \`median: \${median(values)}\`,
    \`mode: \${mode(values)}\`,
    \`range: \${range(values)}\`,
  ]
  return lines.join(", ")
}
`

/** Four bugs: mean divides by n+1, median ignores even lengths, mode
 *  returns the count instead of the value, and the report joins its lines
 *  with the wrong separator. 5 of 10 tests fail. */
const fixBugs: CompareTask = {
  id: "fix-bugs",
  title: "fix four bugs the failing tests point at",
  prompt: [
    "Run `npm test` in this project. Some tests fail.",
    "Fix the code under src/ so that every test passes. Do not change anything under test/.",
    "Run the tests again to confirm, then reply with one line: how many tests pass.",
  ].join(" "),
  files: {
    "package.json": PACKAGE_JSON.replace("bench-fixture", "stats-fixture"),
    "src/stats.js": FIX_BUGS_STATS,
    "src/format.js": FIX_BUGS_FORMAT,
    "test/stats.test.js": `import { test } from "node:test"
import assert from "node:assert/strict"
import { mean, median, mode, range } from "../src/stats.js"
import { formatReport } from "../src/format.js"

test("mean of an empty list is 0", () => assert.equal(mean([]), 0))
test("mean of 2, 4, 6 is 4", () => assert.equal(mean([2, 4, 6]), 4))
test("mean of one value is that value", () => assert.equal(mean([7]), 7))
test("median of an odd count is the middle value", () => assert.equal(median([5, 1, 3]), 3))
test("median of an even count is the average of the two middle values", () => assert.equal(median([1, 2, 3, 4]), 2.5))
test("median of an empty list is 0", () => assert.equal(median([]), 0))
test("mode is the most frequent value, not its count", () => assert.equal(mode([5, 7, 5]), 5))
test("mode of an empty list is null", () => assert.equal(mode([]), null))
test("range is max minus min", () => assert.equal(range([4, 9, 1]), 8))
test("report has one statistic per line", () => {
  assert.equal(formatReport([1, 2, 2, 3]), "mean: 2\\nmedian: 2\\nmode: 2\\nrange: 2")
})
`,
  },
  reference: {
    "src/stats.js": FIX_BUGS_STATS
      .replace("sum / (values.length + 1)", "sum / values.length")
      .replace("return sorted[Math.floor(sorted.length / 2)]", "const m = Math.floor(sorted.length / 2)\n  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2")
      .replace("return bestCount\n}", "return best\n}"),
    "src/format.js": FIX_BUGS_FORMAT.replace('lines.join(", ")', 'lines.join("\\n")'),
  },
}

/** Two stubs to write from their doc comments and the tests. All 13 tests
 *  fail until both are written. */
const implement: CompareTask = {
  id: "implement",
  title: "write two functions the tests specify",
  prompt: [
    "The two functions in src/duration.js are not written yet; the tests under test/ describe what they must do.",
    "Write them so that `npm test` passes. Do not change anything under test/.",
    "Run the tests to confirm, then reply with one line: how many tests pass.",
  ].join(" "),
  files: {
    "package.json": PACKAGE_JSON.replace("bench-fixture", "duration-fixture"),
    "src/duration.js": `// Durations written as text ("1h 30m") and as a number of seconds.
// Units: d (day), h (hour), m (minute), s (second).

/** Parse "90s", "1h30m" or "2d 4h" into seconds. Spaces between the parts
 *  are allowed. Anything else, including an empty string or a number with
 *  no unit, throws a RangeError. */
export function parseDuration(text) {
  throw new Error("not implemented")
}

/** Format a whole number of seconds as "1d 2h 3m 4s": largest unit first,
 *  parts that are zero left out, 0 written as "0s". A negative number or a
 *  fraction throws a RangeError. */
export function formatDuration(seconds) {
  throw new Error("not implemented")
}
`,
    "test/duration.test.js": `import { test } from "node:test"
import assert from "node:assert/strict"
import { parseDuration, formatDuration } from "../src/duration.js"

test("parses seconds", () => assert.equal(parseDuration("90s"), 90))
test("parses minutes", () => assert.equal(parseDuration("45m"), 2700))
test("parses days", () => assert.equal(parseDuration("2d"), 172800))
test("parses parts written together", () => assert.equal(parseDuration("1h30m"), 5400))
test("parses parts with spaces between them", () => assert.equal(parseDuration("1h 5m 3s"), 3903))
test("rejects text that is not a duration", () => {
  for (const bad of ["", "5x", "h", "1h30"]) assert.throws(() => parseDuration(bad), RangeError, bad)
})
test("formats zero as 0s", () => assert.equal(formatDuration(0), "0s"))
test("formats hours, minutes and seconds", () => assert.equal(formatDuration(3903), "1h 5m 3s"))
test("leaves out the parts that are zero", () => assert.equal(formatDuration(7200), "2h"))
test("formats a whole day", () => assert.equal(formatDuration(86400), "1d"))
test("formats every unit", () => assert.equal(formatDuration(90061), "1d 1h 1m 1s"))
test("rejects negative and fractional seconds", () => {
  assert.throws(() => formatDuration(-1), RangeError)
  assert.throws(() => formatDuration(1.5), RangeError)
})
test("formatting what was parsed gives the same text back", () => {
  assert.equal(formatDuration(parseDuration("3d 4h")), "3d 4h")
})
`,
  },
  reference: {
    "src/duration.js": `const UNITS = { d: 86400, h: 3600, m: 60, s: 1 }

export function parseDuration(text) {
  const s = String(text).replace(/\\s+/g, "")
  if (!s) throw new RangeError("empty duration")
  const part = /(\\d+)([dhms])/y
  let total = 0
  while (part.lastIndex < s.length) {
    const m = part.exec(s)
    if (!m) throw new RangeError(\`not a duration: \${text}\`)
    total += Number(m[1]) * UNITS[m[2]]
  }
  return total
}

export function formatDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) throw new RangeError(\`not a whole number of seconds: \${seconds}\`)
  if (seconds === 0) return "0s"
  const parts = []
  for (const [unit, size] of Object.entries(UNITS)) {
    const n = Math.floor(seconds / size)
    seconds -= n * size
    if (n) parts.push(\`\${n}\${unit}\`)
  }
  return parts.join(" ")
}
`,
  },
}

const TRACE_CART = `import { priceOf } from "./catalog.js"

export function createCart() {
  return { lines: new Map() }
}

/** Add qty of an item. Adding an item already in the cart adds to it. */
export function addItem(cart, sku, qty = 1) {
  priceOf(sku)
  cart.lines.set(sku, qty)
  return cart
}

export function subtotalCents(cart) {
  let total = 0
  for (const [sku, qty] of cart.lines) total += priceOf(sku) * qty
  return total
}
`

const TRACE_DISCOUNT = `const CODES = {
  SAVE10: { type: "percent", value: 10 },
  FIVEOFF: { type: "fixed", value: 500 },
}

/** How much a discount code takes off a subtotal, in cents. */
export function discountCents(code, subtotal) {
  if (!code) return 0
  const rule = CODES[code]
  if (!rule) throw new Error(\`unknown discount code \${code}\`)
  if (rule.type === "percent") return Math.round(subtotal * rule.value)
  return Math.min(rule.value, subtotal)
}
`

const TRACE_MONEY = `/** Amounts are whole cents. */
export function roundCents(amount) {
  return Math.floor(amount)
}

export function formatCents(cents) {
  return \`$\${(cents / 100).toFixed(2)}\`
}
`

const TRACE_CHECKOUT = `import { subtotalCents } from "./cart.js"
import { discountCents } from "./discount.js"
import { taxCents } from "./tax.js"
import { formatCents } from "./money.js"

export function checkout(cart, { code, region = "none" } = {}) {
  const subtotal = subtotalCents(cart)
  const tax = taxCents(subtotal, region)
  const discount = discountCents(code, subtotal)
  const total = subtotal + tax - discount
  return { subtotal, discount, tax, total, display: formatCents(total) }
}
`

/** Four causes over six files: a repeat item replaces its quantity, a
 *  percent code is not divided by 100, tax is charged before the discount,
 *  and tax is rounded down instead of to the nearest cent. 5 of 10 tests
 *  fail. */
const trace: CompareTask = {
  id: "trace",
  title: "find the causes of a reported bug across six files",
  prompt: [
    "Customers report wrong order totals at checkout, mostly with discount codes, tax, and items added more than once.",
    "The pricing rules are in README.md. Find and fix the causes in src/.",
    "The tests under test/ describe the correct behaviour; do not change them.",
    "When you are done, `npm test` must pass. Reply with one line per cause you fixed.",
  ].join(" "),
  files: {
    "package.json": PACKAGE_JSON.replace("bench-fixture", "checkout-fixture"),
    "README.md": `# Checkout

Prices are whole cents. An order is priced in this order:

1. **Subtotal**: each item's price times its quantity. Adding an item that
   is already in the cart adds to its quantity.
2. **Discount**: a code takes a percentage (SAVE10 is 10 percent) or a fixed
   amount (FIVEOFF is $5.00, never more than the subtotal) off the subtotal.
   A percentage discount is rounded to the nearest cent.
3. **Tax**: the region's rate on the subtotal after the discount, rounded
   to the nearest cent.
4. **Total**: subtotal minus discount plus tax.
`,
    "src/catalog.js": `export const CATALOG = {
  pen: { name: "Pen", priceCents: 150 },
  notebook: { name: "Notebook", priceCents: 425 },
  bag: { name: "Bag", priceCents: 2999 },
}

export function priceOf(sku) {
  const item = CATALOG[sku]
  if (!item) throw new Error(\`unknown item \${sku}\`)
  return item.priceCents
}
`,
    "src/cart.js": TRACE_CART,
    "src/discount.js": TRACE_DISCOUNT,
    "src/tax.js": `import { roundCents } from "./money.js"

const RATES = { north: 0.2, south: 0.07, none: 0 }

/** Tax on an amount for a region, in cents. */
export function taxCents(amount, region) {
  const rate = RATES[region]
  if (rate === undefined) throw new Error(\`unknown region \${region}\`)
  return roundCents(amount * rate)
}
`,
    "src/money.js": TRACE_MONEY,
    "src/checkout.js": TRACE_CHECKOUT,
    "test/checkout.test.js": `import { test } from "node:test"
import assert from "node:assert/strict"
import { createCart, addItem } from "../src/cart.js"
import { checkout } from "../src/checkout.js"

const cart = (...items) => {
  const c = createCart()
  for (const [sku, qty] of items) addItem(c, sku, qty)
  return c
}

test("one item, no code, no tax", () => {
  assert.deepEqual(checkout(cart(["pen", 1])), { subtotal: 150, discount: 0, tax: 0, total: 150, display: "$1.50" })
})
test("adding an item twice adds to its quantity", () => {
  assert.equal(checkout(cart(["pen", 2], ["pen", 1])).subtotal, 450)
})
test("SAVE10 takes 10 percent, rounded to the nearest cent", () => {
  const r = checkout(cart(["notebook", 1], ["bag", 1]), { code: "SAVE10" })
  assert.equal(r.discount, 342)
  assert.equal(r.total, 3082)
})
test("FIVEOFF takes $5.00", () => {
  assert.equal(checkout(cart(["bag", 1]), { code: "FIVEOFF" }).total, 2499)
})
test("FIVEOFF never takes more than the subtotal", () => {
  const r = checkout(cart(["pen", 1]), { code: "FIVEOFF" })
  assert.equal(r.discount, 150)
  assert.equal(r.total, 0)
})
test("tax is charged on the amount after the discount", () => {
  const r = checkout(cart(["bag", 1]), { code: "FIVEOFF", region: "north" })
  assert.equal(r.tax, 500)
  assert.equal(r.total, 2999)
})
test("tax is rounded to the nearest cent", () => {
  const r = checkout(cart(["notebook", 1]), { region: "south" })
  assert.equal(r.tax, 30)
  assert.equal(r.total, 455)
})
test("discount, tax and display together", () => {
  assert.equal(checkout(cart(["bag", 1]), { code: "SAVE10", region: "south" }).display, "$28.88")
})
test("an unknown code is refused", () => {
  assert.throws(() => checkout(cart(["pen", 1]), { code: "FREE" }))
})
test("an unknown region is refused", () => {
  assert.throws(() => checkout(cart(["pen", 1]), { region: "west" }))
})
`,
  },
  reference: {
    "src/cart.js": TRACE_CART.replace("cart.lines.set(sku, qty)", "cart.lines.set(sku, (cart.lines.get(sku) || 0) + qty)"),
    "src/discount.js": TRACE_DISCOUNT.replace("subtotal * rule.value)", "subtotal * rule.value / 100)"),
    "src/money.js": TRACE_MONEY.replace("Math.floor(amount)", "Math.round(amount)"),
    "src/checkout.js": TRACE_CHECKOUT
      .replace("  const tax = taxCents(subtotal, region)\n  const discount = discountCents(code, subtotal)\n  const total = subtotal + tax - discount",
        "  const discount = discountCents(code, subtotal)\n  const tax = taxCents(subtotal - discount, region)\n  const total = subtotal - discount + tax"),
  },
}

export const TASKS: CompareTask[] = [fixBugs, implement, trace]

export function taskById(id: string): CompareTask | undefined {
  return TASKS.find((t) => t.id === id)
}

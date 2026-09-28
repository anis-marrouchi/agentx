// Tests for OrbMath: the orb's colour, level and speaking rhythm. Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

// --- Colour: the same as the daemon's presenceLook ---
//
// Expected values come from src/voice/presence.ts for the same ids.
let expected = ["writer": "#0D9488", "researcher-agent": "#7C3AED", "ops-agent": "#EA580C",
                "a": "#DB2777", "helper-agent": "#C026D3", "é-agent": "#DB2777"]
for (id, hex) in expected.sorted(by: { $0.key < $1.key }) {
    check(OrbMath.colorHex(agentID: id, configured: nil) == hex, "\(id) derives \(hex), as the daemon does")
}
check(OrbMath.colorHex(agentID: "writer", configured: "#112233") == "#112233", "a configured colour wins")
check(OrbMath.colorHex(agentID: "writer", configured: "teal") == "#0D9488", "an invalid configured colour falls back to the derived one")
check(OrbMath.colorHex(agentID: "", configured: nil) == OrbMath.palette[0], "no agent id still has a colour")

if let c = OrbMath.parseHex("#FF8000") {
    check(c.r == 1 && abs(c.g - 128.0 / 255) < 0.0001 && c.b == 0, "#FF8000 parses to orange")
} else { check(false, "#FF8000 parses") }
check(OrbMath.parseHex("FF8000") == nil && OrbMath.parseHex("#FF80") == nil && OrbMath.parseHex("#GG0000") == nil,
      "malformed colours are refused")

// --- Microphone level ---

check(OrbMath.level(fromRMS: 0) == 0 && OrbMath.level(fromRMS: 0.003) == 0, "a quiet room does not move the orb")
let voice = OrbMath.level(fromRMS: 0.02)
check(voice > 0.3 && voice < 0.8, "a normal voice moves it clearly (\(String(format: "%.2f", voice)))")
check(OrbMath.level(fromRMS: 0.5) == 1 && OrbMath.level(fromRMS: .infinity) == 0 && OrbMath.level(fromRMS: .nan) == 0,
      "shouting is capped at 1; nonsense reads as silence")
var last = -1.0
var rising = true
for i in 0...100 {
    let v = OrbMath.level(fromRMS: Float(i) / 200)
    if v < last { rising = false }
    last = v
}
check(rising, "louder is never smaller")

// --- Speaking rhythm ---

var lo = 1.0, hi = 0.0
for i in 0..<2000 {
    let v = OrbMath.speakingEnvelope(at: Double(i) / 100)
    lo = min(lo, v); hi = max(hi, v)
}
check(lo >= 0.15 && hi <= 1.0, "the speaking swell stays within 0.15…1")
check(hi - lo > 0.5, "and moves enough to be seen")

// --- Smoothing ---

check(OrbMath.smooth(0, toward: 1) > 0.5, "a word swells the orb quickly")
check(OrbMath.smooth(1, toward: 0) > 0.7, "and it settles slowly after")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")

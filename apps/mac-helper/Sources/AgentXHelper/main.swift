import AppKit

// agentx-mac-helper — the native half of computer use.
//
// Swift owns only what Node cannot reach: the Accessibility API and the
// window server. Everything else — which element to choose, whether the
// operation is allowed, what to do next — stays in agentx, so the
// capability belongs to every agent rather than to one app.
//
// Two verbs in this cut, and deliberately no third:
//
//   read   dump the focused window's accessibility tree as JSON
//   point  move the cursor to an element and highlight it
//
// There is no `click`. The point tier makes a model's choice visible and
// reviewable before anything irreversible happens, which is worth having
// on its own and is the only tier that is safe while the guard is still
// soaking.

func fail(_ message: String, code: Int32 = 1) -> Never {
    let payload = ["ok": false, "error": message] as [String: Any]
    if let d = try? JSONSerialization.data(withJSONObject: payload) {
        FileHandle.standardOutput.write(d)
    }
    exit(code)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let verb = args.first else {
    fail("usage: agentx-mac-helper read | point --x N --y N --w N --h N [--label TEXT]")
}

func flag(_ name: String) -> String? {
    guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
    return args[i + 1]
}

switch verb {
case "read":
    guard AXTree.trusted() else {
        fail("accessibility permission not granted — System Settings › Privacy & Security › Accessibility, then add this binary")
    }
    let snap = AXTree.snapshot(maxElements: Int(flag("max") ?? "400") ?? 400)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? encoder.encode(snap) else { fail("failed to encode tree") }
    FileHandle.standardOutput.write(data)

case "point":
    guard let x = Double(flag("x") ?? ""), let y = Double(flag("y") ?? ""),
          let w = Double(flag("w") ?? ""), let h = Double(flag("h") ?? "") else {
        fail("point needs --x --y --w --h")
    }
    Pointer.point(x: x, y: y, width: w, height: h, label: flag("label") ?? "")
    FileHandle.standardOutput.write(#"{"ok":true,"pointed":true}"#.data(using: .utf8)!)

case "trusted":
    let payload = ["ok": true, "trusted": AXTree.trusted()] as [String: Any]
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: payload))

default:
    fail("unknown verb \"\(verb)\" — expected read, point or trusted")
}

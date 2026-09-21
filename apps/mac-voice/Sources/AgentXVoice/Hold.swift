import Foundation

/// "Don't interrupt me" — the widget's own switch.
///
/// Separate from macOS Focus on purpose. System Focus is a heavy
/// instrument: it silences every device you own and announces itself to
/// everyone who messages you, which is far more than someone means when
/// they only want to finish a thought. A switch on the widget is a hold
/// you flick on for twenty minutes and forget.
///
/// The state lives in a file rather than in this process because the
/// thing that HONOURS it is not this process — `agentx notify` runs in the
/// daemon and in agents' shells, and none of them can ask a widget a
/// question. A file is the smallest thing all of them can read.
///
/// Either source counts as held: agentx checks this file and the system's
/// Focus database, and neither overrides the other. They are the same
/// person saying the same thing by different means.
enum Hold {

    private static let path: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".agentx", isDirectory: true)
        return dir.appendingPathComponent("focus.json")
    }()

    /// Is the widget currently holding notifications?
    static var isOn: Bool {
        guard let data = try? Data(contentsOf: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return (obj["active"] as? Bool) ?? false
    }

    /// Turn the hold on or off. Returns the new state.
    @discardableResult
    static func set(_ on: Bool) -> Bool {
        let payload: [String: Any] = [
            "active": on,
            "since": ISO8601DateFormatter().string(from: Date()),
            // Recorded so an operator reading the file knows which switch
            // produced it — the widget's, not a stale test fixture.
            "source": "widget",
        ]
        do {
            try FileManager.default.createDirectory(
                at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted])
            try data.write(to: path, options: .atomic)
        } catch {
            Log.warn("could not write the hold state: \(error.localizedDescription)")
        }
        return on
    }

    @discardableResult
    static func toggle() -> Bool { set(!isOn) }

    /// Ask agentx to deliver anything that piled up while the hold was on.
    ///
    /// Fire-and-forget through the same command line the widget uses for
    /// smart paste, so there is one place that knows how to find the CLI.
    static func flushHeld() {
        DispatchQueue.global(qos: .utility).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-lc", Config.notifyCommand + " --flush"]
            process.standardOutput = Pipe()
            process.standardError = Pipe()
            try? process.run()
            process.waitUntilExit()
        }
    }
}

import Foundation

/// Talks to the local agentx daemon's /ask endpoint.
///
/// /ask already does the voice-specific work server-side: it prepends a
/// VOICE MODE instruction and returns `text` pre-flattened for TTS by
/// toSpeakable(). So this client deliberately does no prompt shaping of
/// its own — two places deciding how an agent should sound is how they
/// drift apart.
///
/// No auth header: the daemon exempts loopback (see mesh-auth.ts), and
/// this widget is loopback by definition. Pointing AGENTX_DAEMON_URL at a
/// remote node would need a token, which is why it isn't the default.
enum AgentClient {
    struct Answer {
        /// What to speak: short, no URLs, no markdown.
        let text: String
        /// What to show: the answer as written, with the links and
        /// formatting the spoken form had to drop.
        let written: String?
        /// Buttons and media from the agentx:ui directive, parsed server-side.
        let buttons: [(String, String)]
        let imageURL: String?
        let durationMs: Int?
        /// The agent that answered and how it sounds.
        let agentID: String?
        let voice: VoiceChoice?
        /// Presence mode the daemon chose for this turn (talk, teach, …).
        var presenceMode: String? = nil
    }

    /// What, if anything, to say about the step now running.
    ///
    /// The daemon decides, because the phrasing lives with the model that
    /// chooses it. Returning nil is the common and correct case — most
    /// steps are not worth interrupting for, and the pill already shows
    /// every one of them to anyone looking.
    ///
    /// Never throws: a narration that fails is silence, which is exactly
    /// what it would have been anyway.
    static func phrase(tool: String, detail: String, elapsed: Int) async -> String? {
        guard let url = URL(string: "\(Config.daemonURL)/voice/phrase") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        // Shorter than the turn it narrates: a phrase that arrives late
        // describes work already finished.
        req.timeoutInterval = 6
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "tool": tool, "detail": detail, "elapsedSeconds": elapsed,
        ])
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
        struct Reply: Decodable { let say: String? }
        return (try? JSONDecoder().decode(Reply.self, from: data))?.say
    }

    // MARK: The door
    //
    // Option-Space is one door for everything spoken: a talk, a live
    // lesson, task narration, an agent's bubble. Pressing it hushes all of
    // them at once; what is then said goes to the activity that was
    // speaking, which answers it first. See src/daemon/voice-talk-api.ts.

    /// What was speaking when the door opened.
    struct Hushed {
        /// "talk", "lesson", "narration" or "queue"; nil when nothing was.
        let kind: String?
        let agentID: String?
        static let nothing = Hushed(kind: nil, agentID: nil)
    }

    /// Silence everything the daemon is saying. Never throws: no daemon
    /// means nothing was speaking.
    static func hush() async -> Hushed {
        guard let (data, _) = try? await post("/voice/hush", [:], timeout: 2) else { return .nothing }
        struct Reply: Decodable { let kind: String?; let agentId: String? }
        let r = try? JSONDecoder().decode(Reply.self, from: data)
        return Hushed(kind: r?.kind, agentID: r?.agentId)
    }

    /// Silence everything the daemon is saying, keeping nothing for the
    /// door. Never throws: no daemon means nothing of its was speaking.
    static func stopVoice() async {
        _ = try? await post("/voice/stop", [:], timeout: 2)
    }

    /// The listener said nothing after the hush, so no door follows: the
    /// daemon's speaking queue plays on.
    static func resume() async {
        _ = try? await post("/voice/queue/resume", [:], timeout: 2)
    }

    // MARK: The speaking queue
    //
    // Everything spoken on this Mac waits in one queue on the daemon, so
    // an answer never plays over another agent, a talk or narration. See
    // src/daemon/voice-queue-api.ts.

    /// Queue a line in the agent's voice and wait until it has been
    /// spoken, skipped or stopped. False only when the daemon could not
    /// take it, so the caller speaks it here instead. A cancelled wait
    /// (the door opened) is true: the line stays queued and plays after
    /// the listener's turn.
    static func queue(_ text: String, agentID: String, kind: String) async -> Bool {
        do {
            // A line may wait behind others, and a held queue for a minute.
            let (_, response) = try await post("/voice/queue",
                ["text": text, "agentId": agentID, "kind": kind, "wait": true], timeout: 900)
            guard let http = response as? HTTPURLResponse else { return false }
            return (200..<300).contains(http.statusCode)
        } catch let e as URLError where [.cannotConnectToHost, .cannotFindHost, .notConnectedToInternet, .networkConnectionLost].contains(e.code) {
            return false
        } catch {
            // Cancelled or timed out after the daemon took the line:
            // playing it here too would talk over it.
            return true
        }
    }

    /// Hand the listener's words through the door. True when an activity
    /// took them (a talk or lesson answers; "stop" ends it); false means
    /// nothing did, and they are an ordinary question.
    static func door(_ text: String) async -> Bool {
        guard let (_, response) = try? await post("/voice/door", ["text": text], timeout: 5),
              let http = response as? HTTPURLResponse else { return false }
        return (200..<300).contains(http.statusCode)
    }

    /// Who is speaking and who waits, from the daemon's speaking queue.
    struct QueueState: Decodable {
        struct Item: Decodable { let agentId: String? }
        let playing: Item?
        let waiting: [Item]
    }

    /// The speaking queue now, or nil when the daemon cannot be reached.
    static func queueState() async -> QueueState? {
        guard let url = URL(string: "\(Config.daemonURL)/voice/queue") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
        return try? JSONDecoder().decode(QueueState.self, from: data)
    }

    /// Who the words are for, from POST /voice/address: an agent on this
    /// node or on a mesh peer, with how to show it. Older daemons send
    /// only `agentId`.
    struct Addressed: Decodable {
        let agentID: String
        let name: String?
        /// "#RRGGBB"; without it the app derives the same one from the id.
        let color: String?
        let palette: AgentInfo.Palette?
        /// The node it lives on: this node's id, or the peer's name.
        let node: String?
        /// On a mesh peer; /ask reaches it by the same id.
        let remote: Bool?

        enum CodingKeys: String, CodingKey { case agentID = "agentId", name, color, palette, node, remote }

        var isRemote: Bool { remote ?? false }
    }

    /// The agent the words are addressed to ("Writer, …", or "Planner, …"
    /// on another node), or `target`. The daemon matches names, so the
    /// widget and config never disagree. Never throws: no daemon means
    /// nobody else to address.
    static func address(_ text: String, target: String) async -> Addressed {
        let fallback = Addressed(agentID: target, name: nil, color: nil, palette: nil, node: nil, remote: nil)
        guard let (data, _) = try? await post("/voice/address", ["text": text, "target": target], timeout: 2),
              let reply = try? JSONDecoder().decode(Addressed.self, from: data),
              !reply.agentID.isEmpty else { return fallback }
        return reply
    }

    private static func post(_ path: String, _ body: [String: Any], timeout: TimeInterval) async throws -> (Data, URLResponse) {
        var req = URLRequest(url: URL(string: "\(Config.daemonURL)\(path)")!)
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await URLSession.shared.data(for: req)
    }

    // MARK: Settings
    //
    // The settings window reads and saves through the daemon, which checks
    // every value and writes agentx.json. The app keeps no copy of its own.
    // See src/daemon/voice-settings-api.ts.

    /// GET /voice/settings, or nil when the daemon cannot be reached.
    static func settings() async -> VoiceSettings? {
        guard let url = URL(string: "\(Config.daemonURL)/voice/settings") else { return nil }
        var req = URLRequest(url: url)
        // The first call lists the Mac's voices, which can take a moment.
        req.timeoutInterval = 15
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(VoiceSettings.self, from: data)
    }

    /// Save a change. The saved settings, or the daemon's reason in words.
    static func saveSettings(_ patch: [String: Any]) async -> Result<VoiceSettings, SettingsFailure> {
        struct Reply: Decodable { let settings: VoiceSettings?; let error: String? }
        do {
            let (data, response) = try await post("/voice/settings", patch, timeout: 20)
            let reply = try? JSONDecoder().decode(Reply.self, from: data)
            if let s = reply?.settings, (response as? HTTPURLResponse)?.statusCode == 200 { return .success(s) }
            return .failure(SettingsFailure(message: reply?.error ?? "The daemon did not save the settings."))
        } catch {
            return .failure(SettingsFailure(message: "The AgentX daemon isn't reachable: \(error.localizedDescription)"))
        }
    }

    /// Say a sample line in an agent's voice with unsaved changes. Nil on
    /// success, else why not.
    static func preview(agentID: String, voice: [String: Any]) async -> String? {
        struct Reply: Decodable { let error: String? }
        guard let (data, response) = try? await post("/voice/preview", ["agentId": agentID, "voice": voice], timeout: 10) else {
            return "The AgentX daemon isn't reachable."
        }
        if (response as? HTTPURLResponse)?.statusCode == 202 { return nil }
        return (try? JSONDecoder().decode(Reply.self, from: data))?.error ?? "The preview didn't play."
    }

    struct SettingsFailure: Error { let message: String }

    /// One row of GET /agents: who can answer, and whether they are busy.
    struct AgentInfo: Decodable {
        let id: String
        let name: String?
        /// Tasks running now.
        let active: Int?
        /// "#RRGGBB": presence.color, else derived from the id. Older
        /// daemons send none, and the app derives it the same way.
        let color: String?
        /// The orb's nature palette. Older daemons send none, and the orb
        /// uses shades of `color`.
        let palette: Palette?
        var label: String { name ?? id }
        struct Palette: Decodable { let id: String; let colors: [String] }
    }

    /// The daemon's agents, or nil when the daemon cannot be reached.
    static func agents() async -> [AgentInfo]? {
        guard let url = URL(string: "\(Config.daemonURL)/agents") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode([AgentInfo].self, from: data)
    }

    /// The agent that answers: the pinned one, the one picked in the menu,
    /// the daemon's `node.defaultAgent` from /health, or its first agent —
    /// /ask refuses a request with no agent when there is no default.
    /// "" when none is known.
    static func resolveAgent() async -> String {
        if let agent = Config.agentID ?? Config.chosenAgentID { return agent }
        if let url = URL(string: "\(Config.daemonURL)/health"),
           let (data, _) = try? await URLSession.shared.data(from: url),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let node = obj["node"] as? [String: Any],
           let agent = node["defaultAgent"] as? String, !agent.isEmpty { return agent }
        return await agents()?.first?.id ?? ""
    }

    static func ask(_ message: String, agent: String) async throws -> Answer {
        var req = URLRequest(url: URL(string: "\(Config.daemonURL)/ask")!)
        req.httpMethod = "POST"
        // An agent turn routinely takes minutes. The default 60s would cut
        // off exactly the thoughtful answers worth waiting for.
        req.timeoutInterval = 600
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var payload: [String: Any] = ["message": message, "session": Config.voiceSession]
        // No agent known: the daemon answers with its default agent.
        if !agent.isEmpty { payload["agent"] = agent }
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await URLSession.shared.data(for: req)
        struct UiButton: Decodable { let label: String; let url: String }
        struct UiMedia: Decodable { let type: String; let url: String; let caption: String? }
        struct Ui: Decodable { let buttons: [UiButton]?; let media: UiMedia? }
        struct Presence: Decodable { let mode: String? }
        struct Reply: Decodable {
            let agentId: String?
            let voice: VoiceChoice?
            let presence: Presence?
            let text: String?
            let full: String?
            let ui: Ui?
            let error: String?
            let duration: Int?
        }
        let reply = try? JSONDecoder().decode(Reply.self, from: data)
        let voice = reply?.voice

        // 202 means accepted-but-busy: the daemon has already written a
        // speakable explanation into `text`. Falling through to the error
        // path here is what made "she is still working" sound like "that
        // didn't work".
        if let http = response as? HTTPURLResponse, http.statusCode == 202,
           let queuedText = reply?.text, !queuedText.isEmpty {
            return Answer(text: queuedText, written: nil, buttons: [], imageURL: nil,
                          durationMs: reply?.duration, agentID: reply?.agentId, voice: voice)
        }

        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let detail = reply?.error ?? String(data: data.prefix(200), encoding: .utf8) ?? ""
            throw VoiceError.api("daemon HTTP \(http.statusCode): \(detail)")
        }
        if let err = reply?.error, !err.isEmpty { throw VoiceError.api(err) }
        guard let text = reply?.text ?? reply?.full, !text.isEmpty else {
            throw VoiceError.api("agent returned an empty answer")
        }
        let buttons = (reply?.ui?.buttons ?? []).map { ($0.label, $0.url) }
        // Only images are shown inline; a document or video is offered as a
        // link instead, because a card that cannot play it should not
        // pretend otherwise.
        let media = reply?.ui?.media
        let image = media?.type == "image" ? media?.url : nil
        let extra: [(String, String)] = (media != nil && image == nil)
            ? [(media!.caption ?? media!.type.capitalized, media!.url)] : []

        return Answer(text: text, written: reply?.full,
                      buttons: buttons + extra, imageURL: image,
                      durationMs: reply?.duration, agentID: reply?.agentId, voice: voice,
                      presenceMode: reply?.presence?.mode)
    }
}

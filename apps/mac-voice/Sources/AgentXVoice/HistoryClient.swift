import Foundation

/// The daemon's voice history (src/daemon/voice-history-api.ts).
///
/// The list is summaries only; an answer in full is fetched when one is
/// opened. A replay is queued by the daemon in the agent's voice, at the
/// back of the speaking queue, so it never talks over what is playing.
/// Loopback needs no token, as for the rest of AgentClient.
enum HistoryClient {
    /// One page, newest first; `before` is the previous page's `next`.
    static func page(agent: String?, limit: Int, before: String? = nil) async -> Result<VoiceHistoryPage, HistoryFailure> {
        let q = HistoryLogic.query(agent: agent, limit: limit, before: before)
        guard let url = URL(string: "\(Config.daemonURL)/voice/history?\(q)") else { return .failure(.init(message: "Bad daemon address.")) }
        var req = URLRequest(url: url)
        req.timeoutInterval = 5
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200, let page = try? JSONDecoder().decode(VoiceHistoryPage.self, from: data) { return .success(page) }
            return .failure(.init(message: errorText(data) ?? "The daemon answered \(status)."))
        } catch {
            return .failure(.init(message: "The AgentX daemon isn't reachable."))
        }
    }

    /// One exchange in full, or nil when it cannot be loaded.
    static func detail(_ id: String) async -> VoiceExchangeDetail? {
        guard let url = URL(string: "\(Config.daemonURL)/voice/history/\(id)") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 5
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(VoiceExchangeDetail.self, from: data)
    }

    /// Say the answer again. Nil when queued, else why not.
    static func replay(_ id: String) async -> String? {
        guard let url = URL(string: "\(Config.daemonURL)/voice/history/\(id)/replay") else { return "Bad daemon address." }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 5
        guard let (data, response) = try? await URLSession.shared.data(for: req) else {
            return "The AgentX daemon isn't reachable."
        }
        if (response as? HTTPURLResponse)?.statusCode == 202 { return nil }
        return errorText(data) ?? "The answer wasn't queued."
    }

    struct HistoryFailure: Error { let message: String }

    private static func errorText(_ data: Data) -> String? {
        struct Reply: Decodable { let error: String? }
        return (try? JSONDecoder().decode(Reply.self, from: data))?.error
    }
}

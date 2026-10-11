import Foundation

/// The daemon's /voice/floor route (#924).
enum FloorClient {
    /// GET /voice/floor: the floor after `seq`, as soon as it changes;
    /// the current one after 25 s; nil when the daemon cannot be reached
    /// or is too old to know the route.
    static func next(after seq: Int) async -> FloorState? {
        guard let url = URL(string: "\(Config.daemonURL)/voice/floor?after=\(seq)") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 35
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(FloorState.self, from: data)
    }

    /// The owner takes the floor back, whoever holds it.
    static func takeBack() async {
        guard let url = URL(string: "\(Config.daemonURL)/voice/floor") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.timeoutInterval = 2
        _ = try? await URLSession.shared.data(for: req)
    }
}

/// Follows the floor for as long as the app runs. With no daemon the
/// floor is free: nothing of the assistant stays hidden behind a holder
/// nobody can ask about.
@MainActor
final class FloorWatcher {
    private var last = FloorState.free
    private var task: Task<Void, Never>?
    private var expiry: Timer?
    /// The floor now.
    var state: FloorState { last.at(Date().timeIntervalSince1970) }
    /// Told of every change: taken, renewed, freed.
    var onChange: ((FloorState) -> Void)?

    func start() {
        task?.cancel()
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.turn()
            }
        }
    }

    /// Wait until the floor is free.
    func free() async {
        while state.held && !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    private func turn() async {
        guard let next = await FloorClient.next(after: last.seq) else {
            set(.free)
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            return
        }
        set(next)
    }

    private func set(_ next: FloorState) {
        guard next != last else { return }
        let before = state
        last = next
        // A hold ends at its time even if the daemon is not there to say so.
        expiry?.invalidate()
        expiry = nil
        if next.held, let at = next.expiresAt {
            expiry = Timer.scheduledTimer(withTimeInterval: max(0, at / 1000 - Date().timeIntervalSince1970) + 0.1, repeats: false) { _ in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.onChange?(self.state)
                }
            }
        }
        if state != before { onChange?(state) }
    }
}

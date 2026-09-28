import Foundation

/// Parakeet as the app uses it: never makes a turn wait for a download or
/// for the first model load, and answers nil whenever mlx-whisper should
/// take this turn instead.
///
/// The first load of Parakeet on a Mac takes about half a minute (Core ML
/// prepares the encoder for the Neural Engine and caches the result);
/// later loads take about half a second. A turn waits a few seconds for
/// the load at most, then falls back while the load carries on.
enum LocalSTT {
    /// How long a turn waits for Parakeet to finish loading.
    static let loadPatience: TimeInterval = 4

    private static let loader = ParakeetLoader()

    static func parakeet(wav: Data) async -> String? {
        guard ModelStore.parakeet.isInstalled else {
            Log.warn("Parakeet is not downloaded yet; using mlx-whisper for now")
            ModelStore.installInBackground(ModelStore.parakeet) { Log.info($0) }
            return nil
        }
        guard let engine = await loader.engine(within: loadPatience) else {
            Log.warn("Parakeet is still loading (the first load takes about 30 s); using mlx-whisper for this turn")
            return nil
        }
        return await Task.detached(priority: .userInitiated) { () -> String? in
            do {
                let t = Date()
                let text = try engine.transcribe(wav: wav)
                Log.info(String(format: "parakeet: %.2f s", Date().timeIntervalSince(t)))
                return text
            } catch {
                Log.warn("Parakeet failed (\(error.localizedDescription)); falling back to mlx-whisper")
                return nil
            }
        }.value
    }
}

/// Loads Parakeet once, in the background, and lets callers wait for it
/// with a limit.
private actor ParakeetLoader {
    private var loading: Task<Parakeet?, Never>?

    func engine(within seconds: TimeInterval) async -> Parakeet? {
        let task = loading ?? start()
        return await withTaskGroup(of: Parakeet?.self) { group in
            group.addTask { await task.value }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    private func start() -> Task<Parakeet?, Never> {
        let task = Task.detached(priority: .userInitiated) { () -> Parakeet? in
            let t = Date()
            do {
                let p = try Parakeet.loaded()
                Log.info(String(format: "parakeet: loaded in %.1f s", Date().timeIntervalSince(t)))
                return p
            } catch {
                Log.warn("Parakeet would not load (\(error.localizedDescription))")
                return nil
            }
        }
        loading = task
        Task { if await task.value == nil { self.forget() } }
        return task
    }

    /// A failed load is tried again on the next turn.
    private func forget() { loading = nil }
}

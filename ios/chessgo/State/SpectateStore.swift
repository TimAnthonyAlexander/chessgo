import Foundation

/// Wire DTOs for the spectator half of `ws-protocol.md` that `Models/
/// LiveGame.swift` doesn't already cover. Ongoing updates to a spectator are
/// BYTE-IDENTICAL `state`/`end` broadcasts to what players get (the hub
/// fans the same marshaled frame out to `white`, `black`, and every
/// spectator — `gomachine/internal/hub/hub.go`'s `broadcast`), so those two
/// reuse `WsState`/`WsEnd` directly rather than redeclaring them.
///
/// `watching` (the one-shot full snapshot after `{"type":"watch",...}`) has
/// no dedicated Go struct on the hub side — it's built as a bespoke
/// `map[string]any` in `spectate.go`'s `spectateMsg`, richer than `WsState`
/// because a spectator has no single "opponent": it carries BOTH `white` and
/// `black`, plus `timeControl` and the full `moves` log a fresh viewer needs
/// to reconstruct the game from scratch (a player's `matched`/`resume`
/// equivalent). Every field still gets a resilient default — this is a
/// hand-built map on the wire, not a typed contract.
struct WsWatching: Decodable, Sendable {
    let gameId: String
    @DefaultEmptyString var pool: String
    @DefaultFalse var rated: Bool
    @DefaultEmptyString var variant: String
    let white: WsOpponent
    let black: WsOpponent
    @DefaultEmptyString var fen: String
    let duck: String?
    @DefaultEmptyString var sideToMove: String
    @DefaultEmptyString var status: String
    @DefaultFalse var check: Bool
    let timeControl: WsTimeControl
    let clock: WsClockPair
    @DefaultEmptyArray var moves: [WsMoveRef]
    let lastMove: String?
    @DefaultZero var ply: Int
    @DefaultFalse var over: Bool
    /// Not present in the hub's current `spectateMsg` map (no Crazyhouse
    /// pocket sent to spectators as of this writing) — kept optional so a
    /// future addition decodes for free instead of needing a client update.
    let pocket: String?
}

/// `{"type":"watchEnd","gameId":...,"reason":"unavailable"}` — the hub sends
/// this INSTEAD OF `watching` when the requested game doesn't exist or has
/// already finished (`spectate.go`'s `watchGame` rejection path). A game that
/// ends normally WHILE you're watching gets the ordinary `end` frame, not this.
struct WsWatchEnd: Decodable, Sendable {
    let gameId: String
    let reason: String?
}

/// UI-facing spectator snapshot — the read-only counterpart to `LiveGameState`.
/// No `color`/single `opponent`: a spectator sees both sides, and always
/// renders white at the bottom regardless of who's "ahead" in the match.
/// All `let` — every transition below returns a fresh copy.
struct SpectateGameState: Identifiable, Sendable {
    let id: String
    let pool: String
    let rated: Bool
    let variant: String
    let white: WsOpponent
    let black: WsOpponent
    let fen: String
    let duck: String?
    let pocket: String?
    let sideToMove: String
    let lastMove: String?
    let check: Bool
    let status: String
    let clock: WsClockPair
    let moves: [WsMoveRef]
    let result: String?
    let reason: String?
    let ended: Bool

    func clock(for color: PieceColor) -> Int {
        color == .white ? clock.w : clock.b
    }

    static func from(watching: WsWatching) -> SpectateGameState {
        SpectateGameState(
            id: watching.gameId,
            pool: watching.pool,
            rated: watching.rated,
            variant: watching.variant,
            white: watching.white,
            black: watching.black,
            fen: watching.fen,
            duck: watching.duck,
            pocket: watching.pocket,
            sideToMove: watching.sideToMove,
            lastMove: watching.lastMove,
            check: watching.check,
            status: watching.status,
            clock: watching.clock,
            moves: watching.moves,
            result: nil,
            reason: nil,
            ended: watching.over || watching.status != "ongoing"
        )
    }

    func withState(_ state: WsState, moves: [WsMoveRef]) -> SpectateGameState {
        SpectateGameState(
            id: id, pool: pool, rated: rated, variant: state.variant, white: white, black: black,
            fen: state.fen, duck: state.duck, pocket: pocket, sideToMove: state.sideToMove,
            lastMove: state.lastMove, check: state.check, status: state.status, clock: state.clock,
            moves: moves, result: result, reason: reason, ended: state.status != "ongoing"
        )
    }

    func withEnd(_ end: WsEnd) -> SpectateGameState {
        SpectateGameState(
            id: id, pool: pool, rated: rated, variant: variant, white: white, black: black,
            fen: fen, duck: duck, pocket: pocket, sideToMove: sideToMove, lastMove: lastMove,
            check: check, status: end.status, clock: end.clock, moves: moves,
            result: end.result, reason: end.reason, ended: true
        )
    }
}

/// Read-only WebSocket connection to one live game (`ws-protocol.md`'s
/// SPECTATING section): a fresh ws-ticket, connect with `&spectate=1`, send
/// `{"type":"watch","gameId":...}` once `hello` arrives, then just listen.
/// No sender exists here beyond `watch`/`unwatch` — no move/resign/chat.
///
/// Spectators never resume (`ws-protocol.md`: "Reconnect / resume" section)
/// — a dropped connection re-opens with a fresh ticket and re-sends `watch`
/// for the same `gameId`, which is exactly what a fresh connect already does,
/// so reconnect and initial connect share one code path.
@Observable
@MainActor
final class SpectateStore {
    let gameId: String
    let decoder = JSONDecoder()

    // MARK: - Published state

    var connection: ConnectionPhase = .closed
    var game: SpectateGameState?
    /// Set by `watchEnd` (bad/expired gameId, or the watch-timeout below) —
    /// distinct from `game?.ended`, which means the game itself finished
    /// normally and its final position is still worth showing.
    var unavailable = false
    var lastError: String?

    /// Wall-clock moment `game.clock` was captured — same contract as
    /// `SocketStore.clockAt`; `Clock` (Views/Board) reads this to self-tick.
    var clockAt: Date = .now

    /// App-wide display/input/sound preferences, injected post-construction
    /// by `SpectateView` (`onAppear { store.appSettings = settings }`) —
    /// same hand-off as `LiveGameDriver.appSettings`/`PuzzleDriver.appSettings`,
    /// since a plain `@Observable` store (not a view) can't read `@Environment`
    /// itself.
    var appSettings: SettingsStore?

    private var soundVolume: Double {
        guard let appSettings, appSettings.soundEnabled else { return 0 }
        return appSettings.soundVolume
    }

    // MARK: - Internals

    private var socketTask: URLSessionWebSocketTask?
    private var receiveLoopTask: Task<Void, Never>?
    private var watchTimeoutTask: Task<Void, Never>?
    private var shouldStayConnected = false

    init(gameId: String) {
        self.gameId = gameId
    }

    // MARK: - Lifecycle

    /// Idempotent — a second call while already connecting/open is a no-op.
    func watch() {
        guard connection == .closed else { return }
        shouldStayConnected = true
        connection = .connecting
        Task { [weak self] in await self?.attemptConnect() }
    }

    /// Explicit teardown. Best-effort `unwatch` frame first (the hub will
    /// also clean up on socket close, but this is more polite if the
    /// connection happens to linger a beat).
    func unwatch() {
        shouldStayConnected = false
        watchTimeoutTask?.cancel()
        receiveLoopTask?.cancel()
        if connection == .open { sendUnwatch() }
        socketTask?.cancel(with: .goingAway, reason: nil)
        socketTask = nil
        connection = .closed
    }

    private func attemptConnect() async {
        connection = .connecting
        do {
            let ticket = try await WsTicketService.shared.fetch(anonId: KeychainHelper.shared.anonymousId)
            guard shouldStayConnected else { return }
            guard let url = URL(string: "\(ticket.wsUrl)?ticket=\(ticket.ticket)&spectate=1") else {
                lastError = "The realtime server address is invalid."
                connection = .closed
                return
            }
            let task = URLSession.shared.webSocketTask(with: url)
            socketTask = task
            task.resume()
            listen(task)
        } catch {
            lastError = "Couldn't reach the realtime server."
            connection = .closed
        }
    }

    /// A dropped connection retries once, a beat later, as long as the view
    /// still wants to be watching — this is the "spectators never resume,
    /// re-send watch" behavior from `ws-protocol.md`, reusing the same
    /// connect path rather than a separate resume flow.
    private func scheduleReconnect() {
        guard shouldStayConnected else { return }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard let self, self.shouldStayConnected else { return }
            await self.attemptConnect()
        }
    }

    // MARK: - Receive loop

    private func listen(_ task: URLSessionWebSocketTask) {
        receiveLoopTask = Task { [weak self] in
            await self?.receiveLoop(task)
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                if let data = Self.payload(of: message) {
                    dispatch(data)
                }
            } catch {
                handleDisconnect()
                return
            }
        }
    }

    private static func payload(of message: URLSessionWebSocketTask.Message) -> Data? {
        switch message {
        case .data(let data): return data
        case .string(let text): return Data(text.utf8)
        @unknown default: return nil
        }
    }

    private func handleDisconnect() {
        guard connection != .closed else { return }
        connection = .closed
        socketTask = nil
        scheduleReconnect()
    }

    private func dispatch(_ data: Data) {
        guard let envelope = try? decoder.decode(WsEnvelope.self, from: data) else { return }
        switch envelope.type {
        case "hello": handleHello()
        case "watching": handleWatching(data)
        case "state": handleState(data)
        case "end": handleEnd(data)
        case "watchEnd": handleWatchEnd(data)
        case "error": handleError(data)
        default: break // queue/matched/chat/etc never arrive on a spectate-only connection
        }
    }

    // MARK: - Handlers

    private func handleHello() {
        connection = .open
        sendWatch()
        armWatchTimeout()
    }

    private func handleWatching(_ data: Data) {
        guard let watching = try? decoder.decode(WsWatching.self, from: data), watching.gameId == gameId else { return }
        watchTimeoutTask?.cancel()
        unavailable = false
        game = .from(watching: watching)
        clockAt = Date()
    }

    private func handleState(_ data: Data) {
        guard let state = try? decoder.decode(WsState.self, from: data), let current = game, current.id == state.gameId else { return }
        var moves = current.moves
        var appendedMove: WsMoveRef?
        if state.ply < moves.count {
            moves = Array(moves.prefix(state.ply)) // takeback: server re-broadcasts a LOWER ply
        } else if state.ply > moves.count, let lastMove = state.lastMove, let san = state.san {
            let ref = WsMoveRef(uci: lastMove, san: san)
            moves.append(ref)
            appendedMove = ref
        }
        let updated = current.withState(state, moves: moves)
        game = updated
        clockAt = Date()
        // Only a genuine new move (ply advanced past what we already had)
        // sounds — this naturally excludes the initial `watching` snapshot
        // (handled separately, never sounds) and takebacks (ply went DOWN,
        // no `appendedMove`), and can't double-fire for one move: a repeat
        // broadcast of the same ply no longer satisfies `ply > moves.count`
        // once the move's already in `moves`. `updated.ended` already
        // reflects this frame's `status`, so a mate-in-one move plays the
        // game-over tone directly, same as live play.
        if let appendedMove {
            playMoveSoundIfNeeded(san: appendedMove.san, isGameOver: updated.ended)
        }
    }

    /// Mirrors `LiveGameView.playOpponentMoveSoundIfNeeded` / `SoundEngine
    /// .playForSan` gating — a spectator only ever hears "the other side's"
    /// moves (there's no own-move case here), so every appended move sounds.
    private func playMoveSoundIfNeeded(san: String, isGameOver: Bool) {
        let volume = soundVolume
        guard volume > 0 else { return }
        SoundEngine.shared.playForSan(san, isGameOver: isGameOver, volume: volume)
    }

    private func handleEnd(_ data: Data) {
        guard let end = try? decoder.decode(WsEnd.self, from: data), let current = game, current.id == end.gameId else { return }
        game = current.withEnd(end)
        clockAt = Date()
    }

    private func handleWatchEnd(_ data: Data) {
        guard let frame = try? decoder.decode(WsWatchEnd.self, from: data), frame.gameId == gameId else { return }
        watchTimeoutTask?.cancel()
        unavailable = true
    }

    private func handleError(_ data: Data) {
        guard let frame = try? decoder.decode(WsErrorFrame.self, from: data) else { return }
        lastError = frame.message
    }

    /// If the hub never answers `watch` with either `watching` or
    /// `watchEnd` (a dropped frame, an edge case the protocol doc doesn't
    /// otherwise cover), don't leave the view spinning forever.
    private func armWatchTimeout() {
        guard game == nil else { return } // already have a snapshot from a prior connect; a reconnect shouldn't blank the view mid-refresh
        watchTimeoutTask?.cancel()
        watchTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard let self, !Task.isCancelled, self.game == nil else { return }
            self.unavailable = true
        }
    }

    // MARK: - Wire (watch/unwatch only — no move/resign/chat senders)

    private struct WatchFrame: Encodable {
        let type: String
        let gameId: String
    }

    private func sendWatch() {
        send(WatchFrame(type: "watch", gameId: gameId))
    }

    private func sendUnwatch() {
        send(WatchFrame(type: "unwatch", gameId: gameId))
    }

    private func send<T: Encodable>(_ frame: T) {
        guard let socketTask, let data = try? JSONEncoder().encode(frame) else { return }
        Task {
            try? await socketTask.send(.data(data))
        }
    }

    // MARK: - Clocks

    /// Elapsed-adjusted remaining time for `color`, clamped ≥0 — same
    /// contract as `SocketStore.remainingMs(for:)`.
    func remainingMs(for color: PieceColor) -> Int {
        guard let game else { return 0 }
        let base = game.clock(for: color)
        guard isClockRunning(for: color) else { return base }
        let elapsedMs = Int(Date().timeIntervalSince(clockAt) * 1000)
        return max(0, base - elapsedMs)
    }

    /// Clocks freeze until both sides have moved and never run once the
    /// game has ended — mirrors `SocketStore.isClockRunning`.
    func isClockRunning(for color: PieceColor) -> Bool {
        guard let game, !game.ended, game.moves.count >= 2 else { return false }
        return game.sideToMove == (color == .white ? "w" : "b")
    }
}

#if DEBUG
extension SpectateGameState {
    /// Preview/test-only stub. `SpectateGameState` has no `@Default`
    /// properties (it's never decoded directly — see the doc comment above),
    /// so a plain memberwise-style factory is safe to hand-construct here,
    /// same as `LiveGameState.mock()` in `SocketStore+Frames.swift`.
    static func mock(
        variant: String = "standard",
        status: String = "ongoing",
        ended: Bool = false,
        result: String? = nil,
        reason: String? = nil
    ) -> SpectateGameState {
        SpectateGameState(
            id: "abc123def456",
            pool: "5+3",
            rated: true,
            variant: variant,
            white: WsOpponent(name: "Nimzo42", rating: 1642, anon: false),
            black: WsOpponent(name: "Capa88", rating: 1590, anon: false),
            fen: "r1bqk2r/ppp2ppp/2n2n2/2bpp3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 2 6",
            duck: nil,
            pocket: nil,
            sideToMove: "w",
            lastMove: "d7d5",
            check: false,
            status: status,
            clock: WsClockPair(w: 214_000, b: 198_500),
            moves: [
                WsMoveRef(uci: "e2e4", san: "e4"), WsMoveRef(uci: "e7e5", san: "e5"),
                WsMoveRef(uci: "g1f3", san: "Nf3"), WsMoveRef(uci: "b8c6", san: "Nc6"),
                WsMoveRef(uci: "f1c4", san: "Bc4"), WsMoveRef(uci: "f8c5", san: "Bc5"),
                WsMoveRef(uci: "d2d3", san: "d3"), WsMoveRef(uci: "d7d5", san: "d5"),
            ],
            result: result,
            reason: reason,
            ended: ended
        )
    }
}

extension SpectateStore {
    /// Preview/test-only: a store already holding a snapshot, no network.
    static func preview(game: SpectateGameState, connection: ConnectionPhase = .open) -> SpectateStore {
        let store = SpectateStore(gameId: game.id)
        store.connection = connection
        store.game = game
        return store
    }

    /// Preview/test-only: a store still waiting on its first frame.
    static func previewConnecting(gameId: String = "abc123def456") -> SpectateStore {
        let store = SpectateStore(gameId: gameId)
        store.connection = .connecting
        return store
    }

    /// Preview/test-only: the requested game was unavailable from the start.
    static func previewUnavailable(gameId: String = "abc123def456") -> SpectateStore {
        let store = SpectateStore(gameId: gameId)
        store.connection = .open
        store.unavailable = true
        return store
    }
}
#endif

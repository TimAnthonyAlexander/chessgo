import Foundation

/// Where the WebSocket itself stands. `hello` flips `.connecting` → `.open`;
/// any receive-loop error or explicit `disconnect()` flips to `.closed`.
enum ConnectionPhase: Equatable, Sendable {
    case connecting
    case open
    case closed
}

/// Matchmaking status when there is no active game. `LiveGameState` (via
/// `SocketStore.game`) takes over once `matched`/`resume` arrives.
enum LobbyState: Equatable, Sendable {
    case idle
    case queued(pool: String, variant: String)
}

/// A draw/takeback offer's direction, or none outstanding. `.mine` is set
/// optimistically the moment the local player sends an offer — the server
/// echo (`drawOffered`/`takebackOffered` with `by == myColor`) just confirms
/// it rather than being the thing that first sets it.
enum OfferState: Equatable, Sendable {
    case none
    case mine
    case theirs
}

/// One in-game chat line. `id` is synthesized locally — the wire frame
/// carries no message id, only `gameId, by, name, text`.
struct ChatLine: Identifiable, Sendable, Equatable {
    let id = UUID()
    let by: String
    let name: String
    let text: String
}

/// Snapshot of an open private-invite challenge you created.
struct ChallengeInfo: Equatable, Sendable {
    let code: String
    let pool: String
    let color: String
    let rated: Bool
    let variant: String
}

/// The realtime hub connection (`ws-protocol.md`). Owns the
/// `URLSessionWebSocketTask`, the receive loop, reconnect/backoff, and every
/// piece of published state the live-game and lobby screens read.
///
/// Split across files for size: this file is the lifecycle (connect,
/// reconnect, resume-timeout, post-game fetch) plus the published state.
/// `SocketStore+Send.swift` has the client→server senders,
/// `SocketStore+Receive.swift` the receive loop and per-frame-type handlers,
/// `SocketStore+Frames.swift` the wire DTOs `Models/LiveGame.swift` doesn't
/// already define plus `LiveGameState` copy-helpers.
///
/// A plain `JSONDecoder`/`JSONEncoder` — no key conversion — because the hub
/// speaks camelCase on the wire already (unlike BaseAPI's snake_case REST
/// bodies, which `APIClient` converts separately).
@Observable
@MainActor
final class SocketStore {
    let decoder = JSONDecoder()
    static let encoder = JSONEncoder()

    // MARK: - Published state

    var connection: ConnectionPhase = .closed
    var lobby: LobbyState = .idle
    var challengeInfo: ChallengeInfo?
    var game: LiveGameState?
    var messages: [ChatLine] = []
    var drawOfferState: OfferState = .none
    var takebackOfferState: OfferState = .none
    var lastError: String?

    /// The finished, persisted game record fetched after `end` — the only
    /// authoritative source for the post-game rating delta (never derive it
    /// client-side; see `AnalysisService.game(id:)`'s doc comment).
    var postGame: Game?

    /// Wall-clock moment `game.clock` was captured. `Clock` (Views/Board)
    /// reads this plus `game.clock(for:)` to self-tick; `remainingMs(for:)`
    /// below is the one-shot equivalent for non-view logic.
    var clockAt: Date = .now

    /// Convenience accessor matching the task-level "challengeCode" field —
    /// `challengeInfo` carries the rest of the payload (pool/color/rated/variant)
    /// so Home doesn't have to re-derive it from the create call.
    var challengeCode: String? { challengeInfo?.code }

    // MARK: - Internals

    var socketTask: URLSessionWebSocketTask?
    var reconnectAttempt = 0
    var shouldStayConnected = false
    var resumeWaitTask: Task<Void, Never>?
    var receiveLoopTask: Task<Void, Never>?
    /// The single lobby action (queue/createChallenge/joinChallenge) waiting
    /// for the socket to open, replayed once `hello` arrives. Cleared once
    /// sent, or explicitly by a cancel call — see `SocketStore+Send.swift`.
    var pendingIntent: (() -> Void)?

    init() {}

    // MARK: - Connection lifecycle

    /// Idempotent — a second call while already connecting/open is a no-op.
    /// Mints a fresh ws-ticket on every attempt (60s TTL, never reused).
    func connect() {
        guard connection == .closed else { return }
        shouldStayConnected = true
        reconnectAttempt = 0
        connection = .connecting
        Task { [weak self] in await self?.attemptConnect() }
    }

    /// Explicit teardown (e.g. logout, app backgrounding policy). Does not
    /// touch `game`/`postGame` — a disconnected view of a finished game is
    /// still worth showing.
    func disconnect() {
        shouldStayConnected = false
        resumeWaitTask?.cancel()
        receiveLoopTask?.cancel()
        socketTask?.cancel(with: .goingAway, reason: nil)
        socketTask = nil
        connection = .closed
    }

    /// Drop the current/finished game and its chat/offers so the store is a
    /// clean slate for the next queue/challenge. Never called automatically —
    /// the live-game screen calls this when the player taps back to lobby.
    func leaveGame() {
        game = nil
        postGame = nil
        messages = []
        drawOfferState = .none
        takebackOfferState = .none
    }

    func attemptConnect() async {
        connection = .connecting
        do {
            let ticket = try await WsTicketService.shared.fetch(anonId: KeychainHelper.shared.anonymousId)
            guard shouldStayConnected else { return }
            // The hub keys live games by this `sub`. An install-UUID sub while a
            // token is held means /ws-ticket didn't honour the bearer — the bug
            // that made the same account look like two players (rest-api.md).
            Log.info("ws identity sub=\(Self.ticketSub(ticket.ticket)) anon=\(ticket.identity.anon) bearer=\(KeychainHelper.shared.token != nil)")
            openSocket(with: ticket)
        } catch {
            lastError = "Couldn't reach the realtime server."
            connection = .closed
            scheduleReconnect()
        }
    }

    /// Pull `sub` out of the ws-ticket's base64url payload, so the hub identity
    /// this device connects as is visible in the log and comparable with the
    /// browser's.
    static func ticketSub(_ ticket: String) -> String {
        let part = ticket.split(separator: ".").first.map(String.init) ?? ""
        var b64 = part.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        guard let data = Data(base64Encoded: b64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return "<undecodable>"
        }
        return "\(json["sub"] ?? "<none>")"
    }

    private func openSocket(with ticket: WsTicketResponse) {
        guard let url = URL(string: "\(ticket.wsUrl)?ticket=\(ticket.ticket)") else {
            lastError = "The realtime server address is invalid."
            connection = .closed
            scheduleReconnect()
            return
        }
        let task = URLSession.shared.webSocketTask(with: url)
        socketTask = task
        task.resume()
        listen(task)
    }

    /// `min(1000·2^n, 10000)` ms, per `ws-protocol.md`/frontend-features.md.
    /// `reconnectAttempt` is capped so the shift never overflows across a
    /// long-lived app session that reconnects many times.
    func scheduleReconnect() {
        guard shouldStayConnected else { return }
        let delayMs = min(1000 * (1 << reconnectAttempt), 10_000)
        reconnectAttempt = min(reconnectAttempt + 1, 10)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            guard let self, self.shouldStayConnected else { return }
            await self.attemptConnect()
        }
    }

    /// After `hello`, if `resume` hasn't arrived within ~1.5s and we were
    /// already holding a game, the hub has nothing to re-seat us into —
    /// treat it as ended. `handleIdle` (an explicit "no live game" signal)
    /// short-circuits this the moment it arrives instead of waiting it out.
    func armResumeTimeout() {
        resumeWaitTask?.cancel()
        guard game != nil else { return }
        resumeWaitTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard let self, !Task.isCancelled else { return }
            self.forceLocalGameEndedIfNeeded()
        }
    }

    func forceLocalGameEndedIfNeeded() {
        guard let current = game, !current.ended else { return }
        game = current.endedLocally()
        fetchPostGameResult(id: current.id)
    }

    /// The hub persists a finished game fire-and-forget, so an immediate
    /// `GET /games/{id}` right after `end` can 404/return stale data. Retry
    /// a handful of times ~600ms apart (frontend-features.md's rating-delta
    /// note) rather than trusting the first response.
    func fetchPostGameResult(id: String) {
        Task { [weak self] in
            guard let self else { return }
            for attempt in 0..<8 {
                if attempt > 0 {
                    try? await Task.sleep(nanoseconds: 600_000_000)
                }
                if let fetched = try? await AnalysisService.shared.game(id: id) {
                    self.postGame = fetched
                    return
                }
            }
        }
    }

    // MARK: - Clocks

    /// Elapsed-adjusted remaining time for `color`, clamped ≥0. `Clock`
    /// itself doesn't use this — it interpolates from `game.clock(for:)` +
    /// `clockAt` on its own `TimelineView` — this is for any other logic
    /// (low-time checks, flag detection) that needs a one-shot value.
    func remainingMs(for color: PieceColor) -> Int {
        guard let game else { return 0 }
        let base = game.clock(for: color)
        guard isClockRunning(for: color) else { return base }
        let elapsedMs = Int(Date().timeIntervalSince(clockAt) * 1000)
        return max(0, base - elapsedMs)
    }

    /// Clocks freeze until both sides have moved (`ply >= 2`) and never run
    /// once the game has ended.
    func isClockRunning(for color: PieceColor) -> Bool {
        guard let game, !game.ended, game.moves.count >= 2 else { return false }
        return game.sideToMove == (color == .white ? "w" : "b")
    }

    // MARK: - Local-only offer dismissal

    /// `ws-protocol.md` has no message to retract your own offer — only
    /// `drawDecline`/`takebackDecline`, which read as the RECEIVER rejecting
    /// it. Tapping "cancel" on your own outgoing offer only silences the
    /// local "waiting…" banner; the offer stays live server-side until the
    /// opponent responds or the game ends.
    func dismissDrawOffer() {
        if drawOfferState == .mine { drawOfferState = .none }
    }

    func dismissTakebackOffer() {
        if takebackOfferState == .mine { takebackOfferState = .none }
    }
}

#if DEBUG
extension SocketStore {
    /// Preview/test-only: a store already holding a live game, no network.
    static func preview(game: LiveGameState, connection: ConnectionPhase = .open) -> SocketStore {
        let store = SocketStore()
        store.connection = connection
        store.game = game
        return store
    }

    /// Preview-only: pretend the opponent just offered a draw.
    func simulateDrawOffered() {
        drawOfferState = .theirs
    }

    /// Preview-only: pretend the opponent just requested a takeback.
    func simulateTakebackOffered() {
        takebackOfferState = .theirs
    }
}
#endif

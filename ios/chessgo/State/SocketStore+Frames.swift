import Foundation

/// Wire DTOs the hub sends that `Models/LiveGame.swift` doesn't already
/// define (that file only has `hello`/`matched`/`state`/`resume`/`end` plus
/// the shared value types). These decode the rest of `ws-protocol.md`'s
/// server→client table. Same rule as `Models/LiveGame.swift`: plain
/// `Decodable`, camelCase properties matching the wire exactly, no
/// `.convertFromSnakeCase`.

struct WsQueued: Decodable, Sendable {
    let pool: String
    let variant: String
}

struct WsChallengeCreated: Decodable, Sendable {
    let code: String
    let pool: String
    let color: String
    @DefaultFalse var rated: Bool
    let variant: String
}

/// Shared shape for the several frames that are just `{gameId, ...}`.
struct WsGameRef: Decodable, Sendable {
    let gameId: String
}

/// `drawOffered`/`takebackOffered` share this shape. `by` is optional
/// because `ws-protocol.md` documents it as sometimes-absent on
/// `takebackOffered`; `drawOffered` always sends it but decoding it as
/// optional here costs nothing and is more resilient to drift.
struct WsOfferedBy: Decodable, Sendable {
    let gameId: String
    let by: String?
}

struct WsChat: Decodable, Sendable {
    let gameId: String
    let by: String
    @DefaultEmptyString var name: String
    let text: String
}

struct WsErrorFrame: Decodable, Sendable {
    let message: String
}

/// `activeGame` — the hub telling THIS connection that the account it belongs
/// to is playing a game somewhere else (matched on the laptop while the phone
/// sat in the lobby). A pointer only: `SocketStore.requestResume()` is what
/// takes the seat over and brings back a full `resume`.
struct WsActiveGame: Decodable, Sendable {
    let gameId: String
    @DefaultEmptyString var pool: String
    @DefaultEmptyString var variant: String
}

// MARK: - LiveGameState builders

/// `LiveGameState` (Models/LiveGame.swift) is never decoded directly off the
/// wire — it's built/updated from whichever frame just arrived. All its
/// properties are `let`, so every transition here returns a fresh copy
/// rather than mutating in place.
extension LiveGameState {
    func clock(for color: PieceColor) -> Int {
        color == .white ? clock.w : clock.b
    }

    /// `matched` doesn't carry `sideToMove` or `check` (a fresh game is
    /// never in check) — side to move is read off the FEN's own active-color
    /// field instead of assumed white, since Chess960 still starts as White
    /// but a future variant might not.
    static func from(matched: WsMatched) -> LiveGameState {
        LiveGameState(
            id: matched.gameId,
            color: matched.color,
            rated: matched.rated,
            variant: matched.variant,
            pool: matched.pool,
            timeControl: matched.timeControl,
            opponent: matched.opponent,
            fen: matched.fen,
            sideToMove: sideToMoveToken(fen: matched.fen),
            lastMove: nil,
            check: false,
            duck: matched.duck,
            pocket: matched.pocket,
            status: "ongoing",
            legalMoves: matched.legalMoves,
            clock: matched.clock,
            moves: [],
            result: nil,
            reason: nil,
            ended: false,
            opponentOnline: true
        )
    }

    static func from(resume: WsResume) -> LiveGameState {
        LiveGameState(
            id: resume.gameId,
            color: resume.color,
            rated: resume.rated,
            variant: resume.variant,
            pool: resume.pool,
            timeControl: resume.timeControl,
            opponent: resume.opponent,
            fen: resume.fen,
            sideToMove: resume.sideToMove,
            lastMove: resume.lastMove,
            check: resume.check,
            duck: resume.duck,
            pocket: resume.pocket,
            status: resume.status,
            legalMoves: resume.legalMoves,
            clock: resume.clock,
            moves: resume.moves,
            result: nil,
            reason: nil,
            ended: resume.status != "ongoing",
            opponentOnline: resume.opponentOnline
        )
    }

    /// `WsState` has no `pocket` field even for Crazyhouse (`ws-protocol.md`'s
    /// own `state` example omits it, and it's absent from the `WsState`
    /// struct) — an apparent protocol gap, since a drop/capture changes the
    /// pocket every ply. Carried forward unchanged from the last known value
    /// rather than guessed; flagged for the hub/protocol doc to confirm.
    func withState(_ state: WsState, moves: [WsMoveRef]) -> LiveGameState {
        LiveGameState(
            id: id, color: color, rated: rated, variant: state.variant, pool: pool,
            timeControl: timeControl, opponent: opponent, fen: state.fen, sideToMove: state.sideToMove,
            lastMove: state.lastMove, check: state.check, duck: state.duck, pocket: pocket,
            status: state.status, legalMoves: state.legalMoves, clock: state.clock, moves: moves,
            result: result, reason: reason, ended: state.status != "ongoing", opponentOnline: opponentOnline
        )
    }

    func withEnd(_ end: WsEnd) -> LiveGameState {
        LiveGameState(
            id: id, color: color, rated: rated, variant: variant, pool: pool, timeControl: timeControl,
            opponent: opponent, fen: fen, sideToMove: sideToMove, lastMove: lastMove, check: check,
            duck: duck, pocket: pocket, status: end.status, legalMoves: [], clock: end.clock, moves: moves,
            result: end.result, reason: end.reason, ended: true, opponentOnline: opponentOnline
        )
    }

    func withOpponentOnline(_ online: Bool) -> LiveGameState {
        LiveGameState(
            id: id, color: color, rated: rated, variant: variant, pool: pool, timeControl: timeControl,
            opponent: opponent, fen: fen, sideToMove: sideToMove, lastMove: lastMove, check: check,
            duck: duck, pocket: pocket, status: status, legalMoves: legalMoves, clock: clock, moves: moves,
            result: result, reason: reason, ended: ended, opponentOnline: online
        )
    }

    /// The reconnect/resume-timeout path (`SocketStore.forceLocalGameEndedIfNeeded`)
    /// — no server `end` frame arrived, so `result` stays `nil` and `reason`
    /// is a client-only sentinel the UI can special-case.
    func endedLocally() -> LiveGameState {
        LiveGameState(
            id: id, color: color, rated: rated, variant: variant, pool: pool, timeControl: timeControl,
            opponent: opponent, fen: fen, sideToMove: sideToMove, lastMove: lastMove, check: check,
            duck: duck, pocket: pocket, status: status, legalMoves: [], clock: clock, moves: moves,
            result: result, reason: reason ?? "connectionLost", ended: true, opponentOnline: false
        )
    }
}

private func sideToMoveToken(fen: String) -> String {
    let fields = fen.split(separator: " ")
    return fields.count > 1 && fields[1] == "b" ? "b" : "w"
}

#if DEBUG
extension LiveGameState {
    /// Preview/test-only stub — a mid-game position with a couple of moves
    /// played, used by `Views/Live` previews so they don't need a live socket.
    static func mock(
        color: String = "w",
        variant: String = "standard",
        status: String = "ongoing",
        ended: Bool = false,
        result: String? = nil,
        reason: String? = nil
    ) -> LiveGameState {
        LiveGameState(
            id: "abc123def456",
            color: color,
            rated: true,
            variant: variant,
            pool: "5+3",
            timeControl: WsTimeControl(base: 300_000, inc: 3_000),
            opponent: WsOpponent(name: "Nimzo42", rating: 1642, anon: false),
            fen: "r1bqk2r/ppp2ppp/2n2n2/2bpp3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 2 6",
            sideToMove: "w",
            lastMove: "d7d5",
            check: false,
            duck: nil,
            pocket: nil,
            status: status,
            legalMoves: ["g1f3", "d1e2", "e1g1", "f3e5", "f3d4", "f3g5", "f3h4", "b1c3", "b1d2", "a2a3", "a2a4"],
            clock: WsClockPair(w: 214_000, b: 198_500),
            moves: [
                WsMoveRef(uci: "e2e4", san: "e4"), WsMoveRef(uci: "e7e5", san: "e5"),
                WsMoveRef(uci: "g1f3", san: "Nf3"), WsMoveRef(uci: "b8c6", san: "Nc6"),
                WsMoveRef(uci: "f1c4", san: "Bc4"), WsMoveRef(uci: "f8c5", san: "Bc5"),
                WsMoveRef(uci: "d2d3", san: "d3"), WsMoveRef(uci: "d7d5", san: "d5"),
            ],
            result: result,
            reason: reason,
            ended: ended,
            opponentOnline: true
        )
    }
}
#endif

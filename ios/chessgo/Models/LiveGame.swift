import Foundation

/// Wire DTOs for the gomachine hub WebSocket (ws-protocol.md). The socket
/// layer (`State/SocketStore`, Wave 2) decodes these with a PLAIN
/// `JSONDecoder` — no `.convertFromSnakeCase` — because the hub already
/// sends camelCase. Every property name here must match the wire JSON
/// exactly; do not add snake_case CodingKeys.
///
/// This file only defines the DTOs, plus `LiveGameState`, the shape the UI
/// consumes. The socket layer owns opening the connection, dispatching on
/// `type`, folding `matched`/`state`/`resume` frames into `LiveGameState`,
/// and driving the local clock countdown (`clockAt = Date()` on each clock
/// update, `remaining = clock[sideToMove] - (now - clockAt)`, ~10Hz timer)
/// described in ws-protocol.md "Clocks". None of that lives here.

/// Peek at a frame's `type` before decoding the full payload.
struct WsEnvelope: Decodable {
    let type: String
}

/// Core wire values that are always present on matched/state/resume frames and
/// are also constructed in code (factories, previews), so plain stored
/// properties — a synthesized memberwise init and a synthesized Decodable init.
struct WsOpponent: Codable, Sendable {
    var name: String = ""
    var rating: Int = 0
    var anon: Bool = false
}

/// Both clocks, milliseconds remaining.
struct WsClockPair: Codable, Sendable {
    var w: Int = 0
    var b: Int = 0
}

/// Base time + increment, both milliseconds.
struct WsTimeControl: Codable, Sendable {
    var base: Int = 0
    var inc: Int = 0
}

struct WsMoveRef: Codable, Sendable {
    let uci: String
    let san: String
}

/// First frame on every connection.
struct WsHello: Decodable, Sendable {
    @DefaultEmptyString var name: String
    @DefaultFalse var anon: Bool
    @DefaultZero var rating: Int
}

/// Sent once when matchmaking pairs you into a new game.
struct WsMatched: Decodable, Sendable {
    let gameId: String
    let color: String
    @DefaultFalse var rated: Bool
    let pool: String
    let variant: String
    let fen: String
    let duck: String?
    let timeControl: WsTimeControl
    let clock: WsClockPair
    let opponent: WsOpponent
    @DefaultEmptyArray var legalMoves: [String]
    /// Crazyhouse only: white pocket upper-case, black lower-case (e.g. "PPNq").
    let pocket: String?
}

/// Sent after every move/takeback. A takeback re-broadcast has a LOWER `ply`
/// than the client's local move count — detect and truncate on the UI side.
struct WsState: Decodable, Sendable {
    let gameId: String
    let variant: String
    let fen: String
    let duck: String?
    let sideToMove: String
    let lastMove: String?
    let san: String?
    let status: String
    @DefaultFalse var check: Bool
    let clock: WsClockPair
    @DefaultZero var ply: Int
    @DefaultEmptyArray var legalMoves: [String]
}

/// Sent on reconnect if the identity has a live game. If this doesn't arrive
/// within ~1.5s of `hello` and the client held a local game, treat it as ended.
struct WsResume: Decodable, Sendable {
    let gameId: String
    let color: String
    @DefaultFalse var rated: Bool
    let pool: String
    let variant: String
    let fen: String
    let duck: String?
    let sideToMove: String
    let status: String
    @DefaultFalse var check: Bool
    let timeControl: WsTimeControl
    let clock: WsClockPair
    let opponent: WsOpponent
    @DefaultEmptyArray var legalMoves: [String]
    @DefaultEmptyArray var moves: [WsMoveRef]
    let lastMove: String?
    @DefaultFalse var opponentOnline: Bool
    let pocket: String?
}

/// What the hub's disconnect-grace expiry is worth to the viewer — it applies
/// the same insufficient-material rule a flag does, so a present player isn't
/// always awarded a win. Mirrors the web's `opponentGraceOutcome` union.
enum DisconnectGraceOutcome: String, Codable, Sendable {
    case win
    case draw
}

struct WsEnd: Decodable, Sendable {
    let gameId: String
    let result: String?
    let reason: String?
    let status: String
    let clock: WsClockPair
}

/// UI-facing live-game state. Never decoded directly off the wire — the
/// socket layer builds one from `matched`, updates it from `state`/`resume`/
/// `end`, and republishes it to the store. All `let` — updates are new copies.
struct LiveGameState: Decodable, Identifiable, Sendable {
    let id: String
    let color: String
    let rated: Bool
    let variant: String
    let pool: String
    let timeControl: WsTimeControl
    let opponent: WsOpponent
    let fen: String
    let sideToMove: String
    let lastMove: String?
    let check: Bool
    let duck: String?
    let pocket: String?
    let status: String
    let legalMoves: [String]
    let clock: WsClockPair
    let moves: [WsMoveRef]
    let result: String?
    let reason: String?
    let ended: Bool
    let opponentOnline: Bool
    /// Epoch-ms deadline the hub's disconnect-grace timer expires at, and what
    /// happens then — both `nil` while the opponent is present, and also
    /// `nil` for a beat after they drop: the hub refuses to arm the countdown
    /// until the clocks are running, so the first `opponentGone` can carry
    /// neither field and a second one arrives later with both.
    let opponentGraceDeadline: Date?
    let opponentGraceOutcome: DisconnectGraceOutcome?
}

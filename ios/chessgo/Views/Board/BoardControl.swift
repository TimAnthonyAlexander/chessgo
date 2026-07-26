import Foundation

/// Which gestures `BoardView` accepts. Default is both; a settings screen can
/// pin a driver to one so testing/accessibility flows are unambiguous.
enum BoardInputMethod: Sendable {
    case both
    case clickOnly
    case dragOnly
}

/// The abstraction every game mode (bot, live, puzzle) drives the board
/// through. A driver is a reference type (typically an `@Observable` store)
/// so `BoardView` can hold it as `any BoardControl` and read live state.
///
/// The driver owns the network round trip: `submit` is fire-and-forget from
/// the board's point of view. The board shows the move optimistically the
/// instant it calls `submit`, and clears that optimism the moment `fen`
/// changes — the driver doesn't need to coordinate that, it just updates
/// `fen` whenever the server confirms (or rejects and re-syncs) the position.
///
/// `orientation` doubles as "which color is the human player" for premove
/// piece ownership checks — true in every mode this ships for (bot/live/
/// puzzle all put the player's own color at the bottom).
protocol BoardControl: AnyObject {
    /// Current authoritative position. Never mutated in place — a new FEN
    /// string each time the driver hears from the server.
    var fen: String { get }

    /// Which color sits at the bottom of the board.
    var orientation: PieceColor { get }

    /// True when the server says it's the human's turn to move.
    var myTurn: Bool { get }

    /// Server-provided UCI legal moves for the side to move. Empty when it
    /// isn't the human's turn — the board falls back to permissive premove
    /// geometry in that case.
    var legalMoves: [String] { get }

    /// Last move played, UCI, for the last-move highlight. `nil` at game start.
    var lastMove: String? { get }

    /// True when the side to move is in check — the board finds that side's
    /// king square itself from `fen` and highlights it. Never computed by
    /// the board; this flag comes straight from the server.
    var inCheck: Bool { get }

    /// True when the driver allows queuing premoves while it isn't the
    /// human's turn (live/bot; puzzles set this false).
    var canPremove: Bool { get }

    /// True when the driver lets the user move WHICHEVER side is to move
    /// (analysis / free-explore), not just `orientation`'s color. Live/bot/
    /// puzzle leave this `false` (the default) so you can never move the
    /// opponent's pieces.
    var movesBothSides: Bool { get }

    /// Duck Chess: algebraic square the duck currently sits on, or `nil` if
    /// this isn't a Duck game. Server-provided, not part of the FEN.
    var duckSquare: String? { get }

    /// Crazyhouse: pocket string, white upper-case / black lower-case
    /// (e.g. "PPNq"), or `nil` outside Crazyhouse.
    var pocket: String? { get }

    /// True while the driver is between "piece move chosen" and "duck square
    /// chosen" in a Duck Chess turn. See `submitDuckPlacement` below.
    var duckPlacementActive: Bool { get }

    /// Which gestures the board accepts.
    var inputMethod: BoardInputMethod { get }

    /// If true, a promotion with more than one server-listed option is sent
    /// as queen without prompting. If false, `PromotionPicker` shows.
    var autoQueen: Bool { get }

    /// Submit a completed turn: plain UCI ("e2e4"/"e7e8q"), a Crazyhouse drop
    /// ("P@e4"), or — for non-Duck moves — anything else the wire format
    /// accepts. Fire-and-forget; the board already rendered it optimistically.
    func submit(_ uci: String)

    /// Duck Chess only. Called with just the target square ("d5") once the
    /// user taps an empty square while `duckPlacementActive` is true.
    ///
    /// Two-phase hand-off, KISS version: the driver runs the phase machine.
    /// When the human makes a piece move in a Duck game, the driver does NOT
    /// pass that straight to `submit` — it holds the pending piece move
    /// locally, applies it to the `fen` it exposes (optimistic), and flips
    /// `duckPlacementActive` to true. `BoardView` renders the duck marker and
    /// a placement affordance over empty squares; the next tap calls this
    /// method with just the square. The driver combines its held piece move
    /// with that square into the composite wire form ("e2e4:d5") and sends
    /// ONE `submit` for the whole turn, then flips `duckPlacementActive` back
    /// off. The board itself never knows or cares that Duck is two taps —
    /// it just has two entry points, gated by one flag.
    func submitDuckPlacement(_ square: String)
}

extension BoardControl {
    var duckSquare: String? { nil }
    var pocket: String? { nil }
    var duckPlacementActive: Bool { false }
    var inputMethod: BoardInputMethod { .both }
    var autoQueen: Bool { true }
    var movesBothSides: Bool { false }

    /// Default: treat it as a plain submit. Only Duck drivers need to
    /// override this with real compositing.
    func submitDuckPlacement(_ square: String) { submit(square) }
}

/// Static mock for `#Preview`s across this folder. Not used outside DEBUG
/// previews — nothing production reaches for it.
final class PreviewBoardControl: BoardControl {
    var fen: String
    var orientation: PieceColor
    var myTurn: Bool
    var legalMoves: [String]
    var lastMove: String?
    var inCheck: Bool
    var canPremove: Bool
    var duckSquare: String?
    var pocket: String?
    var duckPlacementActive: Bool
    var inputMethod: BoardInputMethod
    var autoQueen: Bool
    var submitted: [String] = []

    init(
        fen: String = ChessBoard.startFEN,
        orientation: PieceColor = .white,
        myTurn: Bool = true,
        legalMoves: [String] = [],
        lastMove: String? = nil,
        inCheck: Bool = false,
        canPremove: Bool = true,
        duckSquare: String? = nil,
        pocket: String? = nil,
        duckPlacementActive: Bool = false,
        inputMethod: BoardInputMethod = .both,
        autoQueen: Bool = true
    ) {
        self.fen = fen
        self.orientation = orientation
        self.myTurn = myTurn
        self.legalMoves = legalMoves
        self.lastMove = lastMove
        self.inCheck = inCheck
        self.canPremove = canPremove
        self.duckSquare = duckSquare
        self.pocket = pocket
        self.duckPlacementActive = duckPlacementActive
        self.inputMethod = inputMethod
        self.autoQueen = autoQueen
    }

    func submit(_ uci: String) { submitted.append(uci) }
    func submitDuckPlacement(_ square: String) { submitted.append(square) }
}

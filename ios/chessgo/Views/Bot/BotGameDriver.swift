import Foundation

/// Drives one bot game through `BoardControl`. Stateless REST underneath:
/// every submitted turn is one round trip to `POST /bot-games/{id}/move`
/// that returns the human's move AND the bot's reply already applied
/// (rest-api.md). No socket, no clocks, no server-side resign — resign and
/// new-game are 100% client-local (frontend-features.md: "resign & new-game
/// are 100% client-local, no server call").
///
/// Duck two-phase and Crazyhouse drops are wired per `BoardControl`'s
/// contract:
/// - **Duck**: `submit(_:)` intercepts the FIRST call of a turn (piece move)
///   when this is a Duck game and `duckPlacementActive` is still false — it
///   holds the move in `pendingDuckPieceMove`, applies it optimistically,
///   and flips `duckPlacementActive`. `BoardView` then routes the next tap
///   on an empty square to `submitDuckPlacement(_:)`, which composes
///   `"pieceUCI:duckSquare"` and sends ONE `/move` call. `DUCK_REVEAL_MS`
///   (550ms) holds before applying the bot's reply so the human's own duck
///   placement is visible for a beat first.
/// - **Crazyhouse**: drops arrive through the ordinary `submit(_:)` path as
///   `"P@e4"` — `BoardView` builds that string from `armedDrop` (a binding
///   the hosting view shares with `PocketView`) plus the server's
///   `legalMoves`, so this driver never needs to know a drop is happening
///   until the UCI string is already in hand. The one Crazyhouse-specific
///   piece here is `pocket`: bot-game Crazyhouse FENs carry the pocket
///   in-band as `...RNBQKBNR[PPnbrq] w ...` (`zugzwang/src/crazyhouse.cpp
///   zh_pocket_string` / `BotGame.php`) rather than as a separate wire
///   field like live games get, so this driver extracts the bracket itself.
@Observable
@MainActor
final class BotGameDriver: BoardControl {
    private(set) var game: BotGame?

    // MARK: BoardControl surface

    private(set) var fen: String = ChessBoard.startFEN
    private(set) var orientation: PieceColor
    private(set) var myTurn: Bool = false
    private(set) var legalMoves: [String] = []
    private(set) var lastMove: String?
    private(set) var duckSquare: String?
    private(set) var pocket: String?
    private(set) var duckPlacementActive: Bool = false

    var showCheck: Bool { Variant.hasCheck(variant.rawValue) }

    /// False for Duck and Double Move — premoving a piece move ahead of a
    /// duck placement (or ahead of your own second move) doesn't map onto
    /// a single queued move the way standard alternating play does.
    var canPremove: Bool {
        switch variant {
        case .duck, .doublemove: return false
        default: return game != nil
        }
    }

    /// App-wide display/input/sound preferences. `nil` until the hosting
    /// view (`BotGameView`) injects the environment's `SettingsStore` post-
    /// construction — every read below falls back to the pre-settings
    /// hardcoded default so previews and any pre-injection window still
    /// behave exactly as before.
    var appSettings: SettingsStore?

    var autoQueen: Bool { appSettings?.autoQueen ?? true }
    var inputMethod: BoardInputMethod { appSettings?.moveMethod.boardInputMethod ?? .both }

    private var soundVolume: Double {
        guard let appSettings, appSettings.soundEnabled else { return 0 }
        return appSettings.soundVolume
    }

    // MARK: Bot-game specific published state

    private(set) var isLoading = false
    private(set) var botThinking = false
    var errorMessage: String?
    private(set) var resigned = false
    private(set) var moves: [GameMove] = []

    let settings: BotSettings
    /// "w"/"b", resolved once from `settings.humanColor` at init — a
    /// "random" preference rolls a real color here and start()/retries
    /// reuse the same one rather than re-rolling.
    private let resolvedHumanColor: String
    private var pendingDuckPieceMove: String?

    static let duckRevealDelayMs: UInt64 = 550

    init(settings: BotSettings) {
        self.settings = settings
        switch settings.humanColor {
        case "w", "b": resolvedHumanColor = settings.humanColor
        default: resolvedHumanColor = Bool.random() ? "w" : "b"
        }
        orientation = resolvedHumanColor == "b" ? .black : .white
    }

    /// The variant actually in play. Before the server confirms (or if
    /// somehow decoded oddly), falls back to what setup requested — always
    /// one of the eight known cases either way.
    var variant: Variant {
        game.flatMap { Variant(rawValue: $0.variant) } ?? settings.variant
    }

    var isGameOver: Bool {
        resigned || (game.map { $0.status != "ongoing" } ?? false)
    }

    /// Plain-language result line for the post-game banner, `nil` while the
    /// game is still ongoing.
    var outcomeText: String? {
        if resigned { return "You resigned." }
        guard let game, game.status != "ongoing" else { return nil }
        switch game.status {
        case "checkmate":
            let humanWon = (game.humanColor == "w" && game.result == "1-0")
                || (game.humanColor == "b" && game.result == "0-1")
            return humanWon ? "Checkmate — you win." : "Checkmate — the bot wins."
        case "stalemate":
            return "Stalemate. Draw."
        default:
            return game.status.hasPrefix("draw") ? "Draw." : game.status.capitalized
        }
    }

    var canUndo: Bool {
        guard let game, !resigned, !isLoading, !botThinking, game.status == "ongoing" else { return false }
        guard variant != .duck, variant != .doublemove else { return false }
        return !moves.isEmpty
    }

    // MARK: - Lifecycle

    func start() async {
        guard game == nil else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let created = try await BotService.shared.create(
                rating: settings.resolvedRating,
                humanColor: resolvedHumanColor,
                variant: settings.variant,
                fen: nil
            )
            apply(created)
        } catch let error as APIError {
            errorMessage = error.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - BoardControl

    /// Plain UCI moves and Crazyhouse drops go straight to the server. A
    /// Duck piece move — the first tap of the turn, before a duck square is
    /// chosen — is intercepted instead: held locally and applied
    /// optimistically, with no network call yet. See the type doc comment.
    func submit(_ uci: String) {
        guard game != nil, !isGameOver else { return }
        if variant == .duck, !duckPlacementActive {
            pendingDuckPieceMove = uci
            applyOptimistic(uci)
            myTurn = false
            duckPlacementActive = true
            return
        }
        performSubmit(uci)
    }

    /// Duck Chess only: combine the held piece move with the tapped duck
    /// square into `"pieceUCI:duckSquare"` and send the whole turn as one
    /// `/move` call.
    func submitDuckPlacement(_ square: String) {
        guard let pendingDuckPieceMove else { return }
        let composite = "\(pendingDuckPieceMove):\(square)"
        self.pendingDuckPieceMove = nil
        duckPlacementActive = false
        duckSquare = square
        lastMove = composite
        legalMoves = []
        performSubmit(composite, applyOptimistically: false)
    }

    // MARK: - Submit machinery

    /// Renders a move locally the instant it's chosen, before the network
    /// round trip resolves — `ChessBoard.applying` is best-effort rendering
    /// only (per its own doc comment), which is exactly the fidelity an
    /// optimistic preview needs. Skipped for the Duck composite send since
    /// both halves of that turn were already applied incrementally by the
    /// two calls above.
    private func applyOptimistic(_ uci: String) {
        var board = ChessBoard(fen: fen).withPocket(pocket)
        board = board.applying(uci)
        fen = board.fen()
        pocket = board.pocket
        lastMove = uci
        legalMoves = []
    }

    private func performSubmit(_ uci: String, applyOptimistically: Bool = true) {
        guard let game else { return }
        let knownGood = game
        let isDuckGame = knownGood.variant == Variant.duck.rawValue

        // Own move sounds the instant it's committed — before the network
        // round trip, using the pre-move board to guess capture/castle/
        // promotion (the server SAN isn't known yet).
        let preBoard = ChessBoard(fen: fen).withPocket(pocket)
        playOwnMoveSound(uci: uci, preBoard: preBoard)

        if applyOptimistically { applyOptimistic(uci) }
        myTurn = false
        botThinking = true
        errorMessage = nil

        Task {
            defer { botThinking = false }
            do {
                let updated = try await BotService.shared.move(id: knownGood.id, move: uci)
                if isDuckGame {
                    try? await Task.sleep(nanoseconds: Self.duckRevealDelayMs * 1_000_000)
                }
                apply(updated)
                playReplySound(for: updated)
            } catch let error as APIError {
                errorMessage = error.errorDescription
                apply(knownGood) // illegal move (422) or a transport hiccup — resync to last-known-good
            } catch {
                errorMessage = error.localizedDescription
                apply(knownGood)
            }
        }
    }

    /// Synchronous own-move sound: SAN isn't available yet (the server
    /// hasn't responded), so this reconstructs just enough of one —
    /// "x"/"="/"O-O" — from the pre-move board to pick the right tone.
    private func playOwnMoveSound(uci: String, preBoard: ChessBoard) {
        let volume = soundVolume
        guard volume > 0 else { return }
        SoundEngine.shared.playForSan(Self.pseudoSan(uci: uci, board: preBoard), isGameOver: false, volume: volume)
    }

    /// The bot's reply sound, fired once the server response is applied. If
    /// the human's own move ended the game with no bot reply, this plays the
    /// game-over cue instead (the human's move already sounded synchronously
    /// as a plain move/capture in `playOwnMoveSound`).
    private func playReplySound(for game: BotGame) {
        let volume = soundVolume
        guard volume > 0, let last = game.moves.last else { return }
        if last.by == "human" {
            if game.status != "ongoing" { SoundEngine.shared.play(.end, volume: volume) }
            return
        }
        SoundEngine.shared.playForSan(last.san, isGameOver: game.status != "ongoing", volume: volume)
    }

    /// Builds just enough of a SAN string ("x"/"="/"O-O" markers) for
    /// `SoundEngine.playForSan` to pick the right tone, without a real move
    /// generator. Composite Duck strings ("e2e4:d5") don't parse as a plain
    /// `Move` and fall back to a bare move tone.
    private static func pseudoSan(uci: String, board: ChessBoard) -> String {
        guard let move = Move(uci: uci) else { return "" }
        var san = ""
        if board.piece(at: move.from)?.kind == .king, abs(move.from.file - move.to.file) == 2 {
            san += "O-O"
        }
        if board.piece(at: move.to) != nil { san += "x" }
        if move.promotion != nil { san += "=" }
        return san
    }

    // MARK: - Undo / resign / new game

    /// Full round: pops the bot's reply and the human's move together.
    /// Disabled for Duck/Double Move server-side too (422) — `canUndo`
    /// mirrors that so the button never fires a doomed request.
    func undo() async {
        guard canUndo, let game else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let updated = try await BotService.shared.undo(id: game.id)
            apply(updated)
        } catch let error as APIError {
            errorMessage = error.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Client-local only — there is no bot-game resign endpoint. Marks the
    /// human as having lost and freezes further input.
    func resign() {
        guard game != nil, !isGameOver else { return }
        resigned = true
        myTurn = false
        duckPlacementActive = false
        pendingDuckPieceMove = nil
    }

    /// Client-local only. Wipes this driver back to its pre-game state; the
    /// hosting view is expected to pop back to setup right after calling
    /// this (a fresh `BotGameDriver` is created for the next game).
    func newGame() {
        game = nil
        fen = ChessBoard.startFEN
        myTurn = false
        legalMoves = []
        lastMove = nil
        duckSquare = nil
        pocket = nil
        duckPlacementActive = false
        pendingDuckPieceMove = nil
        resigned = false
        botThinking = false
        isLoading = false
        errorMessage = nil
        moves = []
    }

    // MARK: - Applying a server response

    private func apply(_ game: BotGame) {
        self.game = game
        fen = game.fen
        orientation = game.humanColor == "b" ? .black : .white
        myTurn = game.yourTurn
        legalMoves = game.legalMoves
        moves = game.moves
        lastMove = game.moves.last?.uci
        duckSquare = game.duck
        pocket = Variant(rawValue: game.variant) == .crazyhouse ? Self.extractPocket(fromFen: game.fen) : nil
        duckPlacementActive = false
        pendingDuckPieceMove = nil
    }

    /// Bot-game Crazyhouse FENs embed the pocket in the placement field —
    /// `"...RNBQKBNR[PPnbrq] w ..."` — rather than as a separate wire field
    /// (see the type doc comment). `ChessBoard.init(fen:)` already ignores
    /// the bracket harmlessly while parsing placement; this pulls its
    /// contents out separately for `PocketView`.
    private static func extractPocket(fromFen fen: String) -> String {
        guard let open = fen.firstIndex(of: "["), let close = fen.firstIndex(of: "]"), open < close else {
            return ""
        }
        return String(fen[fen.index(after: open)..<close])
    }

}

/// Reference identity is enough for `navigationDestination(item:)` to track
/// which driver (if any) is currently pushed.
extension BotGameDriver: Hashable {
    nonisolated static func == (lhs: BotGameDriver, rhs: BotGameDriver) -> Bool { lhs === rhs }
    nonisolated func hash(into hasher: inout Hasher) { hasher.combine(ObjectIdentifier(self)) }
}

#if DEBUG
extension BotGameDriver {
    /// Preview-only: a driver already past setup, seeded with a mid-game
    /// position, so `BotGameView` previews don't need a live server.
    static func preview(
        fen: String = "r1bqk2r/ppp2ppp/2n2n2/2bpp3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 2 6",
        variant: Variant = .standard,
        humanColor: String = "w",
        legalMoves: [String] = ["g1f3", "d1e2", "e1g1", "f3e5", "f3d4"],
        moves: [GameMove] = [
            GameMove(ply: 1, uci: "e2e4", san: "e4", by: "human", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", eval: nil, duck: nil),
            GameMove(ply: 2, uci: "e7e5", san: "e5", by: "bot", fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", eval: nil, duck: nil),
        ],
        yourTurn: Bool = true,
        status: String = "ongoing",
        result: String? = nil
    ) -> BotGameDriver {
        let driver = BotGameDriver(settings: BotSettings(variant: variant, rating: 1500, humanColor: humanColor))
        // BotGame's stored properties are property-wrapper-backed
        // (`@DefaultZero`/`@DefaultEmptyArray`/`@DefaultFalse`), so there's
        // no plain memberwise init taking raw `Int`/`[GameMove]`/`Bool`
        // values to call directly here. Round-tripping through JSON (the
        // real path `apply(_:)` always goes through) is the straightforward
        // way to build one for a preview.
        let wire = PreviewBotGameWire(
            id: "preview-game", rating: 1500, humanColor: humanColor, variant: variant.rawValue,
            duck: nil, fen: fen, sideToMove: "w", status: status, result: result,
            moves: moves, legalMoves: legalMoves, yourTurn: yourTurn
        )
        guard let data = try? JSONEncoder().encode(wire), let game = try? JSONDecoder().decode(BotGame.self, from: data) else {
            return driver
        }
        driver.apply(game)
        return driver
    }
}

/// Plain-Encodable mirror of the bot-game wire shape, used only to build
/// `BotGame` previews above without fighting its `@Default*` property
/// wrappers.
private struct PreviewBotGameWire: Encodable {
    let id: String
    let rating: Int
    let humanColor: String
    let variant: String
    let duck: String?
    let fen: String
    let sideToMove: String
    let status: String
    let result: String?
    let moves: [GameMove]
    let legalMoves: [String]
    let yourTurn: Bool
}
#endif

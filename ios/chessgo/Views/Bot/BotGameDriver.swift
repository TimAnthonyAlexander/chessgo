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
/// - **Secret Queen**: two things predate a normal turn. First, the game
///   itself doesn't exist until `start(secretSquare:)` is called with the
///   player's chosen home-rank pawn — `BotGameView` shows a designation step
///   on the real board (`pickDesignation(_:)` drives its badge) instead of
///   calling plain `start()`. Second, once the game is live, `secretQueenSquare`
///   badges the player's own hidden pawn, and `performSubmit` detects a
///   revealing move and patches the optimistic board to a real queen — and
///   clears the badge — the same frame the move is committed (see
///   `revealsOwnSecretQueen`'s doc comment for why that can't wait for the
///   server). `docs/tasks/open/secret-queen.md` is the full design.
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

    /// Secret Queen only. Before the game exists: the square tapped so far in
    /// designation (`pickDesignation(_:)`), not yet confirmed. Once the game
    /// exists: the human's own still-hidden square, straight off
    /// `BotGame.secretSquare` — the server already redacts the opponent's out
    /// of the response, so there's nothing to filter here. `nil` the instant
    /// `optimisticReveal` is set, so the badge disappears the same frame the
    /// queen artwork appears rather than a request later.
    var secretQueenSquare: String? {
        guard variant == .secretqueen, optimisticReveal == nil else { return nil }
        return game?.secretSquare ?? designationPick
    }

    private(set) var designationPick: String?
    private(set) var optimisticReveal: String?
    /// Plain-words reveal note ("Black's e-pawn was a secret queen."), or
    /// `nil` between reveals. `BotGameView` shows + the driver auto-clears it
    /// after a few seconds — see `scheduleRevealNoteClear`.
    private(set) var revealNote: String?
    private var revealNoteClearTask: Task<Void, Never>?

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

    /// A specific starting position to hand `POST /bot-games`, e.g. a Tutor
    /// "replay this position" drill (`TutorDrillPosition.fen`). `nil` starts
    /// from the normal position, per `settings.variant`.
    let startFen: String?
    /// Display-only context for a Tutor "drill this opening" deep link — the
    /// game itself starts from the normal position (no `startFen`); this is
    /// just the opening name to label the screen with. Mirrors the web's
    /// `BotGame.tsx` `openingName` state (`?opening=<name>` with no `fen`).
    let openingLabel: String?

    static let duckRevealDelayMs: UInt64 = 550

    init(settings: BotSettings, startFen: String? = nil, openingLabel: String? = nil) {
        self.settings = settings
        self.startFen = startFen
        self.openingLabel = openingLabel
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
        // Duck/Double Move: undo doesn't map onto a single reversible step.
        // Secret Queen: refused server-side once either secret has revealed —
        // un-revealing information the human already saw is incoherent
        // (docs/tasks/open/secret-queen.md "BaseAPI") — so there's nothing
        // for the button to usefully do here either.
        guard variant != .duck, variant != .doublemove, variant != .secretqueen else { return false }
        return !moves.isEmpty
    }

    // MARK: - Lifecycle

    /// `secretSquare` is Secret Queen only — the player's confirmed
    /// designation ("e2"), or `nil` to let the server pick one at random
    /// (never a fixed default, which would be readable by the opponent).
    /// Ignored by every other variant. `BotGameView` calls this once the
    /// designation step (`pickDesignation(_:)`) is confirmed; every other
    /// variant calls the no-argument form straight from setup.
    func start(secretSquare: String? = nil) async {
        guard game == nil else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let created = try await BotService.shared.create(
                rating: settings.resolvedRating,
                humanColor: resolvedHumanColor,
                variant: settings.variant,
                fen: startFen,
                secretSquare: secretSquare
            )
            apply(created)
            // The opener can theoretically already be a reveal if the human
            // plays Black and the bot's first move unmasks its own queen —
            // vanishingly rare with the concealment veto, but a real case the
            // engine can produce, so it's checked the same as any other move.
            if variant == .secretqueen { narrateReveal(in: created.moves) }
        } catch let error as APIError {
            errorMessage = error.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Secret Queen designation

    /// Called as the player taps candidate pawns on the pre-game board
    /// (`BotGameView`'s designation step) — purely local, drives
    /// `secretQueenSquare`'s badge before anything is committed.
    /// `start(secretSquare:)` is what actually creates the game.
    func pickDesignation(_ square: Square?) {
        designationPick = square?.algebraic
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
    /// two calls above. If `performSubmit` just set `optimisticReveal`
    /// (Secret Queen), the destination is patched to a real queen here too —
    /// `applying(_:)` on its own would move whatever piece already sat on the
    /// from-square, which for a still-hidden queen is a plain pawn by design
    /// (see `ChessBoard.withPiece`'s doc comment).
    private func applyOptimistic(_ uci: String) {
        var board = ChessBoard(fen: fen).withPocket(pocket)
        board = board.applying(uci)
        if let optimisticReveal, let square = Square(algebraic: optimisticReveal) {
            board = board.withPiece(Piece(color: humanPieceColor, kind: .queen), at: square)
        }
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

        // Secret Queen: flip our own queen to real queen artwork — and clear
        // its badge — the instant we commit a revealing move, not when the
        // server answers. See `revealsOwnSecretQueen`'s doc comment for why.
        let revealsNow = applyOptimistically && revealsOwnSecretQueen(uci: uci, board: preBoard)
        if revealsNow, let move = Move(uci: uci) {
            optimisticReveal = move.to.algebraic
            playRevealSound()
        }

        if applyOptimistically { applyOptimistic(uci) }
        myTurn = false
        botThinking = true
        errorMessage = nil

        let priorMoveCount = moves.count
        Task {
            defer { botThinking = false }
            do {
                let updated = try await BotService.shared.move(id: knownGood.id, move: uci)
                if isDuckGame {
                    try? await Task.sleep(nanoseconds: Self.duckRevealDelayMs * 1_000_000)
                }
                apply(updated)
                playReplySound(for: updated)
                if variant == .secretqueen {
                    // Skip the sound if this move already played it
                    // optimistically above — the web plays it twice here
                    // (once optimistic, once on the real response landing);
                    // that's an artifact of its own timing, not something
                    // worth reproducing on a client that can just track it.
                    narrateReveal(in: Array(updated.moves.dropFirst(min(priorMoveCount, updated.moves.count))), skipSound: revealsNow)
                }
            } catch let error as APIError {
                errorMessage = error.errorDescription
                apply(knownGood) // illegal move (422) or a transport hiccup — resync to last-known-good
            } catch {
                errorMessage = error.localizedDescription
                apply(knownGood)
            }
        }
    }

    /// The human's own color as `PieceColor`, resolved once at init (see
    /// `resolvedHumanColor`) — used wherever driver-local logic needs it as
    /// an enum rather than the wire's "w"/"b" string.
    private var humanPieceColor: PieceColor { resolvedHumanColor == "b" ? .black : .white }

    /// Whether `uci`, played from `board` (the position BEFORE this move),
    /// reveals this driver's OWN secret queen: it starts on the still-hidden
    /// square (`game.secretSquare`, which the server has already blanked
    /// once it reveals — so this can't refire) and isn't pawn-shaped.
    ///
    /// This exists only so the board can show the queen a frame early. A bot
    /// game applies the human move AND the bot's reply in ONE request
    /// (`BotService.move`), so waiting for that response to show the reveal
    /// would display the human's own queen a whole move late — after the
    /// opponent had already replied to it as if it were still hidden. The
    /// server decides the real rule (`secretqueen.cpp`) and its FEN is what
    /// `apply(_:)` renders; this only controls when the PLAYER sees it.
    private func revealsOwnSecretQueen(uci: String, board: ChessBoard) -> Bool {
        guard variant == .secretqueen, let mySquare = game?.secretSquare, uci.hasPrefix(mySquare) else { return false }
        return !SecretQueen.isPawnShaped(uci: uci, color: humanPieceColor, board: board)
    }

    private func playRevealSound() {
        let volume = soundVolume
        guard volume > 0 else { return }
        SoundEngine.shared.play(.promote, volume: volume)
    }

    /// Surfaces the FIRST reveal among `freshMoves` (there's realistically
    /// only ever one) — the human's own move and/or the bot's reply,
    /// whichever unmasked a hidden queen. `skipSound` avoids re-cueing the
    /// promote chime for a self-reveal `performSubmit` already sounded
    /// optimistically. Auto-clears after a few seconds so it doesn't linger.
    private func narrateReveal(in freshMoves: [GameMove], skipSound: Bool = false) {
        guard let entry = freshMoves.first(where: { $0.reveal?.didReveal == true }), let reveal = entry.reveal else { return }
        // Whose queen this was. The mover is known from `by`; a CAPTURE
        // reveal unmasks the OPPONENT's queen, not the mover's — the one case
        // where the two come apart (see `SecretQueen.revealMessage`).
        let mover: PieceColor = entry.by == "human" ? humanPieceColor : humanPieceColor.opposite
        let owner: PieceColor = reveal.captured ? mover.opposite : mover
        revealNote = SecretQueen.revealMessage(entry: entry, reveal: reveal, owner: owner)
        if !skipSound { playRevealSound() }
        scheduleRevealNoteClear()
    }

    private func scheduleRevealNoteClear() {
        revealNoteClearTask?.cancel()
        revealNoteClearTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_500_000_000)
            guard let self, !Task.isCancelled else { return }
            self.revealNote = nil
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
        designationPick = nil
        optimisticReveal = nil
        revealNoteClearTask?.cancel()
        revealNote = nil
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
        // The server's FEN always wins — once its response lands there's no
        // more optimism to hold onto, and no pre-game designation left either.
        designationPick = nil
        optimisticReveal = nil
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
        result: String? = nil,
        secretSquare: String? = nil
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
            moves: moves, legalMoves: legalMoves, yourTurn: yourTurn, secretSquare: secretSquare
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
    let secretSquare: String?
}
#endif

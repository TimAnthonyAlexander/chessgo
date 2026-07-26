import Foundation

/// Drives the puzzle board through one puzzle's phase machine (loading →
/// intro → solving → checking → solved/failed, or empty on a load failure).
///
/// Session-level concerns — theme/time-format selection, the countdown
/// clock, win/loss history, and the terminal "advance to the next puzzle"
/// timer — live in `PuzzlesView`; this driver only ever knows about the
/// puzzle in front of it, matching the web's `beginPuzzle`/`onMove` split
/// from `Puzzles.tsx`.
///
/// `canPremove` is always false: a puzzle has exactly one right answer per
/// ply, so queuing a premove would just be moving blind.
@Observable
@MainActor
final class PuzzleDriver: BoardControl {
    enum Phase: Equatable {
        case loading
        case intro
        case solving
        case checking
        case solved
        case failed
        case empty
    }

    // MARK: - BoardControl

    private(set) var fen: String = ChessBoard.startFEN
    private(set) var orientation: PieceColor = .white
    private(set) var myTurn: Bool = false
    private(set) var legalMoves: [String] = []
    private(set) var lastMove: String?

    /// Puzzle endpoints (`rest-api.md`) don't send a check flag the way live/
    /// bot games do, so this stays false — a known v1 gap, not a client-side
    /// legality computation (the engine still owns rules everywhere else).
    let inCheck: Bool = false
    let canPremove: Bool = false

    /// App-wide display/input/sound preferences. `nil` until the hosting
    /// view (`PuzzlesView`) injects the environment's `SettingsStore`
    /// post-construction — every read below falls back to the pre-settings
    /// hardcoded default so previews behave exactly as before.
    var appSettings: SettingsStore?

    var autoQueen: Bool { appSettings?.autoQueen ?? true }
    var inputMethod: BoardInputMethod { appSettings?.moveMethod.boardInputMethod ?? .both }

    private var soundVolume: Double {
        guard let appSettings, appSettings.soundEnabled else { return 0 }
        return appSettings.soundVolume
    }

    private func playSound(_ event: SoundEngine.SoundEvent) {
        let volume = soundVolume
        guard volume > 0 else { return }
        SoundEngine.shared.play(event, volume: volume)
    }

    // MARK: - Puzzle state

    private(set) var phase: Phase = .loading
    private(set) var puzzle: PuzzleNext?
    private(set) var result: PuzzleMoveResult?
    private(set) var errorMessage: String?
    private(set) var ply: Int = 1

    private let authStore: AuthStore

    /// Bumped on every `load`/`loadDaily` call. Async work (the intro delay,
    /// the mid-puzzle continuation delay, an in-flight move request) checks
    /// this before mutating state, so a `Skip` fired mid-animation can't let
    /// a stale task stomp the next puzzle's state.
    private var loadToken = UUID()

    init(authStore: AuthStore) {
        self.authStore = authStore
    }

    // MARK: - Loading a puzzle

    func load(theme: PuzzleTheme) {
        Task { await loadNext(theme: theme) }
    }

    func loadDaily() {
        Task { await loadDailyPuzzle() }
    }

    private func loadNext(theme: PuzzleTheme) async {
        let token = beginLoad()
        do {
            let next = try await PuzzleService.shared.next(theme: theme.queryValue)
            guard token == loadToken else { return }
            begin(next, token: token)
        } catch {
            guard token == loadToken else { return }
            Log.warn("PuzzleDriver.load: \(error.localizedDescription)")
            phase = .empty
            errorMessage = "No puzzle found for this filter. Try another theme."
        }
    }

    private func loadDailyPuzzle() async {
        let token = beginLoad()
        do {
            let next = try await PuzzleService.shared.daily()
            guard token == loadToken else { return }
            begin(next, token: token)
        } catch {
            guard token == loadToken else { return }
            Log.warn("PuzzleDriver.loadDaily: \(error.localizedDescription)")
            phase = .empty
            errorMessage = "Could not load today's puzzle."
        }
    }

    private func beginLoad() -> UUID {
        let token = UUID()
        loadToken = token
        phase = .loading
        errorMessage = nil
        result = nil
        lastMove = nil
        return token
    }

    /// Seed solving state from a freshly-fetched (or handed-in, e.g. the
    /// daily) puzzle, then run the intro beat: show the pre-move position,
    /// then "play" the opponent's setup move ~480ms later before going
    /// interactive — matches the web's `beginPuzzle`.
    private func begin(_ next: PuzzleNext, token: UUID) {
        puzzle = next
        orientation = next.color == "b" ? .black : .white
        fen = next.startFen
        legalMoves = []
        lastMove = nil
        ply = next.ply
        myTurn = false
        phase = .intro

        Task {
            try? await Task.sleep(nanoseconds: 480_000_000)
            guard token == self.loadToken else { return }
            self.fen = next.fen
            self.lastMove = next.opponentMove
            self.legalMoves = next.legalMoves
            self.myTurn = true
            self.phase = .solving
        }
    }

    // MARK: - Submitting a move

    /// Fire-and-forget from `BoardView`'s point of view: the board already
    /// rendered the move optimistically before calling this.
    func submit(_ uci: String) {
        guard phase == .solving, let puzzle else { return }
        let token = loadToken
        let baseFen = fen
        let baseLastMove = lastMove
        let submittedPly = ply

        fen = ChessBoard(fen: baseFen).applying(uci).fen()
        lastMove = uci
        myTurn = false
        phase = .checking

        Task {
            do {
                let response = try await PuzzleService.shared.move(
                    id: puzzle.id, move: uci, fen: baseFen, ply: submittedPly
                )
                guard token == self.loadToken else { return }
                await handle(response, baseFen: baseFen, token: token)
            } catch {
                guard token == self.loadToken else { return }
                Log.warn("PuzzleDriver.submit: \(error.localizedDescription)")
                // Transport/server hiccup, not a wrong answer — revert the
                // optimistic move and let the player retry.
                fen = baseFen
                lastMove = baseLastMove
                myTurn = true
                phase = .solving
                errorMessage = "Move failed. Try again."
            }
        }
    }

    /// The three `PuzzleMoveResult` shapes from `rest-api.md`:
    /// wrong (`correct:false`), correct+complete (`solved:true`), or
    /// correct+continue (more plies to solve).
    private func handle(_ response: PuzzleMoveResult, baseFen: String, token: UUID) async {
        result = response
        errorMessage = nil

        if response.correct, response.complete {
            if let fen = response.fen { self.fen = fen }
            legalMoves = []
            myTurn = false
            phase = .solved
            playSound(.success)
            if response.rating != nil {
                await authStore.refreshAfterRatedResult()
            }
            return
        }

        if response.correct, let opponentMove = response.opponentMove, let nextFen = response.fen {
            playSound(.move)
            // Hold the player's move on the board a beat, then auto-play the
            // scripted reply and keep solving — matches the web's 360ms pacing.
            try? await Task.sleep(nanoseconds: 360_000_000)
            guard token == loadToken else { return }
            fen = nextFen
            lastMove = opponentMove
            legalMoves = response.legalMoves
            ply = response.ply ?? ply + 2
            myTurn = true
            phase = .solving
            return
        }

        // Wrong: reveal the solution's first move, played on the position
        // BEFORE this attempt (the server sends the whole line, not a
        // refutation of what was just tried).
        if let correct = response.solution.first {
            fen = ChessBoard(fen: baseFen).applying(correct).fen()
            lastMove = correct
        }
        legalMoves = []
        myTurn = false
        phase = .failed
        if response.rating != nil {
            await authStore.refreshAfterRatedResult()
        }
    }
}

#if DEBUG
extension PuzzleDriver {
    /// Preview/test-only: seeds a driver already mid-puzzle without any
    /// network round trip.
    static func preview(
        phase: Phase = .solving,
        fen: String = "r1bqk2r/ppp2ppp/2n2n2/2bpp3/2B1P3/3P1N2/PPP2PPP/RNBQK2R b kq - 2 6",
        orientation: PieceColor = .white,
        legalMoves: [String] = ["d5e4", "c5d4", "f6e4", "c6d4"],
        lastMove: String? = "c4d5",
        result: PuzzleMoveResult? = nil
    ) -> PuzzleDriver {
        let driver = PuzzleDriver(authStore: .preview())
        driver.puzzle = PuzzleNext(
            id: "preview-1",
            rating: 1642,
            startFen: fen,
            opponentMove: lastMove ?? "c4d5",
            fen: fen,
            color: orientation == .white ? "w" : "b",
            legalMoves: legalMoves,
            ply: 3,
            themes: ["fork"]
        )
        driver.phase = phase
        driver.fen = fen
        driver.orientation = orientation
        driver.legalMoves = legalMoves
        driver.lastMove = lastMove
        driver.myTurn = phase == .solving
        driver.result = result
        return driver
    }
}
#endif

import Foundation
import SwiftUI

/// Puzzles screen root. Three modes mirror the web's `Puzzles.tsx`:
/// `setup` (pick theme + time format, or jump into the daily puzzle),
/// `running` (solving puzzles under a locked theme/time), `over` (session
/// summary). This view owns session-wide state — the clock, the win/loss
/// history, the terminal auto-advance timer; the driver only ever knows
/// about the single puzzle in front of it.
struct PuzzlesView: View {
    private enum Mode {
        case setup
        case running
        case over
    }

    @Environment(AuthStore.self) private var authStore
    /// Named distinctly from the puzzle-flow `settings` below — this is the
    /// app-wide `SettingsStore` (sound/board/input prefs), injected at the
    /// app root.
    @Environment(SettingsStore.self) private var appSettings
    @State private var settings = PuzzleSettings()
    @State private var driver: PuzzleDriver?

    @State private var mode: Mode = .setup
    /// The theme/time format locked in for the CURRENT running session — a
    /// daily-puzzle session overrides these without touching the persisted
    /// `settings`, matching the web's "seeded sessions don't overwrite prefs".
    @State private var sessionTheme: PuzzleTheme = .all
    @State private var sessionTimeFormat: PuzzleTimeFormat = .blitz
    /// Non-`nil` while the running session was started from a raw theme tag
    /// (a Tutor drill deep link) rather than the curated `PuzzleTheme` picker
    /// — takes priority over `sessionTheme` for every reload in that session.
    /// See `PuzzleDriver.load(themeTag:)`.
    @State private var sessionThemeTag: String?
    /// A theme tag to jump straight into a running session with, consumed
    /// once on first appearance — the Tutor "Drill these" deep link
    /// (`TutorDrillCardView`'s puzzles body). Mirrors the web's
    /// `/puzzles?theme=<tag>` auto-start.
    private let deepLinkThemeTag: String?
    @State private var consumedDeepLink = false

    init(deepLinkThemeTag: String? = nil) {
        self.deepLinkThemeTag = deepLinkThemeTag
    }

    @State private var deadline: Date?
    @State private var remainingMs: Int = 0
    @State private var history: [PuzzleOutcome] = []
    @State private var advanceTask: Task<Void, Never>?
    /// Guards the low-time cue so it fires once per timed session, not once
    /// per clock tick while under the threshold.
    @State private var lowTimeSounded = false

    private static let lowTimeThresholdMs = 10_000

    var body: some View {
        NavigationStack {
            Group {
                switch mode {
                case .setup:
                    PuzzleSetupScreen(
                        settings: settings,
                        puzzleRating: authStore.user?.rating(for: .puzzle),
                        puzzleGames: authStore.user?.games(for: .puzzle),
                        isSignedIn: authStore.isAuthenticated,
                        onStart: { startSession(theme: settings.theme, timeFormat: settings.timeFormat) },
                        onDaily: startDailySession
                    )
                case .running:
                    if let driver {
                        PuzzleSessionScreen(
                            driver: driver,
                            theme: sessionTheme,
                            timeFormat: sessionTimeFormat,
                            remainingMs: remainingMs,
                            history: history,
                            onNext: advanceNow,
                            onStop: endSession
                        )
                    }
                case .over:
                    PuzzleSummaryScreen(
                        history: history,
                        theme: sessionTheme,
                        timeFormat: sessionTimeFormat,
                        isSignedIn: authStore.isAuthenticated,
                        onPlayAgain: { startSession(theme: sessionTheme, timeFormat: sessionTimeFormat) },
                        onChangeSettings: { mode = .setup }
                    )
                }
            }
            .background(Theme.Colors.background)
            .navigationTitle("Puzzles")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear {
            if driver == nil { driver = PuzzleDriver(authStore: authStore) }
            driver?.appSettings = appSettings
            if !consumedDeepLink, let tag = deepLinkThemeTag, !tag.isEmpty {
                consumedDeepLink = true
                startTaggedSession(themeTag: tag, timeFormat: settings.timeFormat)
            }
        }
        .onChange(of: driver?.phase) { _, newPhase in
            handlePhaseChange(newPhase)
        }
        .task(id: clockTaskID) {
            await runClock()
        }
    }

    /// Identifies one "clock epoch" — a fresh id whenever a timed session
    /// (re)starts, so `.task(id:)` cancels the previous countdown for free.
    private var clockTaskID: String {
        guard mode == .running, let deadline else { return "idle" }
        return String(deadline.timeIntervalSinceReferenceDate)
    }

    // MARK: - Session lifecycle

    private func startSession(theme: PuzzleTheme, timeFormat: PuzzleTimeFormat) {
        advanceTask?.cancel()
        history = []
        lowTimeSounded = false
        sessionTheme = theme
        sessionThemeTag = nil
        sessionTimeFormat = timeFormat
        if let seconds = timeFormat.seconds {
            deadline = Date().addingTimeInterval(TimeInterval(seconds))
            remainingMs = seconds * 1_000
        } else {
            deadline = nil
            remainingMs = 0
        }
        mode = .running
        driver?.load(theme: theme)
    }

    /// A raw theme tag from a Tutor drill deep link — see `deepLinkThemeTag`.
    /// Every reload for the rest of this session reuses the same tag (not
    /// the curated `sessionTheme`, which can't represent it).
    private func startTaggedSession(themeTag: String, timeFormat: PuzzleTimeFormat) {
        advanceTask?.cancel()
        history = []
        lowTimeSounded = false
        sessionTheme = .all
        sessionThemeTag = themeTag
        sessionTimeFormat = timeFormat
        if let seconds = timeFormat.seconds {
            deadline = Date().addingTimeInterval(TimeInterval(seconds))
            remainingMs = seconds * 1_000
        } else {
            deadline = nil
            remainingMs = 0
        }
        mode = .running
        driver?.load(themeTag: themeTag)
    }

    private func startDailySession() {
        advanceTask?.cancel()
        history = []
        lowTimeSounded = false
        sessionTheme = .all
        sessionThemeTag = nil
        sessionTimeFormat = .untimed
        deadline = nil
        remainingMs = 0
        mode = .running
        driver?.loadDaily()
    }

    private func endSession() {
        advanceTask?.cancel()
        deadline = nil
        mode = .over
    }

    /// Manual "Skip"/"Next puzzle" tap — always allowed, and never logged to
    /// `history` itself (only a real solve/miss inside `handlePhaseChange`
    /// appends), matching the web's "Skip = next without logging".
    private func advanceNow() {
        advanceTask?.cancel()
        reloadNext()
    }

    /// Routes to whichever theme selector is active for this session — see
    /// `sessionThemeTag`.
    private func reloadNext() {
        if let sessionThemeTag {
            driver?.load(themeTag: sessionThemeTag)
        } else {
            driver?.load(theme: sessionTheme)
        }
    }

    // MARK: - Phase reactions

    private func handlePhaseChange(_ phase: PuzzleDriver.Phase?) {
        guard mode == .running, let driver else { return }
        switch phase {
        case .solved:
            history.append(PuzzleOutcome(win: true, delta: driver.result?.rating?.delta))
            scheduleAdvance(afterMs: sessionTimeFormat.seconds == nil ? 2_000 : 650)
        case .failed:
            history.append(PuzzleOutcome(win: false, delta: driver.result?.rating?.delta))
            if sessionTimeFormat.seconds != nil {
                scheduleAdvance(afterMs: 1_300)
            }
        default:
            break
        }
    }

    private func scheduleAdvance(afterMs ms: Int) {
        advanceTask?.cancel()
        advanceTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
            guard !Task.isCancelled, mode == .running else { return }
            reloadNext()
        }
    }

    // MARK: - Session clock

    /// Ticks the countdown at 5Hz while a timed session is running, ending
    /// the session the instant it reaches zero — mirrors the web's
    /// `setInterval` countdown effect.
    private func runClock() async {
        guard mode == .running, let deadline, sessionTimeFormat.seconds != nil else { return }
        while !Task.isCancelled {
            let left = Int(deadline.timeIntervalSinceNow * 1_000)
            if left <= 0 {
                remainingMs = 0
                endSession()
                return
            }
            remainingMs = left
            if !lowTimeSounded, left <= Self.lowTimeThresholdMs {
                lowTimeSounded = true
                playLowTimeSound()
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    private func playLowTimeSound() {
        guard appSettings.lowTimeSound, appSettings.soundEnabled else { return }
        SoundEngine.shared.play(.lowTime, volume: appSettings.soundVolume)
    }
}

/// One puzzle's outcome within the current session, newest last. `delta` is
/// `nil` when the result carried no rating change (guest play, or the server
/// didn't return one).
struct PuzzleOutcome: Identifiable {
    let id = UUID()
    let win: Bool
    let delta: Int?
}

#Preview("Puzzles — setup") {
    PuzzlesView()
        .environment(AuthStore.preview())
        .environment(SettingsStore.preview())
}

#Preview("Puzzles — solving") {
    PuzzlesPreviewHost(phase: .solving)
}

#Preview("Puzzles — solved") {
    PuzzlesPreviewHost(
        phase: .solved,
        result: PuzzleMoveResult(correct: true, complete: true, solved: true, fen: nil,
                                  rating: PuzzleRating(value: 1650, delta: 8, games: 42))
    )
}

#Preview("Puzzles — failed") {
    PuzzlesPreviewHost(
        phase: .failed,
        result: PuzzleMoveResult(correct: false, complete: true, solution: ["e2e4", "e7e5"], fen: nil,
                                  rating: PuzzleRating(value: 1642, delta: -6, games: 43))
    )
}

/// Preview-only shell: renders the running screen directly with a seeded
/// driver, skipping the setup card and any network call.
private struct PuzzlesPreviewHost: View {
    let phase: PuzzleDriver.Phase
    var result: PuzzleMoveResult?

    var body: some View {
        NavigationStack {
            PuzzleSessionScreen(
                driver: .preview(phase: phase, result: result),
                theme: .fork,
                timeFormat: .blitz,
                remainingMs: 47_000,
                history: [
                    PuzzleOutcome(win: true, delta: 8),
                    PuzzleOutcome(win: false, delta: -5),
                    PuzzleOutcome(win: true, delta: 6),
                ],
                onNext: {},
                onStop: {}
            )
            .background(Theme.Colors.background)
            .navigationTitle("Puzzles")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

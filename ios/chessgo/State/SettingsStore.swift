import SwiftUI

/// Device-local preferences: board display, input, gameplay, sound, and
/// appearance. No server sync (matches the web — "Settings persisted local").
/// Every property persists to `UserDefaults` on set and applies instantly —
/// there is no Save button anywhere in the settings UI.
///
/// Persistence mirrors the additive-default philosophy of `Core/Resilient.swift`
/// without depending on it: a single JSON blob is decoded field-by-field, so a
/// malformed value or a key from a future app version never throws and never
/// takes the rest of the prefs down with it — it just falls back to that one
/// field's default.
@Observable
@MainActor
final class SettingsStore {

    // MARK: - Enums

    enum AnimationSpeed: String, Codable, CaseIterable, Identifiable {
        case none, fast, normal, slow

        var id: String { rawValue }

        var label: String {
            switch self {
            case .none: "Off"
            case .fast: "Fast"
            case .normal: "Normal"
            case .slow: "Slow"
            }
        }

        /// Seconds for a move-slide animation; `nil` means "don't animate."
        var duration: Double? {
            switch self {
            case .none: nil
            case .fast: 0.12
            case .normal: 0.22
            case .slow: 0.4
            }
        }
    }

    /// Which gestures the board accepts. Maps onto `BoardInputMethod`
    /// (`Views/Board/BoardControl.swift`) — see `boardInputMethod`.
    enum MoveInputMethod: String, Codable, CaseIterable, Identifiable {
        case both, click, drag

        var id: String { rawValue }

        var label: String {
            switch self {
            case .both: "Tap or drag"
            case .click: "Tap only"
            case .drag: "Drag only"
            }
        }

        var boardInputMethod: BoardInputMethod {
            switch self {
            case .both: .both
            case .click: .clickOnly
            case .drag: .dragOnly
            }
        }
    }

    enum AppColorScheme: String, Codable, CaseIterable, Identifiable {
        case system, light, dark

        var id: String { rawValue }

        var label: String {
            switch self {
            case .system: "System"
            case .light: "Light"
            case .dark: "Dark"
            }
        }
    }

    // MARK: - Board display

    var showCoordinates: Bool { didSet { onChange() } }
    var highlightLastMove: Bool { didSet { onChange() } }
    var showLegalMoves: Bool { didSet { onChange() } }

    /// Board square brightness, 0.7–1.0. Clamped on every set.
    var boardBrightness: Double {
        didSet {
            guard !isRestoring else { return }
            let clamped = boardBrightness.clamped(to: Self.brightnessRange)
            if clamped != boardBrightness {
                boardBrightness = clamped
                return // the reentrant didSet above persists the clamped value
            }
            persist()
        }
    }

    var animationSpeed: AnimationSpeed { didSet { onChange() } }

    // MARK: - Input

    var autoQueen: Bool { didSet { onChange() } }
    var moveMethod: MoveInputMethod { didSet { onChange() } }
    var premoves: Bool { didSet { onChange() } }

    // MARK: - Gameplay

    var confirmResign: Bool { didSet { onChange() } }
    var autoFlip: Bool { didSet { onChange() } }
    var zenMode: Bool { didSet { onChange() } }
    var showEvalBar: Bool { didSet { onChange() } }
    var showMoveList: Bool { didSet { onChange() } }

    // MARK: - Sound

    var soundEnabled: Bool { didSet { onChange() } }

    /// 0–1. Clamped on every set.
    var soundVolume: Double {
        didSet {
            guard !isRestoring else { return }
            let clamped = soundVolume.clamped(to: Self.volumeRange)
            if clamped != soundVolume {
                soundVolume = clamped
                return
            }
            persist()
        }
    }

    var lowTimeSound: Bool { didSet { onChange() } }

    // MARK: - Appearance

    var colorScheme: AppColorScheme { didSet { onChange() } }

    /// What the app root passes to `.preferredColorScheme(_:)`. `nil` means
    /// "follow the system," matching SwiftUI's own convention.
    var preferredColorScheme: ColorScheme? {
        switch colorScheme {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    // MARK: - Persistence

    nonisolated private static let brightnessRange: ClosedRange<Double> = 0.7...1.0
    nonisolated private static let volumeRange: ClosedRange<Double> = 0.0...1.0
    private static let defaultsKey = "chessgo.settings.v1"

    private let defaults: UserDefaults

    /// True only while the initializer is populating properties from a
    /// decoded snapshot — suppresses the clamp/persist side effects `didSet`
    /// would otherwise run once per field on every launch.
    private var isRestoring = true

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let snapshot = Self.loadSnapshot(from: defaults)

        showCoordinates = snapshot.showCoordinates
        highlightLastMove = snapshot.highlightLastMove
        showLegalMoves = snapshot.showLegalMoves
        boardBrightness = snapshot.boardBrightness
        animationSpeed = snapshot.animationSpeed

        autoQueen = snapshot.autoQueen
        moveMethod = snapshot.moveMethod
        premoves = snapshot.premoves

        confirmResign = snapshot.confirmResign
        autoFlip = snapshot.autoFlip
        zenMode = snapshot.zenMode
        showEvalBar = snapshot.showEvalBar
        showMoveList = snapshot.showMoveList

        soundEnabled = snapshot.soundEnabled
        soundVolume = snapshot.soundVolume
        lowTimeSound = snapshot.lowTimeSound

        colorScheme = snapshot.colorScheme

        isRestoring = false
    }

    private func onChange() {
        guard !isRestoring else { return }
        persist()
    }

    private var currentSnapshot: Snapshot {
        Snapshot(
            showCoordinates: showCoordinates,
            highlightLastMove: highlightLastMove,
            showLegalMoves: showLegalMoves,
            boardBrightness: boardBrightness,
            animationSpeed: animationSpeed,
            autoQueen: autoQueen,
            moveMethod: moveMethod,
            premoves: premoves,
            confirmResign: confirmResign,
            autoFlip: autoFlip,
            zenMode: zenMode,
            showEvalBar: showEvalBar,
            showMoveList: showMoveList,
            soundEnabled: soundEnabled,
            soundVolume: soundVolume,
            lowTimeSound: lowTimeSound,
            colorScheme: colorScheme
        )
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(currentSnapshot) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }

    private static func loadSnapshot(from defaults: UserDefaults) -> Snapshot {
        guard let data = defaults.data(forKey: defaultsKey),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data)
        else { return .defaults }
        return snapshot
    }

    /// The on-disk shape. Encoding is synthesized (every field is plain
    /// `Codable`); decoding is hand-written so a missing key, a `null`, or an
    /// unrecognized enum raw value from an older/newer build falls back to
    /// that single field's default instead of failing the whole blob.
    private struct Snapshot: Codable {
        var showCoordinates: Bool
        var highlightLastMove: Bool
        var showLegalMoves: Bool
        var boardBrightness: Double
        var animationSpeed: AnimationSpeed
        var autoQueen: Bool
        var moveMethod: MoveInputMethod
        var premoves: Bool
        var confirmResign: Bool
        var autoFlip: Bool
        var zenMode: Bool
        var showEvalBar: Bool
        var showMoveList: Bool
        var soundEnabled: Bool
        var soundVolume: Double
        var lowTimeSound: Bool
        var colorScheme: AppColorScheme

        static let defaults = Snapshot(
            showCoordinates: true,
            highlightLastMove: true,
            showLegalMoves: true,
            boardBrightness: 1.0,
            animationSpeed: .normal,
            autoQueen: false,
            moveMethod: .both,
            premoves: true,
            confirmResign: true,
            autoFlip: false,
            zenMode: false,
            showEvalBar: true,
            showMoveList: true,
            soundEnabled: true,
            soundVolume: 0.5,
            lowTimeSound: true,
            colorScheme: .system
        )

        init(
            showCoordinates: Bool,
            highlightLastMove: Bool,
            showLegalMoves: Bool,
            boardBrightness: Double,
            animationSpeed: AnimationSpeed,
            autoQueen: Bool,
            moveMethod: MoveInputMethod,
            premoves: Bool,
            confirmResign: Bool,
            autoFlip: Bool,
            zenMode: Bool,
            showEvalBar: Bool,
            showMoveList: Bool,
            soundEnabled: Bool,
            soundVolume: Double,
            lowTimeSound: Bool,
            colorScheme: AppColorScheme
        ) {
            self.showCoordinates = showCoordinates
            self.highlightLastMove = highlightLastMove
            self.showLegalMoves = showLegalMoves
            self.boardBrightness = boardBrightness
            self.animationSpeed = animationSpeed
            self.autoQueen = autoQueen
            self.moveMethod = moveMethod
            self.premoves = premoves
            self.confirmResign = confirmResign
            self.autoFlip = autoFlip
            self.zenMode = zenMode
            self.showEvalBar = showEvalBar
            self.showMoveList = showMoveList
            self.soundEnabled = soundEnabled
            self.soundVolume = soundVolume
            self.lowTimeSound = lowTimeSound
            self.colorScheme = colorScheme
        }

        private enum CodingKeys: String, CodingKey {
            case showCoordinates, highlightLastMove, showLegalMoves, boardBrightness, animationSpeed
            case autoQueen, moveMethod, premoves
            case confirmResign, autoFlip, zenMode, showEvalBar, showMoveList
            case soundEnabled, soundVolume, lowTimeSound
            case colorScheme
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let fallback = Snapshot.defaults

            showCoordinates = Self.field(container, .showCoordinates, fallback.showCoordinates)
            highlightLastMove = Self.field(container, .highlightLastMove, fallback.highlightLastMove)
            showLegalMoves = Self.field(container, .showLegalMoves, fallback.showLegalMoves)
            boardBrightness = Self.field(container, .boardBrightness, fallback.boardBrightness)
                .clamped(to: SettingsStore.brightnessRange)
            animationSpeed = Self.enumField(container, .animationSpeed, fallback.animationSpeed)

            autoQueen = Self.field(container, .autoQueen, fallback.autoQueen)
            moveMethod = Self.enumField(container, .moveMethod, fallback.moveMethod)
            premoves = Self.field(container, .premoves, fallback.premoves)

            confirmResign = Self.field(container, .confirmResign, fallback.confirmResign)
            autoFlip = Self.field(container, .autoFlip, fallback.autoFlip)
            zenMode = Self.field(container, .zenMode, fallback.zenMode)
            showEvalBar = Self.field(container, .showEvalBar, fallback.showEvalBar)
            showMoveList = Self.field(container, .showMoveList, fallback.showMoveList)

            soundEnabled = Self.field(container, .soundEnabled, fallback.soundEnabled)
            soundVolume = Self.field(container, .soundVolume, fallback.soundVolume)
                .clamped(to: SettingsStore.volumeRange)
            lowTimeSound = Self.field(container, .lowTimeSound, fallback.lowTimeSound)

            colorScheme = Self.enumField(container, .colorScheme, fallback.colorScheme)
        }

        /// Missing key, `null`, or a type mismatch → `fallback`. Never throws.
        private static func field<T: Decodable>(
            _ container: KeyedDecodingContainer<CodingKeys>,
            _ key: CodingKeys,
            _ fallback: T
        ) -> T {
            ((try? container.decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
        }

        /// Same, but for a `String`-backed enum — an unrecognized raw value
        /// (e.g. a case a future app version added) also falls back.
        private static func enumField<T: RawRepresentable & Decodable>(
            _ container: KeyedDecodingContainer<CodingKeys>,
            _ key: CodingKeys,
            _ fallback: T
        ) -> T where T.RawValue == String {
            guard let raw = ((try? container.decodeIfPresent(String.self, forKey: key)) ?? nil) else {
                return fallback
            }
            return T(rawValue: raw) ?? fallback
        }
    }
}

private extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}

#if DEBUG
extension SettingsStore {
    /// Preview/test-only: a store backed by an isolated, throwaway
    /// `UserDefaults` suite so previews never read or write the real one.
    static func preview() -> SettingsStore {
        let suiteName = "chessgo.settings.preview.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        return SettingsStore(defaults: defaults)
    }
}
#endif

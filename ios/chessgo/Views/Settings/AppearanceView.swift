import SwiftUI

/// Appearance: the board theme + piece set pickers (the same sixteen themes and
/// seven sets the web settings modal offers), plus color scheme, brightness,
/// animation speed and the board-overlay toggles. Every control applies
/// instantly — no Save button, matching `SettingsStore`'s instant-apply
/// contract. Selecting a theme repaints the board behind this screen too.
struct AppearanceView: View {
    @Environment(SettingsStore.self) private var settings

    /// A pieces-rich middlegame, purely to show the active theme + set. Same
    /// position the web picker previews, with c1g5 as the last move so the
    /// highlight color shows.
    private static let previewFEN =
        "r2q1rk1/ppp2ppp/2np1n2/2b1p1B1/2B1P1b1/2NP1N2/PPP2PPP/R2Q1RK1 w - - 0 1"

    var body: some View {
        @Bindable var settings = settings

        Form {
            Section {
                ThemePreviewBoard(
                    fen: Self.previewFEN,
                    palette: settings.boardPalette,
                    pieceSet: settings.pieceSet,
                    lastMove: ["c1", "g5"]
                )
                .padding(.vertical, Theme.Spacing.sm)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }

            Section("Board — \(settings.boardTheme.label)") {
                boardGrid
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            Section("Pieces — \(settings.pieceSet.label)") {
                pieceGrid
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            Section("Color scheme") {
                Picker("Appearance", selection: $settings.colorScheme) {
                    ForEach(SettingsStore.AppColorScheme.allCases) { scheme in
                        Text(scheme.label).tag(scheme)
                    }
                }
                .pickerStyle(.segmented)
            }

            Section("Display") {
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text("Brightness")
                        .font(Theme.body(15))
                        .foregroundStyle(Theme.Colors.primaryText)
                    Slider(value: $settings.boardBrightness, in: 0.7...1.0, step: 0.01)
                }
                .padding(.vertical, Theme.Spacing.xs)

                Picker("Move animation", selection: $settings.animationSpeed) {
                    ForEach(SettingsStore.AnimationSpeed.allCases) { speed in
                        Text(speed.label).tag(speed)
                    }
                }

                Toggle("Show coordinates", isOn: $settings.showCoordinates)
                Toggle("Highlight last move", isOn: $settings.highlightLastMove)
                Toggle("Show legal moves", isOn: $settings.showLegalMoves)
            }
        }
        .navigationTitle("Appearance")
        .scrollContentBackground(.hidden)
        .background(Theme.Colors.background)
    }

    // MARK: - Board themes

    /// Every theme as a 2×2 block of one continuous board, four per row — the
    /// web picker's layout. The checker pattern is fixed so blocks line up into
    /// a single board no matter each block's palette.
    private var boardGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(spacing: 0), count: 4), spacing: 0) {
            ForEach(BoardThemeID.allCases) { theme in
                BoardThemeTile(theme: theme, selected: settings.boardTheme == theme) {
                    settings.boardTheme = theme
                }
            }
        }
        .padding(.vertical, Theme.Spacing.sm)
    }

    // MARK: - Piece sets

    private var pieceGrid: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(spacing: Theme.Spacing.sm), count: 2),
            spacing: Theme.Spacing.sm
        ) {
            ForEach(PieceSetID.allCases) { set in
                PieceSetCard(
                    set: set,
                    palette: settings.boardPalette,
                    selected: settings.pieceSet == set
                ) {
                    settings.pieceSet = set
                }
            }
        }
        .padding(.vertical, Theme.Spacing.sm)
    }
}

// MARK: - Preview board

/// A non-interactive 8×8 board rendering a FEN in a given palette + piece set.
/// Deliberately independent of `BoardView` — no control, no gestures, no
/// legality — so the settings screen can preview a theme without a driver.
private struct ThemePreviewBoard: View {
    let fen: String
    let palette: BoardPalette
    let pieceSet: PieceSetID
    /// From/to squares to tint, in algebraic form.
    var lastMove: [String] = []

    var body: some View {
        let board = ChessBoard(fen: fen)
        let highlighted = Set(lastMove.compactMap { Square(algebraic: $0) })

        VStack(spacing: 0) {
            ForEach(0..<8, id: \.self) { row in
                HStack(spacing: 0) {
                    ForEach(0..<8, id: \.self) { col in
                        let square = Square(file: col, rank: 7 - row)!
                        let isLight = (square.file + square.rank) % 2 == 1
                        ZStack {
                            BoardSquareFace(face: palette.face(light: isLight))
                            if let border = palette.border {
                                Rectangle().strokeBorder(border, lineWidth: 0.5)
                            }
                            if highlighted.contains(square) { palette.lastMove }
                            if let piece = board.piece(at: square) {
                                PieceView(piece: piece, set: pieceSet)
                                    .padding(1)
                            }
                        }
                        .aspectRatio(1, contentMode: .fit)
                    }
                }
            }
        }
        .overlay(Rectangle().strokeBorder(palette.frame, lineWidth: 1))
        .frame(maxWidth: 280)
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Theme tile

private struct BoardThemeTile: View {
    let theme: BoardThemeID
    let selected: Bool
    let onSelect: () -> Void

    /// Fixed checker pattern — dark, light / light, dark — so tiles laid at even
    /// offsets read as one continuous board across the whole grid.
    private static let pattern = [false, true, true, false]

    var body: some View {
        let palette = theme.palette
        Button(action: onSelect) {
            VStack(spacing: 0) {
                ForEach(0..<2, id: \.self) { row in
                    HStack(spacing: 0) {
                        ForEach(0..<2, id: \.self) { col in
                            BoardSquareFace(face: palette.face(light: Self.pattern[row * 2 + col]))
                                .overlay {
                                    if let border = palette.border {
                                        Rectangle().strokeBorder(border, lineWidth: 0.5)
                                    }
                                }
                        }
                    }
                }
            }
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if selected {
                    Rectangle().strokeBorder(Theme.Colors.accent, lineWidth: 3)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(theme.label)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - Piece set card

private struct PieceSetCard: View {
    let set: PieceSetID
    let palette: BoardPalette
    let selected: Bool
    let onSelect: () -> Void

    /// Four pieces on alternating squares — the web picker's sample.
    private static let sample: [Piece] = [
        Piece(color: .white, kind: .knight),
        Piece(color: .black, kind: .queen),
        Piece(color: .black, kind: .king),
        Piece(color: .white, kind: .pawn),
    ]

    var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                HStack(spacing: 0) {
                    ForEach(Array(Self.sample.enumerated()), id: \.offset) { index, piece in
                        ZStack {
                            BoardSquareFace(face: palette.face(light: index.isMultiple(of: 2)))
                            PieceView(piece: piece, set: set).padding(1)
                        }
                        .aspectRatio(1, contentMode: .fit)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))

                Text(set.label)
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(set.credit)
                    .font(Theme.caption(10))
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(2)
            }
            .padding(Theme.Spacing.xs)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .strokeBorder(
                        selected ? Theme.Colors.accent : Theme.Colors.secondaryText.opacity(0.25),
                        lineWidth: selected ? 2 : 1
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(set.label)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

#Preview("Appearance") {
    NavigationStack {
        AppearanceView()
    }
    .environment(SettingsStore.preview())
}

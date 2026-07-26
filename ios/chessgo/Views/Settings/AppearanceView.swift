import SwiftUI

/// Appearance + board display settings: color scheme, board brightness,
/// animation speed, and the three board-overlay toggles. Every control
/// applies instantly — no Save button, matches `SettingsStore`'s
/// instant-apply contract.
struct AppearanceView: View {
    @Environment(SettingsStore.self) private var settings

    var body: some View {
        @Bindable var settings = settings

        Form {
            Section("Color scheme") {
                Picker("Appearance", selection: $settings.colorScheme) {
                    ForEach(SettingsStore.AppColorScheme.allCases) { scheme in
                        Text(scheme.label).tag(scheme)
                    }
                }
                .pickerStyle(.segmented)
            }

            Section {
                boardPreview
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }

            Section("Board") {
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

    /// A small non-interactive board swatch so brightness/coordinate changes
    /// have something to preview against without pulling in the real board.
    private var boardPreview: some View {
        let files = ["a", "b", "c", "d"]
        let ranks = ["4", "3", "2", "1"]

        return VStack(spacing: 0) {
            ForEach(Array(ranks.enumerated()), id: \.offset) { rankIndex, rank in
                HStack(spacing: 0) {
                    ForEach(Array(files.enumerated()), id: \.offset) { fileIndex, file in
                        let isLight = (rankIndex + fileIndex).isMultiple(of: 2)
                        let isLastMove = rankIndex == 1 && fileIndex == 2

                        ZStack(alignment: .bottomTrailing) {
                            (isLight ? Theme.Colors.boardLight : Theme.Colors.boardDark)
                                .opacity(settings.boardBrightness)

                            if isLastMove && settings.highlightLastMove {
                                Theme.Colors.lastMove
                            }

                            if settings.showCoordinates && rankIndex == ranks.count - 1 {
                                Text(file)
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundStyle(isLight ? Theme.Colors.boardDark : Theme.Colors.boardLight)
                                    .padding(2)
                            }
                        }
                        .aspectRatio(1, contentMode: .fit)
                    }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
        .frame(maxWidth: 160)
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Spacing.sm)
    }
}

#Preview("Appearance") {
    NavigationStack {
        AppearanceView()
    }
    .environment(SettingsStore.preview())
}

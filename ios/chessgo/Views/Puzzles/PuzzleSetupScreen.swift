import SwiftUI

/// The `setup` mode card: pick a theme + time format, then start a session,
/// or jump straight into today's daily puzzle (untimed, unfiltered).
struct PuzzleSetupScreen: View {
    @Bindable var settings: PuzzleSettings
    let puzzleRating: Int?
    let puzzleGames: Int?
    let isSignedIn: Bool
    let onStart: () -> Void
    let onDaily: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                header

                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    sectionLabel("Theme")
                    ThemePicker(theme: $settings.theme)
                }

                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    sectionLabel("Time")
                    TimeFormatGrid(timeFormat: $settings.timeFormat)
                }

                VStack(spacing: Theme.Spacing.sm) {
                    Button("Start session", action: onStart)
                        .prominentGlassButton()

                    Button {
                        onDaily()
                    } label: {
                        Label("Today's puzzle", systemImage: "calendar")
                    }
                    .glassButton()
                }

                ratingFooter
            }
            .padding(Theme.Spacing.lg)
        }
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(Theme.Colors.accent.opacity(0.14))
                Image(systemName: "target")
                    .foregroundStyle(Theme.Colors.accent)
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text("Puzzles")
                    .font(Theme.title(24))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text("Solve as many as you can before the clock runs out.")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    private var ratingFooter: some View {
        Group {
            if isSignedIn, let puzzleRating {
                Text("Puzzle rating \(puzzleRating) \u{00B7} \(puzzleGames ?? 0) solved")
            } else {
                Text("Sign in to track your puzzle rating.")
            }
        }
        .font(Theme.caption())
        .foregroundStyle(Theme.Colors.secondaryText)
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(Theme.caption(11))
            .foregroundStyle(Theme.Colors.secondaryText)
            .tracking(1.2)
    }
}

/// Compact menu picker for the 13 puzzle themes.
private struct ThemePicker: View {
    @Binding var theme: PuzzleTheme

    var body: some View {
        Menu {
            ForEach(PuzzleTheme.allCases) { option in
                Button {
                    theme = option
                } label: {
                    if option == theme {
                        Label(option.label, systemImage: "checkmark")
                    } else {
                        Text(option.label)
                    }
                }
            }
        } label: {
            HStack {
                Text(theme.label)
                    .font(Theme.body(16))
                    .foregroundStyle(Theme.Colors.primaryText)
                Spacer()
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            .padding(.vertical, 14)
            .padding(.horizontal, Theme.Spacing.md)
            .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .stroke(Theme.Colors.primaryText.opacity(0.08), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

/// 2x2 grid of time-format picks (Sprint/Blitz/Marathon/Untimed).
private struct TimeFormatGrid: View {
    @Binding var timeFormat: PuzzleTimeFormat

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        LazyVGrid(columns: columns, spacing: Theme.Spacing.sm) {
            ForEach(PuzzleTimeFormat.allCases) { option in
                let active = option == timeFormat
                Button {
                    timeFormat = option
                } label: {
                    VStack(spacing: 2) {
                        Text(option.display)
                            .font(Theme.headline(20).monospacedDigit())
                        Text(option.tag)
                            .font(Theme.caption())
                    }
                    .foregroundStyle(active ? Theme.Colors.accent : Theme.Colors.primaryText)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Spacing.sm + 4)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .fill(active ? Theme.Colors.accent.opacity(0.14) : Theme.Colors.surface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .stroke(
                                active ? Theme.Colors.accent.opacity(0.5) : Theme.Colors.primaryText.opacity(0.08),
                                lineWidth: 1
                            )
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }
}

#Preview("Setup — signed in") {
    NavigationStack {
        PuzzleSetupScreen(
            settings: PuzzleSettings(),
            puzzleRating: 1642,
            puzzleGames: 118,
            isSignedIn: true,
            onStart: {},
            onDaily: {}
        )
        .background(Theme.Colors.background)
    }
}

#Preview("Setup — guest") {
    NavigationStack {
        PuzzleSetupScreen(
            settings: PuzzleSettings(),
            puzzleRating: nil,
            puzzleGames: nil,
            isSignedIn: false,
            onStart: {},
            onDaily: {}
        )
        .background(Theme.Colors.background)
    }
}

import SwiftUI

/// Bot game setup: variant, strength, color, then Play — mirrors the web's
/// `/bot` setup screen (frontend-features.md "Bot games"). Owns its own
/// `NavigationStack` so it can be dropped straight into the Play tab in
/// place of `RootTabView`'s placeholder, the same way that tab's
/// `PlaceholderScreen` already wraps its own stack.
struct BotSetupView: View {
    @State private var settings: BotSettings = BotSettingsStore.load()
    @State private var activeDriver: BotGameDriver?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    header
                    section(title: "Variant") {
                        VariantPicker(selection: $settings.variant)
                    }
                    section(title: "Strength") {
                        strengthControl
                    }
                    section(title: "Play as") {
                        colorControl
                    }
                    playButton
                }
                .padding(Theme.Spacing.lg)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Play the computer")
            .navigationBarTitleDisplayMode(.large)
            .onChange(of: settings) { _, newValue in
                BotSettingsStore.save(newValue)
            }
            .navigationDestination(item: $activeDriver) { driver in
                BotGameView(driver: driver)
            }
        }
    }

    private var header: some View {
        Text("Choose a variant, a strength, and a side. Untimed — take your time.")
            .font(Theme.body(15))
            .foregroundStyle(Theme.Colors.secondaryText)
    }

    @ViewBuilder
    private func section(title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title)
                .font(Theme.headline(16))
                .foregroundStyle(Theme.Colors.primaryText)
            content()
        }
    }

    // MARK: - Strength

    private var strengthControl: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Toggle("Unlosable", isOn: unlosableBinding)
                .tint(Theme.Colors.accent)

            if settings.forcesMaxStrength {
                Text("This bot decays in strength as the game goes on — it starts at 3500.")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)
            } else if !settings.isUnlosable {
                HStack {
                    Text("Rating")
                        .font(Theme.body(15))
                        .foregroundStyle(Theme.Colors.primaryText)
                    Spacer()
                    Text("\(settings.rating)")
                        .font(Theme.body(15).monospacedDigit())
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Slider(
                    value: ratingBinding,
                    in: Double(BotSettings.ratingRange.lowerBound)...Double(BotSettings.ratingRange.upperBound),
                    step: Double(BotSettings.ratingStep)
                )
                .tint(Theme.Colors.accent)
            } else {
                Text("The bot plays its worst — you shouldn't be able to lose.")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .padding(Theme.Spacing.md)
        .glassCard()
    }

    private var unlosableBinding: Binding<Bool> {
        Binding(
            get: { settings.isUnlosable },
            set: { isOn in settings.rating = isOn ? BotSettings.unlosable : 1500 }
        )
    }

    private var ratingBinding: Binding<Double> {
        Binding(
            get: { Double(settings.rating) },
            set: { settings.rating = Int($0) }
        )
    }

    // MARK: - Color

    private var colorControl: some View {
        Picker("Play as", selection: $settings.humanColor) {
            Text("White").tag("w")
            Text("Black").tag("b")
            Text("Random").tag("random")
        }
        .pickerStyle(.segmented)
    }

    // MARK: - Play

    private var playButton: some View {
        Button {
            let driver = BotGameDriver(settings: settings)
            activeDriver = driver
            // Secret Queen doesn't start here — the player has to designate a
            // pawn first, and does it by tapping the real board, so
            // `BotGameView` shows that step itself (`driver.game == nil` +
            // `variant == .secretqueen`) and calls `start(secretSquare:)` once
            // confirmed. Every other variant starts immediately, same as before.
            if settings.variant != .secretqueen {
                Task { await driver.start() }
            }
        } label: {
            Text("Play")
                .frame(maxWidth: .infinity)
        }
        .prominentGlassButton()
        .padding(.top, Theme.Spacing.sm)
    }
}

#Preview("BotSetupView") {
    BotSetupView()
}

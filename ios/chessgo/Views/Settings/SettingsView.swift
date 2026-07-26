import SwiftUI

/// Settings tab root. Sectioned form — Appearance, Board & Input, Gameplay,
/// Sound, Account. Every control reads/writes `SettingsStore` directly and
/// applies live; there is no Save button anywhere in this screen.
struct SettingsView: View {
    @Environment(SettingsStore.self) private var settings
    @Environment(AuthStore.self) private var authStore

    var body: some View {
        @Bindable var settings = settings

        NavigationStack {
            Form {
                Section("Appearance") {
                    NavigationLink {
                        AppearanceView()
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Board & display")
                                Text(settings.colorScheme.label)
                                    .font(Theme.caption())
                                    .foregroundStyle(Theme.Colors.secondaryText)
                            }
                        } icon: {
                            Image(systemName: "paintbrush.fill")
                        }
                    }
                }

                Section("Board & input") {
                    Picker("Move input", selection: $settings.moveMethod) {
                        ForEach(SettingsStore.MoveInputMethod.allCases) { method in
                            Text(method.label).tag(method)
                        }
                    }
                    Toggle("Auto-queen promotions", isOn: $settings.autoQueen)
                    Toggle("Allow premoves", isOn: $settings.premoves)
                }

                Section("Gameplay") {
                    Toggle("Confirm before resigning", isOn: $settings.confirmResign)
                    Toggle("Flip board each game", isOn: $settings.autoFlip)
                    Toggle("Zen mode", isOn: $settings.zenMode)
                    Toggle("Show eval bar", isOn: $settings.showEvalBar)
                    Toggle("Show move list", isOn: $settings.showMoveList)
                }

                Section("Sound") {
                    Toggle("Sound", isOn: $settings.soundEnabled)
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Text("Volume")
                            .font(Theme.body(15))
                            .foregroundStyle(settings.soundEnabled ? Theme.Colors.primaryText : Theme.Colors.secondaryText)
                        Slider(value: $settings.soundVolume, in: 0...1, step: 0.05)
                            .disabled(!settings.soundEnabled)
                    }
                    .padding(.vertical, Theme.Spacing.xs)
                    Toggle("Low-time warning", isOn: $settings.lowTimeSound)
                        .disabled(!settings.soundEnabled)
                }

                Section("Account") {
                    NavigationLink {
                        AccountView()
                    } label: {
                        Label {
                            if let user = authStore.user {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(user.name)
                                    Text("Signed in")
                                        .font(Theme.caption())
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                }
                            } else {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Sign in")
                                    Text("Playing as guest")
                                        .font(Theme.caption())
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                }
                            }
                        } icon: {
                            Image(systemName: "person.crop.circle")
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.Colors.background)
            .navigationTitle("Settings")
        }
    }
}

#Preview("Settings — signed in") {
    SettingsView()
        .environment(SettingsStore.preview())
        .environment(AuthStore.preview(user: .previewStub))
}

#Preview("Settings — guest") {
    SettingsView()
        .environment(SettingsStore.preview())
        .environment(AuthStore.preview())
}

private extension User {
    /// Decoded (not memberwise-initialized, see the `@Default` gotcha in
    /// `docs/SPEC.md`) so every `@Default*`-wrapped field falls back to its
    /// normal default — only the fields this preview needs are given values.
    static let previewStub: User = {
        let json = Data("""
        {"id":"preview","name":"Ada Lovelace","email":"ada@example.com"}
        """.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(User.self, from: json)
    }()
}

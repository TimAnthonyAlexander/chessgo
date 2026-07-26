//
//  SoundTestView.swift
//  chessgo
//
//  DEBUG-only manual verifier for `SoundEngine`. Not wired into any
//  navigation flow — a button here just calls `SoundEngine.shared.play(_:)`
//  so every generated tone can be listened to on a real device/simulator
//  during development.
//

#if DEBUG
import SwiftUI

private struct SoundTestView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text("Sound engine")
                    .font(Theme.title())
                    .foregroundStyle(Theme.Colors.primaryText)

                Text("Each button plays one synthesized event through SoundEngine. \".check\" is expected to be silent.")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)

                VStack(spacing: Theme.Spacing.sm) {
                    ForEach(SoundEngine.SoundEvent.allCases, id: \.self) { event in
                        Button {
                            SoundEngine.shared.play(event)
                        } label: {
                            HStack {
                                Text(label(for: event))
                                Spacer()
                                Image(systemName: "speaker.wave.2.fill")
                            }
                            .padding(Theme.Spacing.sm)
                            .background(Theme.Colors.surface)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                        }
                        .foregroundStyle(Theme.Colors.primaryText)
                    }
                }

                Divider().padding(.vertical, Theme.Spacing.sm)

                Text("playForSan precedence")
                    .font(Theme.title())
                    .foregroundStyle(Theme.Colors.primaryText)

                VStack(spacing: Theme.Spacing.sm) {
                    sanButton("e4", isGameOver: false)
                    sanButton("Nxe5", isGameOver: false)
                    sanButton("O-O", isGameOver: false)
                    sanButton("O-O-O", isGameOver: false)
                    sanButton("e8=Q", isGameOver: false)
                    sanButton("exd8=Q+", isGameOver: false)
                    sanButton("Qxf7#", isGameOver: true)
                }
            }
            .padding(Theme.Spacing.md)
        }
        .background(Theme.Colors.background)
    }

    private func sanButton(_ san: String, isGameOver: Bool) -> some View {
        Button {
            SoundEngine.shared.playForSan(san, isGameOver: isGameOver)
        } label: {
            HStack {
                Text(san + (isGameOver ? " (game over)" : ""))
                Spacer()
                Image(systemName: "speaker.wave.2.fill")
            }
            .padding(Theme.Spacing.sm)
            .background(Theme.Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .foregroundStyle(Theme.Colors.primaryText)
    }

    private func label(for event: SoundEngine.SoundEvent) -> String {
        switch event {
        case .move: return "move"
        case .capture: return "capture"
        case .castle: return "castle (= move)"
        case .promote: return "promote (= move)"
        case .check: return "check (silent)"
        case .lowTime: return "lowTime"
        case .success: return "success"
        case .end: return "end"
        }
    }
}

#Preview("Sound engine — manual verification") {
    SoundTestView()
}
#endif

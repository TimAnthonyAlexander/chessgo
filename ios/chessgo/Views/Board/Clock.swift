import Foundation
import SwiftUI

/// Self-ticking clock chip. It does NOT own the source of truth — the driver
/// (SocketStore/BotGameStore) passes the latest `remainingMs` plus the
/// timestamp it was read at (`capturedAt`), and this view interpolates
/// locally at ~10Hz via `TimelineView`. That keeps a running clock smooth
/// without the parent re-rendering every tick (frontend-features.md: "Clock
/// self-ticks 200ms INSIDE the leaf so parent doesn't re-render").
struct Clock: View {
    let remainingMs: Int
    let running: Bool
    let capturedAt: Date

    init(remainingMs: Int, running: Bool, capturedAt: Date = .now) {
        self.remainingMs = remainingMs
        self.running = running
        self.capturedAt = capturedAt
    }

    private enum Urgency {
        case normal, amber, red

        var color: Color {
            switch self {
            case .normal: return Theme.Colors.primaryText
            case .amber: return Theme.Colors.warning
            case .red: return Theme.Colors.negative
            }
        }
    }

    var body: some View {
        TimelineView(.periodic(from: capturedAt, by: 0.1)) { timeline in
            let elapsedMs = running ? max(0, timeline.date.timeIntervalSince(capturedAt) * 1000) : 0
            let displayMs = max(0, remainingMs - Int(elapsedMs))
            let urgency = Self.urgency(for: displayMs)

            Text(Self.format(displayMs))
                .font(Theme.headline(18).monospacedDigit())
                .foregroundStyle(urgency.color)
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, Theme.Spacing.xs)
                .background(
                    Capsule().fill(Theme.Colors.surface)
                )
        }
    }

    private static func urgency(for ms: Int) -> Urgency {
        if ms < 10_000 { return .red }
        if ms < 30_000 { return .amber }
        return .normal
    }

    /// mm:ss normally; s.t (tenths) once under ten seconds.
    private static func format(_ ms: Int) -> String {
        if ms < 10_000 {
            let tenths = ms / 100
            return String(format: "%d.%d", tenths / 10, tenths % 10)
        }
        let totalSeconds = ms / 1000
        return String(format: "%d:%02d", totalSeconds / 60, totalSeconds % 60)
    }
}

#Preview("Clock — running, normal") {
    Clock(remainingMs: 5 * 60_000, running: true)
        .padding()
        .background(Theme.Colors.background)
}

#Preview("Clock — low time (red, ticking)") {
    Clock(remainingMs: 8_400, running: true)
        .padding()
        .background(Theme.Colors.background)
}

#Preview("Clock — amber, stopped") {
    Clock(remainingMs: 22_000, running: false)
        .padding()
        .background(Theme.Colors.background)
}

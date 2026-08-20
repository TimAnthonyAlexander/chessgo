import SwiftUI

/// What an absent opponent costs the player, counted down live. Mirrors the
/// web's `DisconnectNotice` (`pages/LiveGame.tsx`): a bare "disconnected"
/// until the hub's grace timer is actually armed — it refuses to start the
/// countdown before the clocks are running, so the deadline can arrive after
/// the disconnect notice itself, never before it — then a live mm:ss to the
/// automatic result the timer expires into.
///
/// Self-ticks like `Clock` (`Views/Board/Clock.swift`) via `TimelineView`
/// rather than a `Timer`/`onReceive`, so this leaf re-renders on its own
/// without pushing a tick through `LiveGameView`'s body.
struct DisconnectNotice: View {
    let deadline: Date?
    let outcome: DisconnectGraceOutcome?

    var body: some View {
        if let deadline {
            TimelineView(.periodic(from: .now, by: 0.5)) { timeline in
                countdown(now: timeline.date, deadline: deadline)
            }
        } else {
            Text("disconnected")
                .font(Theme.caption(11))
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    private func countdown(now: Date, deadline: Date) -> some View {
        let leftMs = max(0, deadline.timeIntervalSince(now) * 1000)
        let secs = Int((leftMs / 1000).rounded(.up))
        let clock = String(format: "%d:%02d", secs / 60, secs % 60)
        let verb = outcome == .draw ? "draw in" : "you win in"

        // Warms up as it runs out — good news for the reader, and a number
        // that never changes colour reads as decoration rather than as
        // something with a real deadline attached (same threshold as web).
        return Text("disconnected · \(verb) \(clock)")
            .font(Theme.caption(11).monospacedDigit())
            .foregroundStyle(leftMs <= 10_000 ? Theme.Colors.accent : Theme.Colors.secondaryText)
    }
}

#Preview("DisconnectNotice — no deadline yet") {
    DisconnectNotice(deadline: nil, outcome: nil)
        .padding()
        .background(Theme.Colors.background)
}

#Preview("DisconnectNotice — counting down, you win") {
    DisconnectNotice(deadline: Date().addingTimeInterval(24), outcome: .win)
        .padding()
        .background(Theme.Colors.background)
}

#Preview("DisconnectNotice — inside the warm-up window") {
    DisconnectNotice(deadline: Date().addingTimeInterval(8), outcome: .draw)
        .padding()
        .background(Theme.Colors.background)
}

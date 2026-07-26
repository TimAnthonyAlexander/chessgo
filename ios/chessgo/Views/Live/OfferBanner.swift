import SwiftUI

/// A pending draw/takeback offer. `.theirs` shows Accept/Decline; `.mine`
/// shows a quiet "waiting…" line with a Cancel — which, per
/// `SocketStore.dismissDrawOffer`/`dismissTakebackOffer`, only silences the
/// local banner (there's no wire message to retract your own offer). Renders
/// nothing for `.none` — callers can embed this unconditionally.
struct OfferBanner: View {
    let title: String
    let state: OfferState
    let onAccept: () -> Void
    /// "Decline" when `state == .theirs`, "Cancel" (local dismiss) when `.mine`.
    let onDismiss: () -> Void

    var body: some View {
        switch state {
        case .none:
            EmptyView()
        case .theirs:
            row(label: title, trailing: AnyView(
                HStack(spacing: Theme.Spacing.sm) {
                    Button("Decline", action: onDismiss).glassButton()
                    Button("Accept", action: onAccept).prominentGlassButton()
                }
            ))
        case .mine:
            row(label: "\(title) — waiting…", trailing: AnyView(
                Button("Cancel", action: onDismiss).glassButton()
            ))
        }
    }

    private func row(label: String, trailing: AnyView) -> some View {
        HStack {
            Text(label)
                .font(Theme.body(15))
                .foregroundStyle(state == .mine ? Theme.Colors.secondaryText : Theme.Colors.primaryText)
            Spacer()
            trailing
        }
        .padding(Theme.Spacing.sm)
        .glassCard(cornerRadius: Theme.Radius.md)
    }
}

#Preview("OfferBanner — incoming") {
    OfferBanner(title: "Draw offered", state: .theirs, onAccept: {}, onDismiss: {})
        .padding()
        .background(Theme.Colors.background)
}

#Preview("OfferBanner — outgoing") {
    OfferBanner(title: "Takeback requested", state: .mine, onAccept: {}, onDismiss: {})
        .padding()
        .background(Theme.Colors.background)
}

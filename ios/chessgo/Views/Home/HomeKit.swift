import SwiftUI

/// Shared home-lobby primitives. Every home section composes these so the
/// screen reads as ONE dashboard (consistent headers, consistent hit targets)
/// instead of a stack of bespoke cards. Foundation for the home redesign —
/// section views live in their own files and lean on this.

enum HomeMetrics {
    /// Apple HIG minimum interactive size. Every tappable home cell must be at
    /// least this tall/wide so the screen is usable with imprecise touch.
    static let minTapTarget: CGFloat = 44
}

/// A section title (+ optional one-line subtitle), matching the web's
/// `PanelHead`. Marked as a VoiceOver header so rotor navigation can jump
/// between sections. Left-aligned, tight, no card chrome of its own — the
/// section content below supplies that.
struct HomeSectionHeader: View {
    let title: String
    var subtitle: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(Theme.headline(18))
                .foregroundStyle(Theme.Colors.primaryText)
            if let subtitle {
                Text(subtitle)
                    .font(Theme.caption(13))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A reusable non-interactive `BoardControl` for still-frame board previews
/// (daily-puzzle card, and anywhere else a single FEN needs rendering without
/// a socket or legal-move traffic). Deliberately inert: no legal moves, never
/// the player's turn, `submit` is a no-op. Mirrors the pattern `WatchView`
/// uses for its lobby cards, promoted here so callers don't each reinvent it.
final class StaticBoardControl: BoardControl {
    let fen: String
    let orientation: PieceColor
    let myTurn = false
    let legalMoves: [String] = []
    let lastMove: String?
    let inCheck = false
    let canPremove = false
    let duckSquare: String?

    init(
        fen: String,
        orientation: PieceColor = .white,
        lastMove: String? = nil,
        duckSquare: String? = nil
    ) {
        self.fen = fen.isEmpty ? ChessBoard.startFEN : fen
        self.orientation = orientation
        self.lastMove = (lastMove?.isEmpty ?? true) ? nil : lastMove
        self.duckSquare = (duckSquare?.isEmpty ?? true) ? nil : duckSquare
    }

    func submit(_ uci: String) {}
}

#Preview("HomeSectionHeader") {
    VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
        HomeSectionHeader(title: "Quick pairing", subtitle: "Get matched with a player of similar strength")
        HomeSectionHeader(title: "Daily puzzle")
    }
    .padding(Theme.Spacing.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.Colors.background)
}

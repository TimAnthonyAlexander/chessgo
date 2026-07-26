import SwiftUI

/// One played ply, decoupled from the wire DTO (`WsMoveRef` in
/// Models/LiveGame.swift) so this view has no dependency direction onto the
/// socket layer — callers map whatever move history they have (WS, bot-game
/// `GameMove`, puzzle continuation) into this.
struct MoveListEntry: Identifiable, Sendable, Equatable {
    let ply: Int // 1-based: ply 1 = White's 1st move, ply 2 = Black's 1st move, ...
    let san: String
    let uci: String

    var id: Int { ply }
}

/// Scrollable, paired (1. e4 e5) move list. Tapping a move scrubs to it
/// (`onSelect` gets the 1-based ply); the current ply is highlighted and the
/// list auto-scrolls to the end as new moves arrive.
struct MoveListView: View {
    let moves: [MoveListEntry]
    let currentPly: Int?
    let onSelect: (Int) -> Void

    private var pairs: [(number: Int, white: MoveListEntry?, black: MoveListEntry?)] {
        var result: [(number: Int, white: MoveListEntry?, black: MoveListEntry?)] = []
        var index = 0
        var moveNumber = 1
        while index < moves.count {
            let white = moves[index]
            let black = (index + 1 < moves.count) ? moves[index + 1] : nil
            result.append((moveNumber, white, black))
            index += 2
            moveNumber += 1
        }
        return result
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(pairs, id: \.number) { pair in
                        HStack(spacing: Theme.Spacing.sm) {
                            Text("\(pair.number).")
                                .font(Theme.caption())
                                .foregroundStyle(Theme.Colors.secondaryText)
                                .frame(width: 28, alignment: .trailing)
                            moveCell(pair.white)
                            moveCell(pair.black)
                            Spacer(minLength: 0)
                        }
                        .id(pair.number)
                    }
                }
                .padding(Theme.Spacing.sm)
            }
            .onChange(of: moves.count) { _, _ in
                guard let last = pairs.last?.number else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(last, anchor: .bottom)
                }
            }
        }
    }

    @ViewBuilder
    private func moveCell(_ entry: MoveListEntry?) -> some View {
        if let entry {
            let isCurrent = entry.ply == currentPly
            Button {
                onSelect(entry.ply)
            } label: {
                Text(entry.san)
                    .font(Theme.body(15))
                    .foregroundStyle(isCurrent ? Theme.Colors.accent : Theme.Colors.primaryText)
                    .fontWeight(isCurrent ? .semibold : .regular)
            }
            .frame(width: 64, alignment: .leading)
        } else {
            Color.clear.frame(width: 64, height: 1)
        }
    }
}

#Preview("MoveListView") {
    MoveListViewPreview()
}

private struct MoveListViewPreview: View {
    @State private var currentPly: Int? = 5

    private let moves: [MoveListEntry] = [
        MoveListEntry(ply: 1, san: "e4", uci: "e2e4"),
        MoveListEntry(ply: 2, san: "e5", uci: "e7e5"),
        MoveListEntry(ply: 3, san: "Nf3", uci: "g1f3"),
        MoveListEntry(ply: 4, san: "Nc6", uci: "b8c6"),
        MoveListEntry(ply: 5, san: "Bb5", uci: "f1b5"),
        MoveListEntry(ply: 6, san: "a6", uci: "a7a6"),
    ]

    var body: some View {
        MoveListView(moves: moves, currentPly: currentPly) { ply in
            currentPly = ply
        }
        .frame(height: 220)
        .background(Theme.Colors.background)
    }
}

import Foundation

/// Secret Queen–only display helpers. The rules live entirely on the server
/// (`zugzwang/src/secretqueen.cpp` + `/secretqueen/*`) — this is display logic
/// that has to agree with the server's own reveal test closely enough to
/// flip the board optimistically (see `BotGameDriver`'s "instant reveal" doc
/// comment); the server's FEN is still what actually lands and wins.
/// Ported 1:1 from the web's `frontend/src/lib/variants.ts` /
/// `frontend/src/pages/BotGame.tsx` so the two clients read the variant the
/// same way — see `docs/tasks/open/secret-queen.md`.
enum SecretQueen {
    /// The eight squares `color` may designate its secret queen on: its own
    /// pawns in the starting array. The server validates the pick too
    /// (`BotGameService::pickSecretQueenSquare`) — this is only what the
    /// designation board makes tappable. Mirrors the web's
    /// `secretQueenChoices()`.
    static func homeRankSquares(for color: PieceColor) -> [Square] {
        let rank = color == .white ? 1 : 6 // 0-indexed Square.rank: "2"/"7"
        return (0..<8).compactMap { Square(file: $0, rank: rank) }
    }

    /// Whether `uci` is a move an ordinary pawn of `color` could have made on
    /// `board` — i.e. whether it keeps a Secret Queen hidden. The variant has
    /// no en passant, so destination occupancy alone tells a push from a
    /// capture, and the whole test is a few lines of geometry. Used purely to
    /// decide when to render the reveal a frame early (see
    /// `BotGameDriver.performSubmit`) — the server runs this exact rule for
    /// real and its FEN always wins once it lands. Mirrors the web's
    /// `isPawnShapedMove`.
    static func isPawnShaped(uci: String, color: PieceColor, board: ChessBoard) -> Bool {
        guard let move = Move(uci: uci), board.piece(at: move.from)?.kind == .pawn else { return false }

        let df = abs(move.to.file - move.from.file)
        let dr = move.to.rank - move.from.rank
        let forward = color == .white ? 1 : -1
        let homeRank = color == .white ? 1 : 6 // 0-indexed: rank "2"/"7"
        let occupied = board.piece(at: move.to) != nil

        // Straight pushes: destination must be empty, and a double push only
        // from home with a clear square in between.
        if df == 0, !occupied {
            if dr == forward { return true }
            guard dr == 2 * forward, move.from.rank == homeRank,
                  let mid = Square(file: move.from.file, rank: move.from.rank + forward)
            else { return false }
            return board.piece(at: mid) == nil
        }
        // Diagonal: only as a capture.
        return df == 1 && dr == forward && occupied
    }

    /// Plain-words note for a reveal that just happened — "Black's e-pawn was
    /// a secret queen." `owner` is whose queen was unmasked, NOT who moved —
    /// a CAPTURE reveal unmasks the VICTIM's queen, which is the one case
    /// where the two differ (see `BotGameDriver.narrateReveal`, which works
    /// that out from the move's `by`). The pawn is named by the move's ORIGIN
    /// file, not `reveal.square` (the destination) — a queen sliding e4→h4 is
    /// not "the h-pawn" — except for a capture reveal, where the reveal
    /// square IS where the victim stood, so that one uses it as-is. Two bugs
    /// the web shipped first and fixed here from the start; see
    /// `docs/tasks/open/secret-queen.md` "Two bugs the first pass shipped".
    static func revealMessage(entry: GameMove, reveal: RevealInfo, owner: PieceColor) -> String {
        let side = owner == .white ? "White's" : "Black's"
        let file = reveal.captured ? reveal.square?.first : entry.uci.first
        let pawn = file.map { "\($0)-pawn" } ?? "pawn"
        if reveal.captured { return "\(side) \(pawn) was a secret queen — captured before it could act." }
        if reveal.promoted { return "\(side) \(pawn) reached the back rank — it was a secret queen." }
        return "\(side) \(pawn) was a secret queen."
    }
}

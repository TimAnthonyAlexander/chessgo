import Foundation

/// What a TABLEBASE verdict looks like on the wire, in one place — the Swift
/// twin of `frontend/src/lib/engineEval.ts`.
///
/// zugzwang scores a Syzygy-solved position as `VALUE_TB_WIN` = 31497
/// internally (`zugzwang/src/types.h`). That used to arrive here as a plain
/// `cp` value, and every readout divides cp by 100 — so a won five-man ending
/// displayed as "+314.97" (or "+157.48" after the 0.5 display scale) and gave
/// no hint that the engine had stopped evaluating and started reciting a
/// result.
///
/// The engine now sends (`zugzwang/src/serve_json.h`):
///
///     { "type": "cp", "value": ±1000, "tb": "win" | "loss" }
///
/// `value` stays a sane, usable number so a build that predates `tb` still
/// shows something honest; `tb` carries the truth for a build that knows it.
enum TbVerdict: String, Codable, Sendable, Equatable {
    case win
    case loss

    /// The same verdict from the other side. A verdict is side-to-move
    /// relative exactly like the value it rides on, so it flips wherever that
    /// value is negated: Black to move and losing by tablebase IS White
    /// winning by tablebase.
    var flipped: TbVerdict { self == .win ? .loss : .win }

    /// What prints INSTEAD of the number, given a WHITE-relative verdict.
    /// Deliberately shaped like the mate labels beside it ("M3") — a verdict
    /// is not an evaluation, so it gets no number, but it is still plain text
    /// in the same column with no colour or icon of its own.
    var label: String { self == .win ? "TB" : "-TB" }
}

/// Bottom of the RAW band (`VALUE_TB_WIN - MAX_PLY`). Only needed for an
/// engine older than this change — the app talks to whatever prod is running,
/// which may briefly be a build that still sends 31497 bare. No genuine
/// evaluation comes near 312 pawns, so the magnitude alone is conclusive.
private let tbRawFloor = 31251

extension EvalScore {
    /// The verdict this side-to-move-relative eval carries, or nil.
    var tbVerdict: TbVerdict? {
        if let tb, let v = TbVerdict(rawValue: tb) { return v }
        guard type == "cp", abs(value) >= tbRawFloor else { return nil }
        return value > 0 ? .win : .loss
    }

    /// The verdict converted to White's point of view.
    func tbWhite(sideToMove: PieceColor) -> TbVerdict? {
        guard let v = tbVerdict else { return nil }
        return sideToMove == .white ? v : v.flipped
    }
}

extension EvalWhiteScore {
    /// Already White-relative, so no flip: the analysis payload flips both the
    /// value and the verdict server-side (`GameAnalysisService::whiteEval`).
    var tbVerdict: TbVerdict? {
        if let tb, let v = TbVerdict(rawValue: tb) { return v }
        guard type == "cp", abs(white) >= tbRawFloor else { return nil }
        return white > 0 ? .win : .loss
    }
}

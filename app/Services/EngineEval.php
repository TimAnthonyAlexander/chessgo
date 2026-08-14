<?php

namespace App\Services;

/**
 * The one place PHP knows what a TABLEBASE verdict looks like on the wire.
 *
 * zugzwang scores a Syzygy win as VALUE_TB_WIN = 31497 internally
 * (`zugzwang/src/types.h`). That number used to leave the engine as a plain
 * centipawn value, and every consumer here and in the browser divides cp by 100
 * — so a solved 5-man ending rendered as "+314.97" on the eval bar and injected
 * a 315-pawn swing into ACPL/accuracy. The engine now emits, per
 * `zugzwang/src/serve_json.h`:
 *
 *     {"type": "cp", "value": ±1000, "tb": "win"|"loss"}
 *
 * `value` is deliberately still a sane, usable centipawn number (see TB_CP)
 * so clients that predate `tb` keep working; `tb` carries the truth.
 *
 * Two things this class exists for:
 *  - one definition of the band, so nobody re-derives 31497 by hand;
 *  - {@see sanitize()}, which repairs a RAW pre-fix value. Those are still on
 *    disk: `eval_cache` rows written before this change, and any third-party
 *    eval imported at face value. A magnitude in the band is unambiguous — no
 *    real evaluation reaches 312 pawns.
 */
final class EngineEval
{
    /**
     * Centipawns reported for a tablebase win. Must stay in step with
     * `TB_EVAL_CP` in `zugzwang/src/serve_json.h` — that is where the choice is
     * justified (it is the frontend eval bar's existing ±1000 clamp).
     */
    public const TB_CP = 1000;

    /**
     * Bottom of the raw TB band: zugzwang's `VALUE_TB_WIN - MAX_PLY`
     * (31497 − 246), i.e. `VALUE_TB_WIN_IN_MAX_PLY` in `zugzwang/src/types.h`.
     * A `cp` eval at or above this magnitude is a tablebase verdict that
     * escaped un-tagged, never an evaluation.
     */
    public const TB_RAW_FLOOR = 31251;

    /** Is this eval object a tablebase verdict (tagged, or a raw pre-fix value)? */
    public static function isTb(mixed $eval): bool
    {
        return self::tbOf($eval) !== null;
    }

    /**
     * 'win' | 'loss' from the mover's point of view, or null when the eval is
     * an ordinary evaluation, a mate, or unparseable. Reads the `tb` tag when
     * present and falls back to the raw magnitude for pre-fix values.
     */
    public static function tbOf(mixed $eval): ?string
    {
        if (!is_array($eval)) {
            return null;
        }

        $tb = $eval['tb'] ?? null;
        if ($tb === 'win' || $tb === 'loss') {
            return $tb;
        }

        if (($eval['type'] ?? 'cp') !== 'cp') {
            return null;
        }

        $value = $eval['value'] ?? null;
        if (!is_int($value) && !is_float($value)) {
            return null;
        }

        if (abs((int) $value) < self::TB_RAW_FLOOR) {
            return null;
        }

        return $value > 0 ? 'win' : 'loss';
    }

    /**
     * The eval object with any raw TB value replaced by the wire form
     * (±TB_CP plus the `tb` tag). A already-tagged or ordinary eval is
     * returned unchanged.
     *
     * @param array<string, mixed> $eval
     * @return array<string, mixed>
     */
    public static function sanitize(array $eval): array
    {
        $tb = self::tbOf($eval);
        if ($tb === null) {
            return $eval;
        }

        $eval['type'] = 'cp';
        $eval['value'] = $tb === 'win' ? self::TB_CP : -self::TB_CP;
        $eval['tb'] = $tb;

        return $eval;
    }

    /**
     * The same verdict seen from the other side — for the side-to-move → White
     * conversion, which negates `value` and must flip `tb` with it. Forgetting
     * this reports Black's won ending as White's.
     */
    public static function flip(?string $tb): ?string
    {
        return match ($tb) {
            'win' => 'loss',
            'loss' => 'win',
            default => null,
        };
    }
}

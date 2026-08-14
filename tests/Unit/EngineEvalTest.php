<?php

namespace App\Tests\Unit;

use App\Services\EngineEval;
use PHPUnit\Framework\TestCase;

/**
 * The tablebase-verdict wire format, PHP side.
 *
 * The defect this pins: zugzwang scores a Syzygy win as VALUE_TB_WIN = 31497
 * internally, that number used to leave the engine as a plain `cp`, and every
 * consumer divides cp by 100 — so a won five-man ending read "+314.97" on the
 * eval bar and fed a 315-pawn swing into a player's Tutor report.
 */
class EngineEvalTest extends TestCase
{
    // --- the tag, when the engine sends it ---

    public function test_reads_the_tb_tag(): void
    {
        $this->assertSame('win', EngineEval::tbOf(['type' => 'cp', 'value' => 1000, 'tb' => 'win']));
        $this->assertSame('loss', EngineEval::tbOf(['type' => 'cp', 'value' => -1000, 'tb' => 'loss']));
        $this->assertTrue(EngineEval::isTb(['type' => 'cp', 'value' => 1000, 'tb' => 'win']));
    }

    public function test_an_ordinary_eval_is_not_a_verdict(): void
    {
        $this->assertNull(EngineEval::tbOf(['type' => 'cp', 'value' => 250]));
        $this->assertFalse(EngineEval::isTb(['type' => 'cp', 'value' => -1200]));
        $this->assertFalse(EngineEval::isTb(['type' => 'mate', 'value' => 4]));
        $this->assertFalse(EngineEval::isTb(null));
        $this->assertFalse(EngineEval::isTb('not an eval'));
    }

    /**
     * A genuine +10.00 is deliberately indistinguishable from the verdict's cp
     * stand-in BY MAGNITUDE — that is what the tag is for, and it is why the
     * tag had to be added rather than a threshold agreed on by convention.
     */
    public function test_the_clamp_value_alone_is_not_a_verdict(): void
    {
        $this->assertFalse(EngineEval::isTb(['type' => 'cp', 'value' => EngineEval::TB_CP]));
    }

    // --- the raw band, for evals produced before the tag existed ---

    public function test_a_raw_value_is_recognised_without_a_tag(): void
    {
        // 31497 = VALUE_TB_WIN, the exact number that shipped to production.
        $this->assertSame('win', EngineEval::tbOf(['type' => 'cp', 'value' => 31497]));
        $this->assertSame('loss', EngineEval::tbOf(['type' => 'cp', 'value' => -31497]));
        // VALUE_TB_WIN - MAX_PLY: the in-search probe reports VALUE_TB_WIN - ply,
        // so the whole band down to here is a verdict too.
        $this->assertSame('win', EngineEval::tbOf(['type' => 'cp', 'value' => EngineEval::TB_RAW_FLOOR]));
        $this->assertNull(EngineEval::tbOf(['type' => 'cp', 'value' => EngineEval::TB_RAW_FLOOR - 1]));
    }

    public function test_sanitize_replaces_a_raw_value_with_the_wire_form(): void
    {
        $out = EngineEval::sanitize(['type' => 'cp', 'value' => 31497]);

        $this->assertSame('cp', $out['type']);
        $this->assertSame(EngineEval::TB_CP, $out['value']);
        $this->assertSame('win', $out['tb']);
    }

    public function test_sanitize_leaves_an_ordinary_eval_untouched(): void
    {
        $eval = ['type' => 'cp', 'value' => 37];
        $this->assertSame($eval, EngineEval::sanitize($eval));

        $mate = ['type' => 'mate', 'value' => -2];
        $this->assertSame($mate, EngineEval::sanitize($mate));
    }

    public function test_sanitize_is_idempotent(): void
    {
        $once = EngineEval::sanitize(['type' => 'cp', 'value' => 31497]);
        $this->assertSame($once, EngineEval::sanitize($once));
    }

    // --- point of view ---

    /**
     * A verdict is side-to-move relative exactly like the value it rides on, so
     * it must flip wherever that value is negated. Black to move and losing by
     * tablebase IS White winning by tablebase; getting this wrong reports the
     * won ending to the wrong player.
     */
    public function test_flip_swaps_the_side(): void
    {
        $this->assertSame('loss', EngineEval::flip('win'));
        $this->assertSame('win', EngineEval::flip('loss'));
        $this->assertNull(EngineEval::flip(null));
    }

    /** The clamp must stay in step with zugzwang/src/serve_json.h's TB_EVAL_CP. */
    public function test_the_clamp_is_ten_pawns(): void
    {
        $this->assertSame(1000, EngineEval::TB_CP);
    }
}

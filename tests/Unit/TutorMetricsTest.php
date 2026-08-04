<?php

namespace App\Tests\Unit;

use App\Services\GameAnalysisService;
use App\Services\Tutor\TutorMetrics;
use PHPUnit\Framework\TestCase;
use ReflectionClass;

/**
 * Tests the STATED intent in TutorMetrics's docblocks, not just its current
 * output: cp-loss as a mover-POV eval delta, the ply-0 skip rule, eval
 * clamping vs the per-move cap, mate-score conversion, null-eval handling,
 * the awareness/conversion/resourcefulness triggers, flagging_loss, phaseOf,
 * and the weighting rules in aggregate().
 */
class TutorMetricsTest extends TestCase
{
    private TutorMetrics $m;

    protected function setUp(): void
    {
        $this->m = new TutorMetrics();
    }

    // --- fixture helpers -------------------------------------------------

    /** @return array{type: string, value: float} */
    private function cp(float $v): array
    {
        return ['type' => 'cp', 'value' => $v];
    }

    /** @return array{type: string, value: int} */
    private function mate(int $v): array
    {
        return ['type' => 'mate', 'value' => $v];
    }

    /**
     * One entry of the `plies` shape perGame() expects. `npPieces`/`piece`
     * only matter for the phase/piece dimensions; default them to plausible
     * middlegame-ish values so tests that don't care about them still build
     * a realistic position.
     *
     * @param array{type: string, value: int|float}|null $evalWhite
     * @return array<string, mixed>
     */
    private function ply(?array $evalWhite, string $piece = 'N', int $npPieces = 10, ?float $clockMs = null, ?string $san = 'Nf3'): array
    {
        return ['evalWhite' => $evalWhite, 'san' => $san, 'piece' => $piece, 'npPieces' => $npPieces, 'clockMs' => $clockMs];
    }

    /** @return array<string, mixed> */
    private function game(string $color, string $result, array $plies, string $reason = '', ?float $baseMs = null): array
    {
        return ['color' => $color, 'result' => $result, 'reason' => $reason, 'plies' => $plies, 'baseMs' => $baseMs];
    }

    // --- 1. cp-loss is a mover-POV eval delta -----------------------------

    public function test_cp_loss_is_charged_to_the_mover_whose_eval_dropped(): void
    {
        // White's 2nd move (ply 2, the pair pos2->pos3) drops from +50 to
        // -250 (White POV) — a clean 300cp blunder. Every other transition is
        // eval-flat, so it's the ONLY loss in the game.
        $plies = [
            $this->ply($this->cp(0)),    // pos0 (i=0 skipped regardless)
            $this->ply($this->cp(50)),   // pos1
            $this->ply($this->cp(50)),   // pos2 — White to move, before the blunder
            $this->ply($this->cp(-250)), // pos3 — after the blunder
            $this->ply($this->cp(-250)), // pos4
            $this->ply($this->cp(-250)), // pos5
            $this->ply($this->cp(-250)), // pos6
            $this->ply($this->cp(-250)), // pos7
            $this->ply($this->cp(-250)), // pos8
        ];

        $white = $this->m->perGame($this->game('w', '1-0', $plies));
        $black = $this->m->perGame($this->game('b', '1-0', $plies));

        // White made 3 moves (ply 2,4,6), only one of which lost anything:
        // 300/3 = 100 average.
        $this->assertSame(3, $white['moves'], 'White should have 3 measured moves (ply 2,4,6)');
        $this->assertEqualsWithDelta(100.0, $white['metrics']['acpl']['value'], 0.001, 'White\'s acpl must reflect the 300cp drop it made (300/3 moves)');

        // Black made 4 moves (ply 1,3,5,7), none of which cost anything —
        // the loss belongs to the mover, not the opponent.
        $this->assertSame(4, $black['moves'], 'Black should have 4 measured moves (ply 1,3,5,7)');
        $this->assertEqualsWithDelta(0.0, $black['metrics']['acpl']['value'], 0.001, 'Black\'s acpl must NOT be charged for White\'s own blunder');
    }

    public function test_cp_loss_mover_attribution_is_symmetric_under_colour_flip(): void
    {
        // Same shape, but now BLACK is the one who drops 300cp on its first
        // move (ply 1: pos1 -> pos2, from Black's own POV).
        $plies = [
            $this->ply($this->cp(0)),   // pos0
            $this->ply($this->cp(0)),   // pos1 — Black to move, before the blunder
            $this->ply($this->cp(300)), // pos2 — after (White POV +300 = Black -300, i.e. Black lost 300)
            $this->ply($this->cp(300)), // pos3
            $this->ply($this->cp(300)), // pos4
            $this->ply($this->cp(300)), // pos5
            $this->ply($this->cp(300)), // pos6
            $this->ply($this->cp(300)), // pos7
            $this->ply($this->cp(300)), // pos8
        ];

        $white = $this->m->perGame($this->game('w', '1-0', $plies));
        $black = $this->m->perGame($this->game('b', '1-0', $plies));

        $this->assertEqualsWithDelta(0.0, $white['metrics']['acpl']['value'], 0.001, 'White made no losing moves in the flipped game, acpl must be 0');
        $this->assertEqualsWithDelta(75.0, $black['metrics']['acpl']['value'], 0.001, 'Black\'s acpl must now carry the 300cp drop (300/4 moves) — attribution flips with the mover, not with which colour we started from');
    }

    // --- 2. the ply-0 rule -------------------------------------------------

    public function test_ply_zero_loss_is_recorded_for_neither_side(): void
    {
        // A 500cp drop on the very first move (pos0 -> pos1).
        $plies = [
            $this->ply($this->cp(300)),  // pos0
            $this->ply($this->cp(-200)), // pos1
            $this->ply($this->cp(-200)), // pos2
        ];

        $white = $this->m->perGame($this->game('w', '1-0', $plies));
        $black = $this->m->perGame($this->game('b', '1-0', $plies));

        $this->assertArrayNotHasKey('acpl', $white['metrics'], 'A ply-0 loss must not be counted in White\'s acpl — no other move exists in this game to give White a moveCount');
        $this->assertSame(0, $white['moves'], 'White must have zero measured moves — the only move it played (ply 0) is deliberately skipped');

        // Black's own single move (ply 1) is eval-flat, so its acpl is 0 —
        // proving the ply-0 loss was not folded into it either, e.g. via the
        // "opportunity handed to me" path.
        $this->assertSame(1, $black['moves'], 'Black should have exactly 1 measured move (ply 1)');
        $this->assertEqualsWithDelta(0.0, $black['metrics']['acpl']['value'], 0.001, 'Black\'s acpl must not absorb the skipped ply-0 loss');
    }

    public function test_ply_two_loss_of_the_same_size_is_recorded(): void
    {
        // Same 500cp drop, but this time on White's SECOND move (ply 2), not
        // its first — this one must count.
        $plies = [
            $this->ply($this->cp(300)),  // pos0
            $this->ply($this->cp(300)),  // pos1
            $this->ply($this->cp(300)),  // pos2 — before the drop
            $this->ply($this->cp(-200)), // pos3 — after (300 - (-200) = 500)
            $this->ply($this->cp(-200)), // pos4
        ];

        $white = $this->m->perGame($this->game('w', '1-0', $plies));

        $this->assertSame(1, $white['moves'], 'White should have exactly 1 measured move (ply 2)');
        $this->assertEqualsWithDelta(500.0, $white['metrics']['acpl']['value'], 0.001, 'A 500cp loss on ply 2 (not ply 0) must be recorded in full');
    }

    // --- 3. eval clamping vs the per-move cap ------------------------------

    public function test_eval_clamp_bounds_the_before_eval_before_the_delta_is_taken(): void
    {
        // Before-eval of +5000 must clamp to EVAL_CLAMP (1500) before the
        // delta is computed, so a move from +5000 to +1000 costs 500 (1500 -
        // 1000), never anything close to the raw 4000.
        $plies = [
            $this->ply($this->cp(0)),
            $this->ply($this->cp(1500)), // pos1: Black's move flat vs pos2 below
            $this->ply($this->cp(5000)), // pos2: White to move, before — clamps to 1500
            $this->ply($this->cp(1000)), // pos3: after
        ];

        $white = $this->m->perGame($this->game('w', '1-0', $plies));

        $this->assertEqualsWithDelta(TutorMetrics::EVAL_CLAMP, 1500, 0.0, 'sanity: EVAL_CLAMP is 1500 as documented');
        $this->assertEqualsWithDelta(500.0, $white['metrics']['acpl']['value'], 0.001, '+5000 must clamp to EVAL_CLAMP (1500) before the delta is taken, giving a loss of 500 (1500-1000), not ~4000');
        $this->assertLessThan(4800.0, $white['metrics']['acpl']['value'], 'clamped loss must be far below the raw 4800cp delta');
    }

    public function test_cp_loss_cap_bounds_a_single_moves_contribution(): void
    {
        // Both evals stay within EVAL_CLAMP (±1500), so this isolates
        // CP_LOSS_CAP specifically: a swing from +1400 to -1400 is 2800 raw,
        // capped to 1000.
        $plies = [
            $this->ply($this->cp(0)),
            $this->ply($this->cp(1400)),
            $this->ply($this->cp(1400)),  // pos2: White to move, before
            $this->ply($this->cp(-1400)), // pos3: after — 2800 raw drop
        ];

        $white = $this->m->perGame($this->game('w', '1-0', $plies));

        $this->assertEqualsWithDelta(TutorMetrics::CP_LOSS_CAP, 1000, 0.0, 'sanity: CP_LOSS_CAP is 1000 as documented');
        $this->assertEqualsWithDelta(1000.0, $white['metrics']['acpl']['value'], 0.001, 'a 2800cp raw drop (both evals within EVAL_CLAMP) must be capped at CP_LOSS_CAP (1000)');
    }

    // --- 4. mate scores ------------------------------------------------

    private function invokeMoverEval(?array $evalWhite, string $side): ?float
    {
        $method = (new ReflectionClass(TutorMetrics::class))->getMethod('moverEval');
        $method->setAccessible(true);

        return $method->invoke($this->m, $evalWhite, $side);
    }

    public function test_mate_scores_convert_with_the_correct_sign(): void
    {
        $this->assertGreaterThan(0.0, $this->invokeMoverEval($this->mate(3), 'w'), 'mate value=3 (mover delivers mate) must convert to a POSITIVE cp value for White');
        $this->assertLessThan(0.0, $this->invokeMoverEval($this->mate(-3), 'w'), 'mate value=-3 (mover is being mated) must convert to a NEGATIVE cp value for White');

        // POV flip: the same White-POV mate score is bad for Black.
        $this->assertLessThan(0.0, $this->invokeMoverEval($this->mate(3), 'b'), 'a White-favourable mate score must convert negative from Black\'s POV');
    }

    public function test_mate_in_one_is_a_better_position_than_mate_in_five(): void
    {
        // Realistic mate distances (1 vs 5) both exceed EVAL_CLAMP once
        // converted (MATE_CP=100_000 dwarfs the 1500 clamp), so both
        // saturate to the same clamped ceiling — that's the documented,
        // deliberate behaviour of EVAL_CLAMP ("past roughly a queen, further
        // improvement is not a measure of move quality"), not a bug.
        $mateIn1 = $this->invokeMoverEval($this->mate(1), 'w');
        $mateIn5 = $this->invokeMoverEval($this->mate(5), 'w');
        $this->assertSame(1500.0, $mateIn1, 'a realistic mate-in-1 clamps to the EVAL_CLAMP ceiling');
        $this->assertSame($mateIn1, $mateIn5, 'a realistic mate-in-5 clamps to the SAME ceiling as mate-in-1 — EVAL_CLAMP saturates decisive positions by design');

        // To see the underlying formula's magnitude ordering directly
        // (MATE_CP - abs(value)), pick mate distances so large that even
        // after the MATE_CP fold the result stays under EVAL_CLAMP. This
        // isolates the conversion arithmetic from the clamp.
        $farMateIn100 = $this->invokeMoverEval($this->mate(99900), 'w');  // 100_000 - 99_900 = 100
        $farMateIn10 = $this->invokeMoverEval($this->mate(99990), 'w');   // 100_000 - 99_990 = 10
        $this->assertEqualsWithDelta(100.0, $farMateIn100, 0.001, 'MATE_CP - abs(value) formula check');
        $this->assertEqualsWithDelta(10.0, $farMateIn10, 0.001, 'MATE_CP - abs(value) formula check');
        $this->assertGreaterThan($farMateIn10, $farMateIn100, 'a nearer mate (fewer moves to deliver it) must convert to a strictly larger, better cp value than a more distant one');

        // Same ordering check on the losing side: being mated sooner is
        // worse (more negative) than being mated later.
        $farMatedIn100 = $this->invokeMoverEval($this->mate(-99900), 'w');
        $farMatedIn10 = $this->invokeMoverEval($this->mate(-99990), 'w');
        $this->assertLessThan($farMatedIn10, $farMatedIn100, 'being mated sooner must convert to a strictly smaller (worse) cp value than being mated later');
    }

    public function test_null_eval_converts_to_null_not_zero(): void
    {
        $this->assertNull($this->invokeMoverEval(null, 'w'), 'a missing eval must convert to null, never to a 0cp value');
    }

    // --- 5. null evals are skipped, not treated as zero --------------------

    public function test_null_evals_in_the_middle_of_a_game_are_skipped_not_zeroed(): void
    {
        // pos4 has NO eval. That kills both the pair that uses it as "after"
        // (ply 3, Black's move) and the pair that uses it as "before" (ply
        // 4, White's move) — neither should be counted, and White's second
        // move must simply be absent from the average, not present with a
        // fabricated 0 loss.
        $plies = [
            $this->ply($this->cp(0)),   // pos0
            $this->ply($this->cp(100)), // pos1
            $this->ply($this->cp(100)), // pos2 — White's 1st move: before
            $this->ply($this->cp(50)),  // pos3 — after (loss 50)
            $this->ply(null),           // pos4 — missing eval
            $this->ply($this->cp(0)),   // pos5
        ];

        $white = $this->m->perGame($this->game('w', '1-0', $plies));
        $black = $this->m->perGame($this->game('b', '1-0', $plies));

        $this->assertSame(1, $white['moves'], 'White must have exactly 1 measured move — its 2nd move (ply 4) is unmeasurable because pos4 has no eval, and must be excluded, not counted as a 0-loss move');
        $this->assertEqualsWithDelta(50.0, $white['metrics']['acpl']['value'], 0.001, 'acpl must be computed only over the one measurable White move (loss 50), i.e. 50/1, not 50/2');

        $this->assertSame(1, $black['moves'], 'Black\'s only move (ply 3) is also unmeasurable — pos4 (its "after") has no eval, so Black must have 0 measured moves from ply 3 and only the earlier ply 1 counts');
        $this->assertEqualsWithDelta(0.0, $black['metrics']['acpl']['value'], 0.001, 'Black\'s single measurable move (ply 1) is eval-flat');
    }

    // --- 6. awareness ---------------------------------------------------

    public function test_awareness_counts_punished_opportunities_over_offered_opportunities(): void
    {
        // Black blunders >=150cp three times (ply 1,3,5); White punishes
        // (replies for <=50cp loss) on 2 of the 3.
        // Position eval sequence (White POV): 0, 0, 200, 200, 400, 300, 500, 500, 500.
        // ply1 (Black, blunder #1: 0 -> -200 Black POV = loses 200) — punished by ply2 (White: 200 -> 200, loss 0)
        // ply3 (Black, blunder #2: -200 -> -400 Black POV = loses 200) — NOT punished by ply4 (White: 400 -> 300, loss 100)
        // ply5 (Black, blunder #3: -300 -> -500 Black POV = loses 200) — punished by ply6 (White: 500 -> 500, loss 0)
        $plies = [
            $this->ply($this->cp(0)),   // pos0
            $this->ply($this->cp(0)),   // pos1
            $this->ply($this->cp(200)), // pos2
            $this->ply($this->cp(200)), // pos3
            $this->ply($this->cp(400)), // pos4
            $this->ply($this->cp(300)), // pos5
            $this->ply($this->cp(500)), // pos6
            $this->ply($this->cp(500)), // pos7
            $this->ply($this->cp(500)), // pos8
        ];

        $result = $this->m->perGame($this->game('w', '1-0', $plies));

        $this->assertArrayHasKey('awareness', $result['metrics'], 'three offered opportunities must produce an awareness metric');
        $this->assertEqualsWithDelta(3.0, $result['metrics']['awareness']['weight'], 0.0, 'weight must equal the number of opportunities offered (3), not the number punished');
        $this->assertEqualsWithDelta(66.67, $result['metrics']['awareness']['value'], 0.01, '2 of 3 opportunities punished = 66.67%');
    }

    public function test_awareness_is_absent_not_zero_when_there_were_no_opportunities(): void
    {
        // No opponent move ever loses >= OPPORTUNITY_CP.
        $plies = [
            $this->ply($this->cp(0)),
            $this->ply($this->cp(0)),
            $this->ply($this->cp(10)),
            $this->ply($this->cp(10)),
            $this->ply($this->cp(20)),
            $this->ply($this->cp(20)),
        ];

        $result = $this->m->perGame($this->game('w', '1-0', $plies));

        $this->assertArrayNotHasKey('awareness', $result['metrics'], 'awareness must be ABSENT (not present with value 0) when no opportunity was ever offered');
    }

    // --- 7. conversion / resourcefulness ------------------------------------

    /** Build a game of $lastPly+1 flat-eval positions, spiking to $spikeCp at $spikePly. */
    private function gameWithSpike(int $lastPly, int $spikePly, float $spikeCp, string $result, string $color = 'w'): array
    {
        $plies = [];
        for ($k = 0; $k <= $lastPly; $k++) {
            $plies[] = $this->ply($this->cp($k === $spikePly ? $spikeCp : 0.0));
        }

        return $this->game($color, $result, $plies);
    }

    public function test_conversion_requires_the_decisive_eval_after_trigger_min_ply(): void
    {
        $this->assertSame(12, TutorMetrics::TRIGGER_MIN_PLY, 'sanity: TRIGGER_MIN_PLY is 12 as documented');
        $this->assertSame(200, TutorMetrics::DECISIVE_CP, 'sanity: DECISIVE_CP is 200 as documented');

        // Spike to +500 at ply 4 (< 12) — must NOT trigger, even though the
        // game is won.
        $early = $this->m->perGame($this->gameWithSpike(14, 4, 500.0, '1-0'));
        $this->assertArrayNotHasKey('conversion', $early['metrics'], 'a decisive eval BEFORE TRIGGER_MIN_PLY must not arm the conversion trigger, even in a won game');

        // Spike to +250 at ply 12 (>= 12) — must trigger.
        $lateWin = $this->m->perGame($this->gameWithSpike(14, 12, 250.0, '1-0'));
        $this->assertArrayHasKey('conversion', $lateWin['metrics'], 'a decisive eval at/after TRIGGER_MIN_PLY must arm the conversion trigger');
        $this->assertSame(100.0, $lateWin['metrics']['conversion']['value'], 'converting a winning position into an actual win must score 100');

        $lateLoss = $this->m->perGame($this->gameWithSpike(14, 12, 250.0, '0-1'));
        $this->assertSame(0.0, $lateLoss['metrics']['conversion']['value'], 'passing through a won position but then losing must score 0');

        $lateDraw = $this->m->perGame($this->gameWithSpike(14, 12, 250.0, '1/2-1/2'));
        $this->assertSame(0.0, $lateDraw['metrics']['conversion']['value'], 'conversion requires an outright win (score>=1.0) — a draw after being winning is a failed conversion, scored 0');
    }

    public function test_resourcefulness_requires_the_decisive_eval_after_trigger_min_ply(): void
    {
        $early = $this->m->perGame($this->gameWithSpike(14, 4, -500.0, '0-1'));
        $this->assertArrayNotHasKey('resourcefulness', $early['metrics'], 'a decisive lost eval BEFORE TRIGGER_MIN_PLY must not arm the resourcefulness trigger');

        $lateLoss = $this->m->perGame($this->gameWithSpike(14, 12, -250.0, '0-1'));
        $this->assertArrayHasKey('resourcefulness', $lateLoss['metrics'], 'a decisive lost eval at/after TRIGGER_MIN_PLY must arm the resourcefulness trigger');
        $this->assertSame(0.0, $lateLoss['metrics']['resourcefulness']['value'], 'failing to recover a lost position must score 0');

        // Unlike conversion, resourcefulness only needs score>0 (not
        // score>=1.0) — a draw after being lost DOES count as resourceful.
        $lateDraw = $this->m->perGame($this->gameWithSpike(14, 12, -250.0, '1/2-1/2'));
        $this->assertSame(100.0, $lateDraw['metrics']['resourcefulness']['value'], 'salvaging a draw from a lost position must score 100 — resourcefulness only requires avoiding the loss, not winning outright');

        $lateWin = $this->m->perGame($this->gameWithSpike(14, 12, -250.0, '1-0'));
        $this->assertSame(100.0, $lateWin['metrics']['resourcefulness']['value'], 'a full comeback win from a lost position must score 100');
    }

    // --- 8. flagging_loss -------------------------------------------------

    public function test_flagging_loss_present_only_on_losses(): void
    {
        $win = $this->m->perGame($this->game('w', '1-0', [], 'timeout'));
        $this->assertArrayNotHasKey('flagging_loss', $win['metrics'], 'flagging_loss must be absent on a win, regardless of the recorded reason');

        $draw = $this->m->perGame($this->game('w', '1/2-1/2', [], 'timeout'));
        $this->assertArrayNotHasKey('flagging_loss', $draw['metrics'], 'flagging_loss must be absent on a draw');
    }

    public function test_flagging_loss_is_100_when_reason_contains_time_case_insensitively(): void
    {
        $timeout = $this->m->perGame($this->game('w', '0-1', [], 'timeout'));
        $this->assertSame(100.0, $timeout['metrics']['flagging_loss']['value'], 'reason "timeout" must flag as a time loss');

        $timeForfeit = $this->m->perGame($this->game('w', '0-1', [], 'Time forfeit'));
        $this->assertSame(100.0, $timeForfeit['metrics']['flagging_loss']['value'], 'reason "Time forfeit" (mixed case, extra words) must still flag as a time loss');
    }

    public function test_flagging_loss_is_0_for_a_non_time_loss(): void
    {
        $resign = $this->m->perGame($this->game('w', '0-1', [], 'resign'));
        $this->assertSame(0.0, $resign['metrics']['flagging_loss']['value'], 'a resignation loss must not be flagged as a time loss');

        $checkmate = $this->m->perGame($this->game('w', '0-1', [], 'checkmate'));
        $this->assertSame(0.0, $checkmate['metrics']['flagging_loss']['value'], 'a checkmate loss must not be flagged as a time loss');
    }

    // --- 9. phaseOf ---------------------------------------------------------

    public function test_phase_of_material_rule_beats_move_number(): void
    {
        $this->assertSame(7, TutorMetrics::ENDGAME_PIECES, 'sanity: ENDGAME_PIECES is 7 as documented');
        $this->assertSame(20, TutorMetrics::OPENING_PLIES, 'sanity: OPENING_PLIES is 20 as documented');

        // Few pieces on an early ply is an endgame (material trumps move
        // number), e.g. a queenless line from a gambit.
        $this->assertSame('endgame', $this->m->phaseOf(2, 7), 'exactly ENDGAME_PIECES (7) non-pawn pieces at an early ply must already be classified endgame');
        $this->assertSame('endgame', $this->m->phaseOf(0, 3), 'very few pieces, ply 0, must be endgame — material rule beats move number');

        // Many pieces late in the game is still middlegame, not "opening",
        // once past OPENING_PLIES.
        $this->assertSame('middlegame', $this->m->phaseOf(100, 14), 'many pieces on a very late ply must be middlegame, not opening');

        // Exact boundaries.
        $this->assertSame('opening', $this->m->phaseOf(0, TutorMetrics::ENDGAME_PIECES + 1), 'ENDGAME_PIECES+1 pieces must NOT be classified endgame');
        $this->assertSame('opening', $this->m->phaseOf(TutorMetrics::OPENING_PLIES - 1, 14), 'ply OPENING_PLIES-1 with material intact must still be opening');
        $this->assertSame('middlegame', $this->m->phaseOf(TutorMetrics::OPENING_PLIES, 14), 'ply OPENING_PLIES with material intact must be middlegame — the boundary is inclusive on the middlegame side');
    }

    // --- 10. aggregate() -----------------------------------------------

    public function test_aggregate_weighted_mean_is_weighted_by_weight_not_by_game_count(): void
    {
        // Two games with very different move counts: a 10-move game with
        // acpl 100, a 90-move game with acpl 0.
        $perGame = [
            ['metrics' => ['acpl' => ['value' => 100.0, 'weight' => 10.0]], 'dimensions' => [], 'moves' => 10],
            ['metrics' => ['acpl' => ['value' => 0.0, 'weight' => 90.0]], 'dimensions' => [], 'moves' => 90],
        ];

        $out = $this->m->aggregate($perGame);

        // Weighted mean: (100*10 + 0*90) / 100 = 10. A naive per-game mean
        // (100+0)/2 = 50 would be wrong and must NOT be what's returned.
        $this->assertEqualsWithDelta(10.0, $out['acpl']['value'], 0.001, 'mean must be weighted by move count (weight), giving 10, not the naive per-game average of 50');
        $this->assertNotEqualsWithDelta(50.0, $out['acpl']['value'], 1.0, 'the mean must not equal the naive unweighted per-game average');
    }

    public function test_aggregate_percentiles_are_over_per_game_values_unweighted(): void
    {
        $perGame = [
            ['metrics' => ['acpl' => ['value' => 100.0, 'weight' => 10.0]], 'dimensions' => [], 'moves' => 10],
            ['metrics' => ['acpl' => ['value' => 0.0, 'weight' => 90.0]], 'dimensions' => [], 'moves' => 90],
        ];

        $out = $this->m->aggregate($perGame);

        // p50 of the two per-game values [0, 100] is the plain midpoint 50,
        // regardless of the wildly unequal weights (10 vs 90) that skew the
        // mean down to 10.
        $this->assertEqualsWithDelta(50.0, $out['acpl']['p50'], 0.001, 'p50 must be the unweighted median of the per-GAME values (0 and 100), not skewed toward the heavier-weighted game');
        $this->assertEqualsWithDelta(10.0, $out['acpl']['p10'], 0.001, 'sanity: p10 of a 2-point unweighted sample also lands at the interpolated point');
    }

    public function test_aggregate_sample_counts_games_not_moves(): void
    {
        $perGame = [
            ['metrics' => ['acpl' => ['value' => 100.0, 'weight' => 10.0]], 'dimensions' => [], 'moves' => 10],
            ['metrics' => ['acpl' => ['value' => 0.0, 'weight' => 90.0]], 'dimensions' => [], 'moves' => 90],
        ];

        $out = $this->m->aggregate($perGame);

        $this->assertSame(2, $out['acpl']['sample'], 'sample must count the 2 games that contributed an acpl entry, not the 100 total moves behind them');
    }

    public function test_aggregate_stddev_is_the_sample_stddev(): void
    {
        $perGame = [
            ['metrics' => ['acpl' => ['value' => 100.0, 'weight' => 10.0]], 'dimensions' => [], 'moves' => 10],
            ['metrics' => ['acpl' => ['value' => 0.0, 'weight' => 90.0]], 'dimensions' => [], 'moves' => 90],
        ];

        $out = $this->m->aggregate($perGame);

        // Independently derive the expected sample stddev around the
        // (weighted) mean, using n-1 in the denominator.
        $mean = $out['acpl']['value'];
        $expectedVariance = ((0.0 - $mean) ** 2 + (100.0 - $mean) ** 2) / (2 - 1);
        $expectedStddev = sqrt($expectedVariance);

        $this->assertEqualsWithDelta($expectedStddev, $out['acpl']['stddev'], 0.0001, 'stddev must be the SAMPLE stddev (n-1 denominator) of the per-game values around the mean');
    }

    public function test_aggregate_metric_present_in_only_some_games_has_the_right_sample(): void
    {
        // 'conversion' only fires in games that passed through a decisive
        // winning position — here 2 of 3 games have it.
        $perGame = [
            ['metrics' => ['conversion' => ['value' => 100.0, 'weight' => 1.0]], 'dimensions' => [], 'moves' => 30],
            ['metrics' => [], 'dimensions' => [], 'moves' => 5],
            ['metrics' => ['conversion' => ['value' => 0.0, 'weight' => 1.0]], 'dimensions' => [], 'moves' => 40],
        ];

        $out = $this->m->aggregate($perGame);

        $this->assertSame(2, $out['conversion']['sample'], 'sample must be 2 (only the games that actually produced a conversion entry), not 3 (the total game count)');
        $this->assertEqualsWithDelta(50.0, $out['conversion']['value'], 0.001, 'mean over the 2 contributing games (100 and 0, equal weight) is 50');
    }

    // --- 11. splitKey --------------------------------------------------

    public function test_split_key_round_trips_composite_dimension_keys(): void
    {
        $this->assertSame(['accuracy', 'phase:endgame'], $this->m->splitKey('accuracy@phase:endgame'), 'splitKey must separate the metric from the dimension half at the first @');
        $this->assertSame(['acpl', 'piece:N'], $this->m->splitKey('acpl@piece:N'));
        $this->assertSame(['win_rate', 'opening:Sicilian Defense'], $this->m->splitKey('win_rate@opening:Sicilian Defense'), 'the dimension half may itself contain further structure (a colon-separated opening name)');

        // A plain metric key (no dimension) round-trips to an empty second half.
        $this->assertSame(['win_rate', ''], $this->m->splitKey('win_rate'), 'a key with no @ must split into [key, ""]');
    }

    // --- 12. accuracyFromAcpl ------------------------------------------

    public function test_accuracy_from_acpl_is_monotonically_decreasing_and_bounded(): void
    {
        // Values chosen to stay above the 0-floor, where the exponential
        // fit is still strictly decreasing (it asymptotically approaches,
        // but has not yet been clamped to, 0).
        $values = [0.0, 10.0, 25.0, 50.0, 100.0, 200.0, 500.0];
        $prev = null;
        foreach ($values as $acpl) {
            $a = $this->m->accuracyFromAcpl($acpl);
            $this->assertGreaterThanOrEqual(0.0, $a, "accuracy for acpl=$acpl must not go below 0");
            $this->assertLessThanOrEqual(100.0, $a, "accuracy for acpl=$acpl must not go above 100");
            if ($prev !== null) {
                $this->assertLessThan($prev, $a, "accuracy must strictly decrease as acpl rises (acpl=$acpl must score below the previous, smaller acpl)");
            }
            $prev = $a;
        }

        // Once the fit saturates at the floor, further increases must stay
        // at 0 (non-increasing), not strictly decreasing — there's nowhere
        // lower to go.
        $this->assertSame(0.0, $this->m->accuracyFromAcpl(1000.0), 'sanity: 1000cp average loss is already at the 0 floor');
        $this->assertSame(0.0, $this->m->accuracyFromAcpl(2000.0), 'accuracy must stay clamped at 0 for acpl values beyond the floor, not go negative');

        // Defensive: even a nonsensical negative acpl must stay clamped to
        // the [0,100] range (the formula's exp term can exceed 100 there).
        $this->assertSame(100.0, $this->m->accuracyFromAcpl(-1000.0), 'the upper clamp must engage for an out-of-domain negative acpl');
    }

    public function test_accuracy_from_acpl_matches_game_analysis_service_accuracy(): void
    {
        // GameAnalysisService::accuracy() is private and int-typed, rounded
        // to 1dp; TutorMetrics::accuracyFromAcpl() is the float, unrounded
        // twin. They must never materially disagree — that's the documented
        // reason the formula was copied rather than shared.
        $gas = (new ReflectionClass(GameAnalysisService::class))->newInstanceWithoutConstructor();
        $accuracyMethod = (new ReflectionClass($gas))->getMethod('accuracy');
        $accuracyMethod->setAccessible(true);

        foreach ([0, 50, 100, 300, 1000] as $acpl) {
            $fromGameAnalysis = $accuracyMethod->invoke($gas, $acpl);
            $fromTutor = $this->m->accuracyFromAcpl((float) $acpl);

            $this->assertEqualsWithDelta(
                $fromGameAnalysis,
                $fromTutor,
                0.05,
                "TutorMetrics::accuracyFromAcpl($acpl)=$fromTutor must not disagree with GameAnalysisService::accuracy($acpl)=$fromGameAnalysis beyond rounding",
            );
        }
    }
}

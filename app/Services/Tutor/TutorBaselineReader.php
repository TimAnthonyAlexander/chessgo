<?php

namespace App\Services\Tutor;

use App\Models\TutorBaseline;
use BaseApi\App;

/**
 * Reads peer baselines, with an honest answer when there aren't any.
 *
 * A report must never imply more certainty than its evidence supports, so this
 * returns not just the numbers but WHICH band produced them: the player's own
 * rating band when it has enough games, a widened band when it doesn't, and
 * nothing at all rather than a made-up comparison. The tier is carried all the
 * way to the screen.
 */
class TutorBaselineReader
{
    /** How far to widen, in bands, before giving up. Each step is
     *  TutorBaseline::BUCKET_WIDTH points either side. */
    private const int MAX_WIDEN = 3;

    /** @var array<string, array<string, array<string, mixed>>> */
    private array $cache = [];

    /**
     * Every baseline cell for a rating band, keyed 'metric@dimension' to match
     * the composite keys TutorMetrics::aggregate() emits.
     *
     * Widening merges neighbouring bands weighted by their sample sizes, so a
     * thin band borrows from its neighbours instead of going silent.
     *
     * @return array{tier: string, bandFrom: int, bandTo: int, cells: array<string, array<string, mixed>>}
     */
    public function forRating(string $source, string $category, int $rating): array
    {
        $centre = TutorBaseline::bucketFor($rating);

        for ($widen = 0; $widen <= self::MAX_WIDEN; $widen++) {
            $from = $centre - $widen * TutorBaseline::BUCKET_WIDTH;
            $to = $centre + $widen * TutorBaseline::BUCKET_WIDTH;

            $cells = $this->loadRange($source, $category, $from, $to);

            // A band is usable when its headline metric has real evidence.
            $anchor = $cells['accuracy'] ?? null;
            if ($anchor !== null && ($anchor['sample'] ?? 0) >= TutorBaseline::MIN_SAMPLE) {
                return [
                    'tier' => $widen === 0 ? 'band' : 'widened',
                    'bandFrom' => $from,
                    'bandTo' => $to + TutorBaseline::BUCKET_WIDTH,
                    'cells' => $cells,
                ];
            }
        }

        return ['tier' => 'none', 'bandFrom' => 0, 'bandTo' => 0, 'cells' => []];
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    private function loadRange(string $source, string $category, int $from, int $to): array
    {
        $key = $source . '|' . $category . '|' . $from . '|' . $to;
        if (isset($this->cache[$key])) {
            return $this->cache[$key];
        }

        $rows = App::db()->raw(
            'SELECT metric, dimension, SUM(sample) AS sample,
                    SUM(mean * sample) / NULLIF(SUM(sample), 0) AS mean,
                    SUM(stddev * sample) / NULLIF(SUM(sample), 0) AS stddev,
                    SUM(p10 * sample) / NULLIF(SUM(sample), 0) AS p10,
                    SUM(p25 * sample) / NULLIF(SUM(sample), 0) AS p25,
                    SUM(p50 * sample) / NULLIF(SUM(sample), 0) AS p50,
                    SUM(p75 * sample) / NULLIF(SUM(sample), 0) AS p75,
                    SUM(p90 * sample) / NULLIF(SUM(sample), 0) AS p90
             FROM tutor_baseline
             WHERE source = ? AND category = ? AND rating_bucket BETWEEN ? AND ?
             GROUP BY metric, dimension',
            [$source, $category, $from, $to],
        );

        $cells = [];
        foreach ($rows as $row) {
            $composite = ((string) $row['dimension']) === ''
                ? (string) $row['metric']
                : $row['metric'] . '@' . $row['dimension'];

            $cells[$composite] = [
                'metric' => (string) $row['metric'],
                'dimension' => (string) $row['dimension'],
                'sample' => (int) $row['sample'],
                'mean' => (float) $row['mean'],
                'stddev' => (float) $row['stddev'],
                'p10' => (float) $row['p10'],
                'p25' => (float) $row['p25'],
                'p50' => (float) $row['p50'],
                'p75' => (float) $row['p75'],
                'p90' => (float) $row['p90'],
            ];
        }

        $this->cache[$key] = $cells;

        return $cells;
    }

    /** Which baseline source to compare against. */
    public function activeSource(): string
    {
        $configured = App::config('tutor.baseline_source');
        if (is_string($configured) && $configured !== '') {
            return $configured;
        }

        $row = App::db()->raw(
            'SELECT source, SUM(sample) AS total FROM tutor_baseline GROUP BY source ORDER BY total DESC LIMIT 1',
        );

        return $row === [] ? '' : (string) $row[0]['source'];
    }
}

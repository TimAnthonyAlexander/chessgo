<?php

namespace App\Models;

use BaseApi\Models\BaseModel;

/**
 * What "normal" looks like for one metric, at one rating band, in one category.
 *
 * This is the peer-comparison layer. Every number a Tutor report shows is
 * relative — "your endgame accuracy is 78%" means nothing, "your endgame
 * accuracy is well below other 1500s" is an instruction — and this table is
 * what it's relative TO.
 *
 * We have no meaningful game corpus of our own, so the bands are computed from
 * the public Lichess database dump (CC0), which publishes real games at every
 * rating with engine evals attached. See scripts/import_tutor_baselines.php.
 * Because their evals come from a different engine at a different depth than
 * zugzwang, eval-derived metrics carry a calibration correction — see
 * `source` and docs/tasks/open/tutor.md.
 *
 * One row is one cell: (source, category, rating_bucket, metric, dimension).
 * `dimension` is what makes this one table instead of four — it's '' for a
 * plain metric, or a qualifier like 'phase:endgame', 'piece:R',
 * 'opening:Sicilian Defense' for the breakdowns.
 */
class TutorBaseline extends BaseModel
{
    /** Where the numbers came from, e.g. 'lichess-2026-06'. Kept so a report
     *  can name its own evidence, and so a re-import can replace one source
     *  without touching another. */
    public string $source = '';

    /** Rating category: bullet | blitz | rapid | classical. */
    public string $category = '';

    /** Floor of the rating band, e.g. 1500 means [1500, 1550). Band width is
     *  fixed at TutorBaseline::BUCKET_WIDTH. */
    public int $rating_bucket = 0;

    /** Canonical metric key — see TutorMetrics::METRICS. */
    public string $metric = '';

    /** Qualifier, or '' for the plain metric. 'phase:opening',
     *  'piece:N', 'opening:French Defense', 'theme:fork'. */
    public string $dimension = '';

    /** How many games produced this cell. Shown on screen next to the
     *  comparison — a number without its sample size is an argument, not a
     *  fact. Cells below TutorBaseline::MIN_SAMPLE are not served. */
    public int $sample = 0;

    public float $mean = 0.0;

    public float $stddev = 0.0;

    /** Percentiles, so a report can say "you're in the bottom quarter of
     *  1500s" rather than only "you're below their mean". */
    public float $p10 = 0.0;

    public float $p25 = 0.0;

    public float $p50 = 0.0;

    public float $p75 = 0.0;

    public float $p90 = 0.0;

    /** Rating bands are 50 points wide — wider than Lichess's 30, because our
     *  corpus per cell is smaller and a thin band is a noisy band. */
    public const int BUCKET_WIDTH = 50;

    /** Below this many games, a cell is not trustworthy and is not served;
     *  the report falls back to a wider band or to absolute wording. */
    public const int MIN_SAMPLE = 50;

    /** Bands outside this range are clamped into it — there aren't enough
     *  600-rated or 2900-rated games to bucket finely at the tails. */
    public const int MIN_RATING = 600;

    public const int MAX_RATING = 2600;

    /**
     * Digest of the five identity columns — see cellKey(). A single fixed-width
     * upsert target is cheaper to write against than the five-column key, and
     * makes the importer's INSERT ... ON DUPLICATE KEY UPDATE trivial.
     */
    public string $cell_key = '';

    /**
     * The identity columns are sized explicitly because they carry a composite
     * UNIQUE key, and five default VARCHAR(255)s overflow InnoDB's 3072-byte
     * limit. Note this must be a full type string: the generator passes `type`
     * through verbatim but ignores a separate `length` hint.
     *
     * @var array<string, mixed>
     */
    public static array $columns = [
        'source' => ['type' => 'VARCHAR(64)'],
        'category' => ['type' => 'VARCHAR(24)'],
        'metric' => ['type' => 'VARCHAR(48)'],
        'dimension' => ['type' => 'VARCHAR(96)'],
        'cell_key' => ['type' => 'VARCHAR(40)'],
    ];

    /**
     * The digest carries uniqueness, so a re-import is idempotent
     * (INSERT ... ON DUPLICATE KEY UPDATE). The composite index is the read
     * path: a report asks for every metric in one (category, bucket) at once.
     *
     * @var array<int|string, mixed>
     */
    public static array $indexes = [
        ['cell_key', 'type' => 'unique'],
        ['category', 'rating_bucket'],
    ];

    /**
     * Stable identity of one baseline cell.
     */
    public static function cellKey(
        string $source,
        string $category,
        int $ratingBucket,
        string $metric,
        string $dimension,
    ): string {
        return sha1(implode('|', [$source, $category, (string) $ratingBucket, $metric, $dimension]));
    }

    /**
     * Snap a rating to its band floor, clamped to the range we have data for.
     */
    public static function bucketFor(int $rating): int
    {
        $clamped = max(self::MIN_RATING, min(self::MAX_RATING, $rating));

        return intdiv($clamped, self::BUCKET_WIDTH) * self::BUCKET_WIDTH;
    }
}

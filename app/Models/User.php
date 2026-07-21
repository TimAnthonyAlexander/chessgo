<?php

namespace App\Models;

use Override;
use App\Services\Glicko2Service;
use BaseApi\Database\Relations\HasMany;
use BaseApi\Models\BaseModel;

class User extends BaseModel
{
    public string $name = '';

    public string $password = '';

    public string $email = '';

    public bool $active = true;

    public string $role = 'guest';

    // Per-time-control Glicko-2 ratings (Lichess-style categories). Each category
    // carries a rating plus its uncertainty (rd_) and volatility (vol_), updated
    // one game at a time by Glicko2Service. rated_at_ is the last rated game in
    // that category, used to grow RD back over idle time. games_ is display-only.
    public int $rating_bullet = 1500;

    public int $rating_blitz = 1500;

    public int $rating_rapid = 1500;

    public int $rating_classical = 1500;

    public float $rd_bullet = 350.0;

    public float $rd_blitz = 350.0;

    public float $rd_rapid = 350.0;

    public float $rd_classical = 350.0;

    public float $vol_bullet = 0.06;

    public float $vol_blitz = 0.06;

    public float $vol_rapid = 0.06;

    public float $vol_classical = 0.06;

    public ?string $rated_at_bullet = null;

    public ?string $rated_at_blitz = null;

    public ?string $rated_at_rapid = null;

    public ?string $rated_at_classical = null;

    public int $games_bullet = 0;

    public int $games_blitz = 0;

    public int $games_rapid = 0;

    public int $games_classical = 0;

    // Puzzle rating is a SEPARATE, isolated category: solving puzzles never
    // touches the time-control ratings above. Updated by Glicko2Service against
    // the puzzle's (fixed) rating as the "opponent". See PuzzleController.
    public int $rating_puzzle = 1500;

    public float $rd_puzzle = 350.0;

    public float $vol_puzzle = 0.06;

    public ?string $rated_at_puzzle = null;

    public int $games_puzzle = 0;

    // Duck Chess is ALSO a separate, isolated category: it is its own game with no
    // time-control split (every duck game, whatever its clock, is one "duck"
    // rating). Updated by Glicko2Service just like the time-control categories, but
    // fed only by duck games. See GameResultController.
    public int $rating_duck = 1500;

    public float $rd_duck = 350.0;

    public float $vol_duck = 0.06;

    public ?string $rated_at_duck = null;

    public int $games_duck = 0;

    // Crazyhouse is likewise a separate, isolated category (its own game, no
    // time-control split — every crazyhouse game, whatever its clock, is one
    // "crazyhouse" rating). Fed only by crazyhouse games. See GameResultController.
    public int $rating_crazyhouse = 1500;

    public float $rd_crazyhouse = 350.0;

    public float $vol_crazyhouse = 0.06;

    public ?string $rated_at_crazyhouse = null;

    public int $games_crazyhouse = 0;

    // Antichess (Losing Chess) is likewise a separate, isolated category (its own
    // game, no time-control split — every antichess game, whatever its clock, is
    // one "antichess" rating). Fed only by antichess games. See GameResultController.
    public int $rating_antichess = 1500;

    public float $rd_antichess = 350.0;

    public float $vol_antichess = 0.06;

    public ?string $rated_at_antichess = null;

    public int $games_antichess = 0;

    // "The Flame" — a daily-activity streak (SPEC dashboard). A day qualifies when
    // the user solves a puzzle OR plays a rated game; consecutive qualifying UTC
    // days grow current_streak, a miss resets it to 1 (unless a freeze token
    // covers a single missed day). Rolled forward in ONE place by StreakService,
    // called from the puzzle-solve and rated-game-persist hooks. Dates are UTC
    // 'YYYY-MM-DD', matching how the daily puzzle is keyed by UTC day.
    public int $current_streak = 0;

    public int $longest_streak = 0;

    public ?string $last_active_date = null;

    // Grace tokens that auto-cover a single missed day (a gap of exactly 2 days).
    // New accounts start with one; consumed (not regenerated) when it saves a streak.
    public int $freeze_tokens = 1;

    /**
     * Define indexes for this model
     * @var array<string, string>
     */
    public static array $indexes = [
        'email' => 'unique',
    ];

    /**
     * Per-category last-rated timestamps are stored as nullable TEXT (ISO
     * datetime strings), mirroring ApiToken — strtotime() reads them back.
     *
     * @var array<string, array<string, mixed>>
     */
    public static array $columns = [
        'rated_at_bullet' => ['type' => 'TEXT', 'nullable' => true],
        'rated_at_blitz' => ['type' => 'TEXT', 'nullable' => true],
        'rated_at_rapid' => ['type' => 'TEXT', 'nullable' => true],
        'rated_at_classical' => ['type' => 'TEXT', 'nullable' => true],
        'rated_at_puzzle' => ['type' => 'TEXT', 'nullable' => true],
        'rated_at_duck' => ['type' => 'TEXT', 'nullable' => true],
        'rated_at_crazyhouse' => ['type' => 'TEXT', 'nullable' => true],
        'rated_at_antichess' => ['type' => 'TEXT', 'nullable' => true],
        // The Flame streak's last-qualifying UTC day, stored as 'YYYY-MM-DD' text.
        'last_active_date' => ['type' => 'TEXT', 'nullable' => true],
    ];

    public function checkPassword(string $password): bool
    {
        return password_verify($password, $this->password);
    }

    /** Categories carrying a Glicko-2 rating, including the isolated puzzle + duck + crazyhouse + antichess pools. */
    private const RATING_CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical', 'puzzle', 'duck', 'crazyhouse', 'antichess'];

    /**
     * Serialize for API output. Overrides BaseModel::jsonSerialize() to strip
     * the password hash — BaseModel serializes every public property, so
     * without this the bcrypt hash leaks in every login/signup/me response and
     * in the `$request->user` payload the UserProvider builds.
     *
     * @return array<string, mixed>
     */
    #[Override]
    public function jsonSerialize(): array
    {
        $data = parent::jsonSerialize();
        unset($data['password']);

        // Derived per-category provisional flags (RD > 110): a rating shown with
        // a "?" until the system is confident enough. The frontend reads this
        // map rather than re-deriving the threshold.
        $provisional = [];
        foreach (self::RATING_CATEGORIES as $cat) {
            $provisional[$cat] = ((float) $this->{'rd_' . $cat}) > Glicko2Service::PROVISIONAL_RD;
        }

        $data['provisional'] = $provisional;

        return $data;
    }

    public function apiTokens(): HasMany
    {
        return $this->hasMany(ApiToken::class);
    }
}

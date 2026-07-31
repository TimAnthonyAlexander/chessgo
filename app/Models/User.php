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

    // Player title (Lichess-style), self-service via admin only — never
    // player-editable. 'AM' ("Admin Master") is our own in-joke staff title and
    // is NEVER stored here; it's derived for admins in displayTitle() instead.
    public ?string $title = null;

    /** Allowed values for {@see $title}. Real FIDE-style titles plus our own
     *  admin joke title. Validate any write against this — never trust free text. */
    public const array TITLES = ['GM', 'IM', 'FM', 'CM', 'NM', 'WGM', 'WIM', 'WFM', 'WCM', 'AM'];

    // Short free-text bio, self-editable via POST /me/profile (nullable/clearable).
    public ?string $bio = null;

    // ISO-3166-1 alpha-2 country code, uppercase, self-editable (nullable/clearable).
    public ?string $country = null;

    /** Whitelist of ISO-3166-1 alpha-2 country codes accepted for {@see $country}.
     *  Kept as a flat const so both the model and the controller validate against
     *  the exact same list. */
    public const array COUNTRIES = [
        'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
        'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
        'BT', 'BV', 'BW', 'BY', 'BZ',
        'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW',
        'CX', 'CY', 'CZ',
        'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ',
        'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET',
        'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
        'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT',
        'GU', 'GW', 'GY',
        'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
        'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT',
        'JE', 'JM', 'JO', 'JP',
        'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ',
        'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY',
        'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS',
        'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ',
        'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ',
        'OM',
        'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY',
        'QA',
        'RE', 'RO', 'RS', 'RU', 'RW',
        'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
        'ST', 'SV', 'SX', 'SY', 'SZ',
        'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ',
        'UA', 'UG', 'UM', 'US', 'UY', 'UZ',
        'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU',
        'WF', 'WS',
        'YE', 'YT',
        'ZA', 'ZM', 'ZW',
    ];

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
        // Freeform, so it isn't clipped by the default VARCHAR(255); validated
        // to <=300 chars at the controller.
        'bio' => ['type' => 'TEXT', 'nullable' => true],
    ];

    public function checkPassword(string $password): bool
    {
        return password_verify($password, $this->password);
    }

    /**
     * The title to display for this account: an explicit real title always
     * wins; otherwise every admin shows the "AM" (Admin Master) joke title.
     * Never backfilled into `$title` — computed on read so a role change takes
     * effect immediately with no data migration.
     */
    public function displayTitle(): ?string
    {
        return $this->title ?? ($this->role === 'admin' ? 'AM' : null);
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

        // Always the DERIVED title (a real title wins, otherwise admins show
        // "AM") — never the raw column, so every payload agrees with
        // displayTitle() without each caller re-deriving it.
        $data['title'] = $this->displayTitle();

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

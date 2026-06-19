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
    ];

    public function checkPassword(string $password): bool
    {
        return password_verify($password, $this->password);
    }

    /** Categories carrying a Glicko-2 rating, including the isolated puzzle pool. */
    private const RATING_CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical', 'puzzle'];

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

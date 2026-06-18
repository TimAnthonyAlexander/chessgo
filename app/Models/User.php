<?php

namespace App\Models;

use Override;
use BaseApi\Database\Relations\HasMany;
use BaseApi\Models\BaseModel;

class User extends BaseModel
{
    public string $name = '';

    public string $password = '';

    public string $email = '';

    public bool $active = true;

    public string $role = 'guest';

    // Per-time-control Elo ratings (Lichess-style categories), with the number of
    // rated games played in each (drives the provisional K-factor). See EloService.
    public int $rating_bullet = 1500;

    public int $rating_blitz = 1500;

    public int $rating_rapid = 1500;

    public int $rating_classical = 1500;

    public int $games_bullet = 0;

    public int $games_blitz = 0;

    public int $games_rapid = 0;

    public int $games_classical = 0;

    /**
     * Define indexes for this model
     * @var array<string, string>
     */
    public static array $indexes = [
        'email' => 'unique',
    ];

    public function checkPassword(string $password): bool
    {
        return password_verify($password, $this->password);
    }

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

        return $data;
    }

    public function apiTokens(): HasMany
    {
        return $this->hasMany(ApiToken::class);
    }
}

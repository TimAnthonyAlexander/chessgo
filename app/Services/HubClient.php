<?php

namespace App\Services;

use BaseApi\App;

/**
 * Thin HTTP client for the realtime hub's public stats endpoint. The hub owns
 * the live lobby counts (connected clients, active games); this reads them for
 * the homepage. Base URL comes from HUB_URL (default http://127.0.0.1:6467).
 */
class HubClient
{
    private readonly string $baseUrl;

    public function __construct()
    {
        $this->baseUrl = rtrim((string) (App::config('gomachine.hub_url') ?? 'http://127.0.0.1:6467'), '/');
    }

    /**
     * Live lobby counts. Returns zeros if the hub is unreachable so the lobby
     * still renders — the hub being down is not a client-facing error.
     *
     * @return array{playersOnline: int, activeGames: int}
     */
    public function stats(): array
    {
        $ch = curl_init($this->baseUrl . '/stats');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT_MS => 1000,
            CURLOPT_CONNECTTIMEOUT_MS => 800,
        ]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

        if (!is_string($raw) || $code !== 200) {
            return ['playersOnline' => 0, 'activeGames' => 0];
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            return ['playersOnline' => 0, 'activeGames' => 0];
        }

        return [
            'playersOnline' => (int)($decoded['playersOnline'] ?? 0),
            'activeGames' => (int)($decoded['activeGames'] ?? 0),
        ];
    }

    /**
     * Top live games for the Watch page. Returns an empty list (with the default
     * cap) if the hub is unreachable, so the page still renders. The hub already
     * shapes, sorts, and caps the list; this is a thin pass-through.
     *
     * @return array{games: list<array<string, mixed>>, max: int}
     */
    public function games(): array
    {
        $ch = curl_init($this->baseUrl . '/games');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT_MS => 1000,
            CURLOPT_CONNECTTIMEOUT_MS => 800,
        ]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

        if (!is_string($raw) || $code !== 200) {
            return ['games' => [], 'max' => 5];
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded) || !isset($decoded['games']) || !is_array($decoded['games'])) {
            return ['games' => [], 'max' => 5];
        }

        return [
            'games' => array_values($decoded['games']),
            'max' => (int)($decoded['max'] ?? 5),
        ];
    }
}

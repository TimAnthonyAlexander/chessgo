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

    private readonly string $secret;

    public function __construct()
    {
        $this->baseUrl = rtrim((string) (App::config('gomachine.hub_url') ?? 'http://127.0.0.1:6467'), '/');
        $this->secret = (string) (App::config('gomachine.ws_ticket_secret') ?? '');
    }

    /**
     * Anti-cheat probe: is identity `$sub` currently in a live, non-filler game,
     * and if so, what board are they on? Secret-gated on the hub (X-Hub-Secret).
     *
     * FAIL-OPEN by design: any error / unreachable hub returns ['live' => false]
     * so a hub blip can never (a) block the analysis response or (b) raise a
     * false flag. A missed flag is acceptable; a false one is not.
     *
     * @return array{live: bool, fen: string}
     */
    public function livePlayer(string $sub): array
    {
        if ($sub === '') {
            return ['live' => false, 'fen' => ''];
        }

        $url = $this->baseUrl . '/internal/live-player?sub=' . rawurlencode($sub);
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT_MS => 500,
            CURLOPT_CONNECTTIMEOUT_MS => 400,
            CURLOPT_HTTPHEADER => ['X-Hub-Secret: ' . $this->secret],
        ]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

        if (!is_string($raw) || $code !== 200) {
            return ['live' => false, 'fen' => ''];
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            return ['live' => false, 'fen' => ''];
        }

        return [
            'live' => (bool) ($decoded['live'] ?? false),
            'fen' => (string) ($decoded['fen'] ?? ''),
        ];
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

    /**
     * Mints a server-side, opponent-bound challenge on the hub so the
     * challenger and opponent can both join it via its 6-char code — used by
     * ChallengeController on accept. Unlike every other method on this
     * client, this one does NOT fail soft: a hub blip here means there is no
     * game to join, so the caller must surface it as an error rather than
     * silently returning a code that goes nowhere.
     *
     * @param array{code: string, pool: string, color: string, rated: bool,
     *     variant: string, fen: string, creatorSub: string, opponentSub: string,
     *     ttlSeconds: int} $terms
     */
    public function createServerChallenge(array $terms): bool
    {
        $body = json_encode($terms);
        if (!is_string($body)) {
            return false;
        }

        $ch = curl_init($this->baseUrl . '/internal/challenge');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT_MS => 1500,
            CURLOPT_CONNECTTIMEOUT_MS => 800,
            CURLOPT_CUSTOMREQUEST => 'POST',
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'X-Hub-Secret: ' . $this->secret,
            ],
        ]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

        if (!is_string($raw) || $code !== 200) {
            return false;
        }

        $decoded = json_decode($raw, true);

        return is_array($decoded) && ($decoded['ok'] ?? false) === true;
    }

    /**
     * Which of these account ids (hub "sub" identities) are currently
     * connected to the hub. Fail-soft: an unreachable hub returns an empty
     * set (nobody shows as online) rather than erroring the caller.
     *
     * @param list<string> $subs
     * @return list<string>
     */
    public function onlineSubs(array $subs): array
    {
        $subs = array_values(array_filter($subs, static fn (string $s): bool => $s !== ''));
        if ($subs === []) {
            return [];
        }

        $url = $this->baseUrl . '/internal/online?subs=' . rawurlencode(implode(',', $subs));
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT_MS => 800,
            CURLOPT_CONNECTTIMEOUT_MS => 500,
            CURLOPT_HTTPHEADER => ['X-Hub-Secret: ' . $this->secret],
        ]);
        $raw = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);

        if (!is_string($raw) || $code !== 200) {
            return [];
        }

        $decoded = json_decode($raw, true);
        if (!is_array($decoded) || !isset($decoded['online']) || !is_array($decoded['online'])) {
            return [];
        }

        return array_values(array_map('strval', $decoded['online']));
    }
}

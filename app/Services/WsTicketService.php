<?php

namespace App\Services;

use BaseApi\App;
use JsonException;

/**
 * Mints short-lived HMAC tickets that authenticate a WebSocket connection to the
 * Go realtime hub (SPEC: signed ticket from BaseAPI). The format must match the
 * Go verifier in gomachine/internal/auth exactly:
 *
 *   base64url(payloadJSON) . "." . base64url(HMAC-SHA256(base64url(payloadJSON)))
 *
 * Both sides share WS_TICKET_SECRET. Anonymous players get a ticket with
 * anon=true and an empty sub; rated play requires a real account (sub set).
 */
class WsTicketService
{
    private readonly string $secret;

    private readonly int $ttl;

    public function __construct()
    {
        $this->secret = (string) (App::config('gomachine.ws_ticket_secret') ?? 'dev-insecure-secret');
        $this->ttl = (int) (App::config('gomachine.ws_ticket_ttl') ?? 60);
    }

    /**
     * @param array{sub: string, anon: bool, name: string, rating: int} $identity
     * @throws JsonException
     */
    public function mint(array $identity): string
    {
        $identity['exp'] = time() + $this->ttl;
        $payload = json_encode($identity, JSON_THROW_ON_ERROR);
        $p = $this->b64url($payload);
        $sig = $this->b64url(hash_hmac('sha256', $p, $this->secret, true));

        return $p . '.' . $sig;
    }

    private function b64url(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }
}

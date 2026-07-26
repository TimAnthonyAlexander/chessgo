<?php

namespace App\Controllers;

use App\Models\User;
use App\Models\ApiToken;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use BaseApi\Http\Attributes\ResponseType;
use BaseApi\Http\Attributes\Tag;

/**
 * Login endpoint. Verifies email + password and, on success, persists the
 * user_id to the session so subsequent requests are authenticated.
 */
#[Tag('Authentication')]
class LoginController extends Controller
{
    public string $email = '';

    public string $password = '';

    #[ResponseType(['user' => 'array'])]
    public function post(): JsonResponse
    {
        $this->validate([
            'email' => 'required|string',
            'password' => 'required|string',
        ]);

        $user = User::firstWhere('email', '=', $this->email);

        // firstWhere() returns null for an unknown email; guard before calling
        // checkPassword() so a bad email is a 401, not a fatal null-method call.
        if (!$user instanceof User || !$user->checkPassword($this->password)) {
            return JsonResponse::error('Invalid credentials', 401);
        }

        // A deactivated account (e.g. an admin ban from the anti-cheat review) is
        // refused login. Kept vague on purpose — no "you are banned" tell.
        if (!$user->active) {
            return JsonResponse::error('Invalid credentials', 401);
        }

        // Persist the login by writing $_SESSION directly. Assigning to
        // $this->request->session only mutates a by-value copy on the Request
        // object — PHP persists $_SESSION (not the copy) on shutdown, so writing
        // to the copy silently loses the user_id and the next request is
        // unauthenticated.
        $_SESSION['user_id'] = $user->id;

        // Regenerate session ID to mitigate fixation attacks. session_regenerate_id()
        // preserves $_SESSION across the new id, and guarding on the active status
        // avoids a warning if the session was not started (e.g. in tests).
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_regenerate_id(true);
        }

        // Mint an API token inline so native clients (iOS) get bearer auth
        // without a second round trip. Additive field — the web SPA (cookie
        // auth) simply ignores it.
        $payload = $user->jsonSerialize();
        $token = $this->issueToken($user);
        $payload['api_token'] = $token['token'];
        $payload['api_token_id'] = $token['id'];

        return JsonResponse::ok($payload);
    }

    /**
     * @return array{token: string, id: string}
     */
    private function issueToken(User $user): array
    {
        $plainToken = ApiToken::generateToken();

        $apiToken = new ApiToken();
        $apiToken->user_id = $user->id;
        $apiToken->name = 'iOS App';
        $apiToken->token_hash = ApiToken::hashToken($plainToken);
        $apiToken->save();

        return ['token' => $plainToken, 'id' => $apiToken->id];
    }
}

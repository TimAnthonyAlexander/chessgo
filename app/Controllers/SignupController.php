<?php

namespace App\Controllers;

use App\Models\User;
use App\Models\ApiToken;
use App\Services\EmailService;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use BaseApi\Http\Attributes\ResponseType;
use BaseApi\Http\Attributes\Tag;
use RuntimeException;

/**
 * User registration endpoint.
 * Creates a new user account with email and password.
 */
#[Tag('Authentication')]
class SignupController extends Controller
{
    public string $name = '';

    public string $email = '';

    public string $password = '';

    public function __construct(
        private readonly EmailService $emailService,
    ) {}

    #[ResponseType(User::class)]
    public function post(): JsonResponse
    {
        $this->validate([
            'name' => 'required|string',
            'email' => 'required|string|email',
            'password' => 'required|string|min:8',
        ]);

        // Check if user already exists
        $existingUser = User::firstWhere('email', '=', $this->email);
        if ($existingUser instanceof User) {
            return JsonResponse::error('User with this email already exists', 409);
        }

        // Create new user
        $user = new User();
        $user->name = $this->name;
        $user->email = $this->email;
        $user->password = password_hash($this->password, PASSWORD_DEFAULT);
        $user->role = 'user';
        $user->active = true;

        if (!$user->save()) {
            return JsonResponse::error('Failed to create user', 500);
        }

        // Send welcome email using injected service
        $this->emailService->sendWelcome($user->email, $user->name);

        // Log the user in automatically. Write $_SESSION directly: assigning to
        // $this->request->session only mutates a by-value copy on the Request
        // object, which PHP never persists — so the new user would be logged
        // out on their very next request.
        $_SESSION['user_id'] = $user->id;

        // Regenerate session ID for security (guarded so it does not warn when
        // no session is active, e.g. in tests).
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_regenerate_id(true);
        }

        // Mint an API token inline so native clients (iOS) get bearer auth
        // without a second round trip. Additive field — the web SPA ignores it.
        // Never let a failed mint fail the whole signup (the session cookie
        // above already succeeded) — just log it and omit the fields, so a
        // bearer client sees no api_token rather than an unusable one.
        $payload = $user->jsonSerialize();
        try {
            $token = $this->issueToken($user);
            $payload['api_token'] = $token['token'];
            $payload['api_token_id'] = $token['id'];
        } catch (RuntimeException $e) {
            error_log('[Signup] API token mint failed for user ' . $user->id . ': ' . $e->getMessage());
        }

        return JsonResponse::created($payload);
    }

    /**
     * @return array{token: string, id: string}
     * @throws RuntimeException if the token fails to persist — a caller must
     *         never hand a client a bearer token that isn't actually in the
     *         database, or the very next request with it 401s and the client
     *         (correctly) treats that as "log this session out."
     */
    private function issueToken(User $user): array
    {
        $plainToken = ApiToken::generateToken();

        $apiToken = new ApiToken();
        $apiToken->user_id = $user->id;
        $apiToken->name = 'iOS App';
        $apiToken->token_hash = ApiToken::hashToken($plainToken);

        if (!$apiToken->save()) {
            throw new RuntimeException('Failed to persist API token');
        }

        return ['token' => $plainToken, 'id' => $apiToken->id];
    }
}

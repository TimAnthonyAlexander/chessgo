<?php

declare(strict_types=1);

namespace App\Middleware;

use Throwable;
use App\Models\ApiToken;
use Exception;
use Override;
use BaseApi\Http\Middleware;
use BaseApi\Http\Request;
use BaseApi\Http\Response;
use BaseApi\App;

/**
 * Attempts authentication (API token first, then session) and attaches the
 * resolved user to the request, but ALWAYS proceeds — never returns 401.
 *
 * Use on routes that behave better when they know who you are but must still
 * serve anonymous callers (e.g. /ws-ticket: a logged-in bearer client gets a
 * rated ticket, an anonymous client gets a casual one). This is
 * CombinedAuthMiddleware minus the rejection.
 */
class OptionalAuthMiddleware implements Middleware
{
    #[Override]
    public function handle(Request $request, callable $next): Response
    {
        $user = $this->tryApiTokenAuth($request);
        $authMethod = 'api_token';

        if (!$user) {
            $user = $this->trySessionAuth($request);
            $authMethod = 'session';
        }

        if ($user) {
            $request->user = $user;
            $request->authMethod = $authMethod;
        }

        return $next($request);
    }

    /**
     * Try to authenticate via API token (Authorization: Bearer <token>).
     */
    private function tryApiTokenAuth(Request $request): ?array
    {
        $authHeader = null;
        foreach ($request->headers ?? [] as $k => $v) {
            if (strcasecmp((string)$k, 'authorization') === 0) {
                $authHeader = is_array($v) ? reset($v) : $v;
                break;
            }
        }

        if (!is_string($authHeader) || strncasecmp($authHeader, 'Bearer ', 7) !== 0) {
            return null;
        }

        $token = trim(substr($authHeader, 7));
        if ($token === '' || $token === '0') {
            return null;
        }

        try {
            $tokenModel = ApiToken::findByToken($token);
            if (!$tokenModel instanceof ApiToken || $tokenModel->isExpired()) {
                return null;
            }

            $userProvider = App::userProvider();
            $user = $userProvider->byId($tokenModel->user_id);
            if ($user) {
                $tokenModel->updateLastUsed();
            }

            return $user;
        } catch (Throwable) {
            return null;
        }
    }

    /**
     * Try to authenticate via session (user_id set by a prior login).
     */
    private function trySessionAuth(Request $request): ?array
    {
        if (!isset($request->session['user_id']) || empty($request->session['user_id'])) {
            return null;
        }

        try {
            $userProvider = App::userProvider();
            $user = $userProvider->byId($request->session['user_id']);

            if ($user === null) {
                unset($request->session['user_id']);
                return null;
            }

            return $user;
        } catch (Exception) {
            return null;
        }
    }
}

<?php

declare(strict_types=1);

namespace App\Middleware;

use App\Services\BearerAuth;
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
     * `BearerAuth` also covers the SAPI variants where the header only shows up
     * in $_SERVER — see the note there.
     */
    private function tryApiTokenAuth(Request $request): ?array
    {
        return BearerAuth::user($request);
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

<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\ApiToken;
use BaseApi\App;
use BaseApi\Http\Request;
use Throwable;

/**
 * Resolves an `Authorization: Bearer <api_token>` into a user array.
 *
 * This exists as a service rather than only as middleware because a route that
 * merely *prefers* to know who you are must not silently degrade to anonymous
 * when its auth middleware isn't in effect. That is exactly what bit /ws-ticket
 * in production: iOS sent a valid token, the ticket came back `anon:true` with
 * the device's install id as `sub`, so the realtime hub saw the phone and the
 * browser as two unrelated players — no resume, no rated live play.
 *
 * The header lookup is deliberately paranoid. Depending on the SAPI and the
 * web-server config, `Authorization` reaches PHP as a parsed request header, as
 * `$_SERVER['HTTP_AUTHORIZATION']`, or (behind a rewrite) only as
 * `REDIRECT_HTTP_AUTHORIZATION`. Reading just one of those works locally and
 * fails on the box that matters.
 */
final class BearerAuth
{
    /** @return array<string, mixed>|null the user array, or null if no valid token */
    public static function user(?Request $request = null): ?array
    {
        $token = self::token($request);
        if ($token === null) {
            return null;
        }

        try {
            $model = ApiToken::findByToken($token);
            if (!$model instanceof ApiToken || $model->isExpired()) {
                return null;
            }

            $user = App::userProvider()->byId($model->user_id);
            if ($user) {
                $model->updateLastUsed();
            }

            return is_array($user) ? $user : null;
        } catch (Throwable) {
            return null;
        }
    }

    /** The bearer token from wherever this SAPI happens to expose it, or null. */
    public static function token(?Request $request = null): ?string
    {
        $header = self::header($request);
        if (!is_string($header) || strncasecmp($header, 'Bearer ', 7) !== 0) {
            return null;
        }

        $token = trim(substr($header, 7));

        return $token === '' ? null : $token;
    }

    private static function header(?Request $request): ?string
    {
        foreach ($request->headers ?? [] as $name => $value) {
            if (strcasecmp((string) $name, 'authorization') === 0) {
                $header = is_array($value) ? reset($value) : $value;
                if (is_string($header) && $header !== '') {
                    return $header;
                }
            }
        }

        foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION'] as $key) {
            $header = $_SERVER[$key] ?? null;
            if (is_string($header) && $header !== '') {
                return $header;
            }
        }

        if (function_exists('getallheaders')) {
            foreach (getallheaders() ?: [] as $name => $value) {
                if (strcasecmp((string) $name, 'authorization') === 0 && is_string($value) && $value !== '') {
                    return $value;
                }
            }
        }

        return null;
    }
}

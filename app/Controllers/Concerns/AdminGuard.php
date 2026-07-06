<?php

namespace App\Controllers\Concerns;

use BaseApi\Http\Request;
use BaseApi\Http\JsonResponse;

/**
 * Shared admin gate for every admin-only controller. CombinedAuthMiddleware has
 * already authenticated the caller and attached the resolved account as
 * $request->user (an array carrying `role`); this only checks the role.
 *
 * Usage in a controller handler (return early on a non-admin):
 *
 *   if ($denied = $this->requireAdmin($this->request)) {
 *       return $denied;
 *   }
 *
 * Returns the 403 JsonResponse to short-circuit with, or null when the caller is
 * an admin. Keeps the exact behavior AdminFlagsController shipped with
 * (role === 'admin' else 403 "admin only").
 */
trait AdminGuard
{
    protected function requireAdmin(?Request $request): ?JsonResponse
    {
        $user = $request?->user ?? null;
        if (!is_array($user) || ($user['role'] ?? '') !== 'admin') {
            return JsonResponse::error('admin only', 403);
        }

        return null;
    }
}

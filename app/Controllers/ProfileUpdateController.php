<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Models\User;

/**
 * Self-service profile edit: bio + country only. `title` is never editable
 * here — it's staff-assigned (or derived for admins by User::displayTitle()).
 *
 *   POST /me/profile  { bio?: string|null, country?: string|null }
 *
 * Both fields are nullable/clearable: an explicit `null` (or an omitted key)
 * clears the field; a present string value replaces it. Updates ONLY the
 * authenticated user — CombinedAuthMiddleware resolves `$request->user`.
 */
class ProfileUpdateController extends Controller
{
    public ?string $bio = null;

    public ?string $country = null;

    public function post(): JsonResponse
    {
        $authUser = $this->request->user;
        if (!$authUser) {
            return JsonResponse::unauthorized();
        }

        $this->validate([
            'bio' => 'string|max:300',
            'country' => 'string|max:2',
        ]);

        $country = $this->country !== null ? strtoupper(trim($this->country)) : null;
        if ($country === '') {
            $country = null;
        }
        if ($country !== null && !in_array($country, User::COUNTRIES, true)) {
            return JsonResponse::badRequest('country must be a valid ISO-3166-1 alpha-2 code');
        }

        $bio = $this->bio !== null ? trim($this->bio) : null;
        if ($bio === '') {
            $bio = null;
        }

        $user = User::find($authUser['id']);
        if (!$user instanceof User) {
            return JsonResponse::notFound('user not found');
        }

        $user->bio = $bio;
        $user->country = $country;

        if (!$user->save()) {
            return JsonResponse::error('Failed to update profile', 500);
        }

        return JsonResponse::ok([
            'id' => $user->id,
            'name' => $user->name,
            'title' => $user->displayTitle(),
            'bio' => $user->bio,
            'country' => $user->country,
        ]);
    }
}

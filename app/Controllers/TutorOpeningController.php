<?php

namespace App\Controllers;

use App\Models\TutorReport;
use App\Models\User;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;

/**
 * One opening family, from one side, inside one report.
 *
 * GET /tutor/reports/{id}/opening?category=blitz&color=w&family=Sicilian%20Defense
 *
 * Lichess's Tutor drills down the same way (per family, per colour), and in
 * their own users' threads the opening breakdown is the single most-cited
 * concrete output — "it showed me I rely on the Sicilian". A weakness card
 * that says "you score badly in the French as Black" needs somewhere to go
 * when clicked, and this is it.
 *
 * Served entirely from the stored report payload: the games behind a number
 * were recorded when the report was built (see TutorBuildService::gameRows),
 * so a drilldown costs one row read and never re-analyzes anything.
 *
 * The family is a query parameter rather than a path segment because opening
 * names contain spaces, commas and slashes.
 */
class TutorOpeningController extends Controller
{
    public string $id = '';

    public string $category = '';

    public string $color = 'w';

    public string $family = '';

    public function get(): JsonResponse
    {
        $user = $this->currentUser();
        if (!$user instanceof User) {
            return JsonResponse::unauthorized('Sign in to use Tutor.');
        }

        $this->validate([
            'category' => 'required|string|max:24',
            'color' => 'required|string|max:1',
            'family' => 'required|string|max:120',
        ]);

        $report = TutorReport::find($this->id);
        if (!$report instanceof TutorReport) {
            return JsonResponse::notFound('Report not found.');
        }

        if ($report->user_id !== $user->id && $user->role !== 'admin') {
            return JsonResponse::notFound('Report not found.');
        }

        $colour = $this->color === 'b' ? 'b' : 'w';
        $payload = $report->getPayload();
        $section = $payload['categories'][$this->category] ?? null;

        if (!is_array($section)) {
            return JsonResponse::notFound('No such category in this report.');
        }

        // The comparison for exactly this (colour, family), if the opening had
        // enough games to be compared at all.
        $comparison = null;
        foreach ($section['openings'][$colour] ?? [] as $entry) {
            if (($entry['name'] ?? '') === $this->family) {
                $comparison = $entry;
                break;
            }
        }

        // The actual games behind it — this is the report showing its working.
        $games = array_values(array_filter(
            $section['gameRows'] ?? [],
            fn(array $row): bool => ($row['opening'] ?? '') === $this->family
                && ($row['color'] ?? '') === $colour,
        ));

        if ($comparison === null && $games === []) {
            return JsonResponse::notFound('You have no games in that opening from that side in this report.');
        }

        $score = 0.0;
        $accuracySum = 0.0;
        $accuracyCount = 0;
        foreach ($games as $row) {
            $score += $this->scoreFor((string) ($row['result'] ?? ''), $colour);
            if (isset($row['accuracy']) && is_numeric($row['accuracy'])) {
                $accuracySum += (float) $row['accuracy'];
                $accuracyCount++;
            }
        }

        return JsonResponse::ok([
            'category' => $this->category,
            'color' => $colour,
            'family' => $this->family,
            'comparison' => $comparison,
            'peer' => $section['peer'] ?? null,
            'games' => $games,
            'summary' => [
                'games' => count($games),
                'score' => $games === [] ? null : round(100.0 * $score / count($games), 1),
                'accuracy' => $accuracyCount === 0 ? null : round($accuracySum / $accuracyCount, 1),
            ],
            'drill' => [
                'kind' => 'opening',
                'opening' => $this->family,
                'color' => $colour,
            ],
        ]);
    }

    private function scoreFor(string $result, string $color): float
    {
        return match ($result) {
            '1-0' => $color === 'w' ? 1.0 : 0.0,
            '0-1' => $color === 'w' ? 0.0 : 1.0,
            '1/2-1/2' => 0.5,
            default => 0.0,
        };
    }

    private function currentUser(): ?User
    {
        $u = $this->request->user ?? null;
        if (!is_array($u) || empty($u['id'])) {
            return null;
        }

        $found = User::find((string) $u['id']);

        return $found instanceof User ? $found : null;
    }
}

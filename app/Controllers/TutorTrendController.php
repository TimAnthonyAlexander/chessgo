<?php

namespace App\Controllers;

use App\Models\TutorReport;
use App\Models\User;
use App\Services\Tutor\TutorMetrics;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;

/**
 * The same metric across every report you've built.
 *
 * GET /tutor/trend?category=blitz
 *
 * This ships in v1 on purpose. Lichess stores every report and still shows
 * each one as an isolated snapshot — "show changes over time" has been an open
 * request on their tracker since February 2026. The data is already sitting in
 * the table; reading two rows instead of one is not a feature, and a player
 * watching a weak number move is the only real proof the advice worked.
 */
class TutorTrendController extends Controller
{
    public string $category = '';

    public function get(): JsonResponse
    {
        $user = $this->currentUser();
        if (!$user instanceof User) {
            return JsonResponse::unauthorized('Sign in to use Tutor.');
        }

        $reports = TutorReport::query()
            ->where('user_id', '=', $user->id)
            ->where('status', '=', 'ready')
            ->orderBy('created_at')
            ->limit(50)
            ->get();

        $categories = [];
        $points = [];

        foreach ($reports as $report) {
            $payload = $report->getPayload();
            $stamp = $report->built_at ?? $report->created_at;

            foreach ($payload['categories'] ?? [] as $category => $section) {
                $categories[$category] = true;

                if ($this->category !== '' && $this->category !== $category) {
                    continue;
                }

                foreach ($section['metrics'] ?? [] as $metric => $entry) {
                    $points[$category][$metric][] = [
                        'reportId' => $report->id,
                        'at' => $stamp,
                        // YOUR measured value, never the comparison. This is
                        // what makes a trend line legitimate across reports:
                        // two reports may have been compared against different
                        // peer tiers (or none at all), so plotting graded
                        // values would put incommensurable numbers on one line.
                        // The raw metric is measured identically every time.
                        'value' => $entry['value'] ?? null,
                        'sample' => $entry['sample'] ?? 0,
                        // Carried so the UI can mark a point whose report had
                        // no peer data, rather than quietly implying they are
                        // all equally well-founded.
                        'peerTier' => $section['peer']['tier'] ?? 'none',
                        'rating' => $section['rating'] ?? null,
                    ];
                }
            }
        }

        // A single point is not a trend, and drawing it as one implies movement
        // that hasn't been measured.
        $series = [];
        foreach ($points as $category => $metrics) {
            foreach ($metrics as $metric => $values) {
                if (count($values) < 2) {
                    continue;
                }

                $def = TutorMetrics::METRICS[$metric] ?? null;
                $first = (float) ($values[0]['value'] ?? 0);
                $last = (float) ($values[count($values) - 1]['value'] ?? 0);
                $delta = $last - $first;

                $tiers = array_unique(array_column($values, 'peerTier'));

                $series[$category][$metric] = [
                    'label' => $def['label'] ?? $metric,
                    'unit' => $def['unit'] ?? 'percent',
                    'higherIsBetter' => $def['higherIsBetter'] ?? true,
                    'points' => $values,
                    'delta' => round($delta, 2),
                    'improved' => ($def['higherIsBetter'] ?? true) ? $delta > 0 : $delta < 0,
                    // True when the reports behind this line were compared
                    // against different peer tiers. The line itself is still
                    // valid — it plots raw measured values — but the UI should
                    // say so rather than presenting a uniform history.
                    'mixedTiers' => count($tiers) > 1,
                ];
            }
        }

        return JsonResponse::ok([
            'categories' => array_keys($categories),
            'series' => $series,
            'reports' => count($reports),
        ]);
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

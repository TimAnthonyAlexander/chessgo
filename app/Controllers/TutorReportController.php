<?php

namespace App\Controllers;

use App\Models\TutorReport;
use App\Models\User;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;

/**
 * One Tutor report.
 *
 * GET /tutor/reports/{id} → the full payload.
 *
 * Reports are private. A report is a fairly intimate description of how
 * somebody plays and where they're weak, so it is readable by its owner and by
 * an admin, and by nobody else. Sharing is a v2 question with a privacy answer
 * attached and nothing depends on it.
 */
class TutorReportController extends Controller
{
    public string $id = '';

    public function get(): JsonResponse
    {
        $user = $this->currentUser();
        if (!$user instanceof User) {
            return JsonResponse::unauthorized('Sign in to use Tutor.');
        }

        $report = TutorReport::find($this->id);
        if (!$report instanceof TutorReport) {
            return JsonResponse::notFound('Report not found.');
        }

        if ($report->user_id !== $user->id && $user->role !== 'admin') {
            // Not 403 — a stranger shouldn't be able to learn that a given
            // report id exists at all.
            return JsonResponse::notFound('Report not found.');
        }

        return JsonResponse::ok([
            'report' => $report->summaryRow(),
            'payload' => $report->getPayload(),
        ]);
    }

    /**
     * Delete one of your own reports.
     *
     * Kept simple and real: reports are the trend view's raw data, so this is
     * the only way to remove one, and it removes exactly one.
     */
    public function delete(): JsonResponse
    {
        $user = $this->currentUser();
        if (!$user instanceof User) {
            return JsonResponse::unauthorized('Sign in to use Tutor.');
        }

        $report = TutorReport::find($this->id);
        if (!$report instanceof TutorReport || $report->user_id !== $user->id) {
            return JsonResponse::notFound('Report not found.');
        }

        $report->delete();

        return JsonResponse::ok(['deleted' => true]);
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

<?php

namespace App\Jobs;

use Override;
use App\Models\TutorReport;
use App\Services\Tutor\TutorBuildService;
use BaseApi\App;
use BaseApi\Queue\Job;
use Throwable;

/**
 * Builds a requested Tutor report off the request thread.
 *
 * A report analyzes up to a few hundred games, so it cannot run inline on an
 * HTTP request. The user presses the button, gets an immediate "queued", and a
 * notification when it lands — the same shape as the analysis job.
 *
 * Requires QUEUE_DRIVER=database plus a running `php mason queue:work`. Under
 * the `sync` driver (the dev default) it runs inline on the request instead,
 * which is fine for a handful of games and painful for hundreds.
 */
class TutorReportJob extends Job
{
    protected int $maxRetries = 1;

    protected int $retryDelay = 60;

    public function __construct(private readonly string $reportId) {}

    #[Override]
    public function handle(): void
    {
        $report = TutorReport::find($this->reportId);
        if (!$report instanceof TutorReport) {
            return;
        }

        // A retry must not rebuild something already finished.
        if (!in_array($report->status, ['queued', 'building'], true)) {
            return;
        }

        App::container()->make(TutorBuildService::class)->build($report);
    }

    #[Override]
    public function failed(Throwable $throwable): void
    {
        $report = TutorReport::find($this->reportId);
        if ($report instanceof TutorReport && in_array($report->status, ['queued', 'building'], true)) {
            $report->status = 'failed';
            $report->error = substr($throwable->getMessage(), 0, 2000);
            $report->built_at = date('Y-m-d H:i:s');
            $report->save();
        }

        error_log('[tutor] report job failed for ' . $this->reportId . ': ' . $throwable->getMessage());
        parent::failed($throwable);
    }
}

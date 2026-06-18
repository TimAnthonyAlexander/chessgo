<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\HubClient;

/**
 * Live lobby counts for the homepage (proxies the realtime hub). Public.
 *
 *   GET /stats → { playersOnline, activeGames }
 */
class StatsController extends Controller
{
    public function __construct(private readonly HubClient $hub)
    {
    }

    public function get(): JsonResponse
    {
        return JsonResponse::ok($this->hub->stats());
    }
}

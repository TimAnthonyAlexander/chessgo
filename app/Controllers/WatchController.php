<?php

namespace App\Controllers;

use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;
use App\Services\HubClient;

/**
 * Top live games for the Watch page (proxies the realtime hub). Public.
 *
 *   GET /watch → { games: [...], max: 5 }
 *
 * The hub owns the list: it shapes each row (both players, FEN, clocks), sorts
 * real games ahead of self-play fillers by combined rating, and caps it. This
 * controller is a thin pass-through so the browser only ever talks to BaseAPI.
 */
class WatchController extends Controller
{
    public function __construct(private readonly HubClient $hub)
    {
    }

    public function get(): JsonResponse
    {
        return JsonResponse::ok($this->hub->games());
    }
}

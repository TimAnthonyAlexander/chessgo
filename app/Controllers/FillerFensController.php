<?php

namespace App\Controllers;

use BaseApi\App;
use BaseApi\Controllers\Controller;
use BaseApi\Http\JsonResponse;

/**
 * Internal endpoint the realtime hub calls (once, at startup) to seed its
 * self-play "watch" fillers from realistic midgame positions instead of the
 * opening. It returns a pool of puzzle FENs for a given theme; the hub caches
 * the pool and picks from it per filler, falling back to the start position on
 * any failure (so the lobby never depends on this).
 *
 *   GET /internal/filler-fens?theme=pin&n=200   (header X-Hub-Secret: <WS_TICKET_SECRET>)
 *   → { fens: ["...", ...] }
 *
 * Authenticated by the shared hub secret (WS_TICKET_SECRET), not a user session
 * — the caller is the hub process, mirroring POST /internal/games.
 *
 * NOTE: a puzzle's `fen` is the position BEFORE the opponent's setup move
 * (Lichess convention), i.e. a balanced, realistic middlegame — exactly what we
 * want two near-equal engines to fight from. We do NOT advance it by moves[0]
 * (that would hand one side a tactic and produce lopsided games). The theme tag
 * describes the puzzle's solution, so it only selects a *class* of believable
 * middlegames here — it does not put that motif on the board.
 */
class FillerFensController extends Controller
{
    /** Bound from ?theme= ; empty means any theme. */
    public string $theme = 'pin';

    /** Bound from ?n= ; how many FENs to return. */
    public int $n = 200;

    public function get(): JsonResponse
    {
        if (!$this->authorized()) {
            return JsonResponse::unauthorized('bad hub secret');
        }

        $theme = trim($this->theme);
        $limit = max(1, min(500, $this->n));

        if ($theme !== '') {
            $sql = 'SELECT p.fen FROM puzzle_theme pt
                    JOIN puzzle p ON p.id = pt.puzzle_id
                    WHERE pt.theme = ?
                    ORDER BY RAND() LIMIT ' . $limit;
            $rows = App::db()->raw($sql, [$theme]);
        } else {
            $sql = 'SELECT fen FROM puzzle ORDER BY RAND() LIMIT ' . $limit;
            $rows = App::db()->raw($sql, []);
        }

        $fens = array_values(array_filter(array_map(
            static fn (array $r): string => (string)($r['fen'] ?? ''),
            $rows,
        ), static fn (string $f): bool => $f !== ''));

        return JsonResponse::ok(['fens' => $fens]);
    }

    private function authorized(): bool
    {
        $secret = (string) (App::config('gomachine.ws_ticket_secret') ?? '');
        if ($secret === '') {
            return false;
        }

        $provided = '';
        foreach ($this->request->headers ?? [] as $k => $v) {
            if (strcasecmp((string)$k, 'X-Hub-Secret') === 0) {
                $provided = is_array($v) ? (string)reset($v) : (string)$v;
                break;
            }
        }

        return $provided !== '' && hash_equals($secret, $provided);
    }
}

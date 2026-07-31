<?php

use BaseApi\App;
use App\Controllers\HealthController;
use App\Controllers\LoginController;
use App\Controllers\LogoutController;
use App\Controllers\MeController;
use App\Controllers\SignupController;
use App\Controllers\FileUploadController;
use App\Controllers\BenchmarkController;
use App\Controllers\OpenApiController;
use App\Controllers\ApiTokenController;
use App\Controllers\StreamController;
use App\Controllers\BotGameController;
use App\Controllers\BotMoveController;
use App\Controllers\BotUndoController;
use App\Controllers\GuessGameController;
use App\Controllers\GuessAnswerController;
use App\Controllers\AnalyzeController;
use App\Controllers\DuckLegalMovesController;
use App\Controllers\DuckMoveController;
use App\Controllers\DuckAnalyzeController;
use App\Controllers\AntichessAnalyzeController;
use App\Controllers\SfAnalyzeController;
use App\Controllers\CandidatesController;
use App\Controllers\EngineMatchController;
use App\Controllers\WsTicketController;
use App\Controllers\StatsController;
use App\Controllers\WatchController;
use App\Controllers\GameResultController;
use App\Controllers\FillerFensController;
use App\Controllers\BotChatController;
use App\Controllers\GameController;
use App\Controllers\GameAnalysisController;
use App\Controllers\GameMovesAnalysisController;
use App\Controllers\ProfileController;
use App\Controllers\ProfileGamesController;
use App\Controllers\ProfileUpdateController;
use App\Controllers\PuzzleController;
use App\Controllers\DailyPuzzleController;
use App\Controllers\LeaderboardController;
use App\Controllers\StreakController;
use App\Controllers\AdminFlagsController;
use App\Controllers\AdminDashboardController;
use App\Controllers\AdminUsersController;
use App\Controllers\AdminGamesController;
use App\Controllers\AdminGameAnticheatController;
use App\Controllers\FriendController;
use App\Controllers\FriendRequestsController;
use App\Controllers\FriendAcceptController;
use App\Controllers\FriendDeclineController;
use App\Controllers\NotificationController;
use App\Controllers\NotificationReadController;
use App\Controllers\NotificationReadAllController;
use App\Controllers\ChallengeController;
use App\Controllers\ChallengeAcceptController;
use App\Controllers\ChallengeDeclineController;
use App\Controllers\TournamentController;
use App\Controllers\TournamentJoinController;
use App\Controllers\TournamentWithdrawController;
use App\Controllers\ArenaInternalController;
use BaseApi\Http\Middleware\RateLimitMiddleware;
use BaseApi\Http\SessionStartMiddleware;
use BaseApi\Permissions\PermissionsMiddleware;
use App\Middleware\CombinedAuthMiddleware;
use App\Middleware\OptionalAuthMiddleware;

$router = App::router();

// ================================
// Public Endpoints (No Auth)
// ================================

// Health check
$router->get('/health', [
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    HealthController::class,
]);

// Benchmark endpoint (no middleware for performance testing)
$router->get('/benchmark', [BenchmarkController::class]);

// ================================
// VS-Bot (guest play, no auth) — SPEC §6
// ================================

// Create a new game vs the AI: { level?: 0..10, human_color?: "w"|"b" }
$router->post('/bot-games', [
    RateLimitMiddleware::class => ['limit' => '300/1m'],
    BotGameController::class,
]);

// Fetch a game's current state + legal moves
$router->get('/bot-games/{id}', [BotGameController::class]);

// Submit the human's move (UCI), get the bot's reply: { move: "e2e4" }
$router->post('/bot-games/{id}/move', [
    RateLimitMiddleware::class => ['limit' => '1200/1m'],
    BotMoveController::class,
]);

// Take back the human's last move (and any bot reply since)
$router->post('/bot-games/{id}/undo', [
    RateLimitMiddleware::class => ['limit' => '1200/1m'],
    BotUndoController::class,
]);

// ================================
// Guess the Elo (guest play, no auth) — SPEC §Guess the Elo
// ================================

// Generate a new round: the server plays a full gomachine-vs-itself game at a
// SECRET target Elo and returns ONLY the moves (never the rating). Generation is
// heavy (a full self-play game per call), so rate-limit it tightly. Session is
// OPTIONAL: a signed-in player is recorded as the round's owner.
$router->post('/guess-the-elo', [
    SessionStartMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '30/1m'],
    GuessGameController::class,
]);

// Lock in a guess and reveal the answer: { guess } → { actual, delta, score, ... }
$router->post('/guess-the-elo/{id}/guess', [
    SessionStartMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '120/1m'],
    GuessAnswerController::class,
]);

// Full-strength eval of a position (drives the eval bar): { fen }
// SessionStartMiddleware is optional-auth here: it lets the anti-cheat harness
// attribute the call to a logged-in user (to flag analysis during a live game);
// anonymous callers still analyze freely.
$router->post('/analyze', [
    SessionStartMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '1200/1m'],
    AnalyzeController::class,
]);

// Duck Chess free-play on the analysis board — PUBLIC, stateless, no persisted
// game. Legal piece moves for a position: { fen, duck? } → { moves }
$router->post('/duck/legal-moves', [
    RateLimitMiddleware::class => ['limit' => '1200/1m'],
    DuckLegalMovesController::class,
]);

// Validate + apply a composite duck move: { fen, duck?, move } → resulting
// position (+ next legal moves while ongoing)
$router->post('/duck/move', [
    RateLimitMiddleware::class => ['limit' => '1200/1m'],
    DuckMoveController::class,
]);

// Full-strength duck engine analysis (eval bar + best move): { fen, duck?, movetime? }
$router->post('/duck/analyze', [
    RateLimitMiddleware::class => ['limit' => '1200/1m'],
    DuckAnalyzeController::class,
]);

// Full-strength Antichess engine analysis (eval bar + best LEGAL move): { fen,
// movetime? }. The standard /analyze can't serve antichess — it plays by standard
// rules, so its "best move" is often illegal here (ignores compulsory capture).
$router->post('/antichess/analyze', [
    RateLimitMiddleware::class => ['limit' => '1200/1m'],
    AntichessAnalyzeController::class,
]);

// Full-strength Stockfish best move for the analysis board's optional
// second-opinion arrow: { fen, movetime? }. Spawns a Stockfish per call, so
// rate-limit it a little tighter than /analyze.
$router->post('/sf-analyze', [
    SessionStartMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '300/1m'],
    SfAnalyzeController::class,
]);

// Opening explorer for the analysis board: opening name + per-move eval
// (MultiPV): { fen, history?, multipv?, movetime?, depth? }
$router->post('/candidates', [
    RateLimitMiddleware::class => ['limit' => '1200/1m'],
    CandidatesController::class,
]);

// Admin-only "engine vs engine" — one ply of gomachine(rating) vs Stockfish(elo).
// CombinedAuthMiddleware authenticates; the controller enforces role === 'admin'.
$router->post('/admin/engine-vs/move', [
    CombinedAuthMiddleware::class,
    EngineMatchController::class,
]);

// Admin anti-cheat review (SPEC §Anti-cheat). CombinedAuthMiddleware
// authenticates; the controller enforces role === 'admin'. Detection only
// flags — an admin reviews here and decides (including banning).
$router->get('/admin/flags', [
    CombinedAuthMiddleware::class,
    AdminFlagsController::class,
]);
$router->get('/admin/flags/{userId}', [
    CombinedAuthMiddleware::class,
    AdminFlagsController::class,
]);
$router->post('/admin/flags/{userId}', [
    CombinedAuthMiddleware::class,
    AdminFlagsController::class,
]);
// Mark a single flag EVENT reviewed/unreviewed: { reviewed:bool }
$router->post('/admin/flags/{userId}/events/{eventId}', [
    CombinedAuthMiddleware::class,
    AdminFlagsController::class,
]);

// Admin panel (Wave 1). CombinedAuthMiddleware authenticates; each controller
// enforces role === 'admin' via the AdminGuard trait.

// Dashboard aggregate counts (users / games / anti-cheat) + live lobby probe
$router->get('/admin/dashboard', [
    CombinedAuthMiddleware::class,
    AdminDashboardController::class,
]);

// User directory: filtered/sorted/paginated list + per-user detail
$router->get('/admin/users', [
    CombinedAuthMiddleware::class,
    AdminUsersController::class,
]);
$router->get('/admin/users/{id}', [
    CombinedAuthMiddleware::class,
    AdminUsersController::class,
]);

// Persisted-game log: newest-first, paginated, filterable by bot/human + category
$router->get('/admin/games', [
    CombinedAuthMiddleware::class,
    AdminGamesController::class,
]);

// Per-game anti-cheat telemetry (move times + analysis summary + game flags)
$router->get('/admin/games/{id}/anticheat', [
    CombinedAuthMiddleware::class,
    AdminGameAnticheatController::class,
]);

// WebSocket ticket for the realtime hub. Session is optional: a logged-in user
// gets an account identity (rated play); anonymous callers get a casual ticket.
$router->get('/ws-ticket', [
    SessionStartMiddleware::class,
    OptionalAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '300/1m'],
    WsTicketController::class,
]);

// Live lobby counts (players online + active games) — proxies the realtime hub
$router->get('/stats', [
    RateLimitMiddleware::class => ['limit' => '1200/1m'],
    StatsController::class,
]);

// Top live games for the Watch page — proxies the realtime hub
$router->get('/watch', [
    RateLimitMiddleware::class => ['limit' => '1200/1m'],
    WatchController::class,
]);

// Public leaderboard — top players for one rating category (?category=blitz)
$router->get('/leaderboard', [
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    LeaderboardController::class,
]);

// "The Flame" — the current user's daily-activity streak for the homepage widget.
// Session is OPTIONAL: anonymous callers get a neutral empty streak (no 401).
$router->get('/streak', [
    SessionStartMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    StreakController::class,
]);

// Internal: the realtime hub persists finished games here (secret-gated, no session)
$router->post('/internal/games', [GameResultController::class]);

// Internal: the hub seeds self-play watch fillers from realistic midgame puzzle
// positions (secret-gated, no session). Fetched once at hub startup.
$router->get('/internal/filler-fens', [FillerFensController::class]);

// Internal: the hub voices a fill-in bot opponent in the in-game chat via OpenAI
// (secret-gated, no session). Returns 0..count short human-like lines.
$router->post('/internal/bot-chat', [BotChatController::class]);

// Fetch a finished live game by hub id (for the post-game analysis board)
$router->get('/games/{id}', [
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    GameController::class,
]);

// Full-game engine analysis (per-ply eval, best move, blunders) — cached on first call
$router->get('/games/{id}/analysis', [
    RateLimitMiddleware::class => ['limit' => '300/1m'],
    GameAnalysisController::class,
]);

// Stateless full-game analysis for an ad-hoc move list (bot games have no Game
// row to key off): { moves: string[], startFen? }. Same payload shape as the
// route above, but never cached — every call is a fresh ~2s engine burst, so
// this is rate-limited tighter than the persisted (mostly cache-hit) route.
$router->post('/games/analysis', [
    RateLimitMiddleware::class => ['limit' => '60/1m'],
    GameMovesAnalysisController::class,
]);

// ================================
// Player profiles (public — ratings + record + game history, keyed by name)
// ================================
$router->get('/users/{name}', [
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    ProfileController::class,
]);

// Paginated game history for a profile ("load more")
$router->get('/users/{name}/games', [
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    ProfileGamesController::class,
]);

// ================================
// Puzzles — Lichess-style training (SPEC §Puzzles)
// ================================
// Session is OPTIONAL: a logged-in user gets rating-matched + de-duped puzzles
// and an isolated rating_puzzle update; anonymous still solves casually.

// Puzzle of the day — one deterministic puzzle, same for everyone all UTC day
$router->get('/puzzles/daily', [
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    DailyPuzzleController::class,
]);

// Serve the next puzzle near the solver's rating (solution withheld): ?theme=
$router->get('/puzzles/next', [
    SessionStartMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    PuzzleController::class,
]);

// Submit one player move (UCI), validated against the hidden solution line:
//   { move: "e2e4", fen: "<current FEN>", ply: 1, hinted: false }
$router->post('/puzzles/{id}/move', [
    SessionStartMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '1200/1m'],
    PuzzleController::class,
]);

// ================================  
// Authentication Endpoints
// ================================

// User registration
$router->post('/auth/signup', [
    SessionStartMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '5/1m'],
    SignupController::class,
]);

// User login
$router->post('/auth/login', [
    SessionStartMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '10/1m'],
    LoginController::class,
]);

// User logout (supports both session and API token auth)
$router->post('/auth/logout', [
    SessionStartMiddleware::class,
    CombinedAuthMiddleware::class,
    LogoutController::class,
]);

// ================================
// Protected Endpoints (Combined Auth)
// ================================

// Get current user info (supports both session and API token)
$router->get('/me', [
    CombinedAuthMiddleware::class,
    MeController::class,
]);

// Self-service profile edit (bio + country only — title is staff-assigned,
// never player-editable): { bio?: string|null, country?: string|null }
$router->post('/me/profile', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '30/1m'],
    ProfileUpdateController::class,
]);

// API token management (supports both session and API token)
$router->get('/api-tokens', [
    CombinedAuthMiddleware::class,
    ApiTokenController::class,
]);

$router->post('/api-tokens', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '10/1h'],
    ApiTokenController::class,
]);

$router->delete('/api-tokens/{id}', [
    CombinedAuthMiddleware::class,
    ApiTokenController::class,
]);

// ================================
// File Upload Examples
// ================================

// Basic file upload
$router->post('/files/upload', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '10/1m'],
    FileUploadController::class,
]);

// Get file info
$router->get('/files/info', [
    CombinedAuthMiddleware::class,
    FileUploadController::class,
]);

// Delete files (with permission check example)
$router->delete('/files', [
    CombinedAuthMiddleware::class,
    PermissionsMiddleware::class => ['node' => 'files.delete'],
    FileUploadController::class,
]);

// ================================
// Permission-Protected Examples
// ================================
// 
// Examples of using PermissionsMiddleware:
//
// $router->post('/admin/users', [
//     CombinedAuthMiddleware::class,
//     PermissionsMiddleware::class => ['node' => 'admin.users.create'],
//     AdminUsersController::class,
// ]);
//
// $router->get('/premium/content', [
//     CombinedAuthMiddleware::class,
//     PermissionsMiddleware::class => ['node' => 'content.premium'],
//     PremiumContentController::class,
// ]);
//
// Wildcard permission example:
// $router->post('/export/csv', [
//     CombinedAuthMiddleware::class,
//     PermissionsMiddleware::class => ['node' => 'export.csv'],
//     ExportController::class,
// ]);
// 
// This would match permissions like 'export.*' or 'export.csv'

// ================================
// Friends, notifications, directed challenges
// ================================
// All authed (CombinedAuthMiddleware: session cookie OR bearer token).

// Accepted friends list: id/name/title/rating/online — POST sends a request
// (or auto-accepts a mutual pending one); DELETE unfriends or cancels an
// outgoing request.
$router->get('/friends', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    FriendController::class,
]);
$router->post('/friends', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '60/1m'],
    FriendController::class,
]);
$router->delete('/friends/{id}', [
    CombinedAuthMiddleware::class,
    FriendController::class,
]);

// Pending requests, split by direction: { incoming: [...], outgoing: [...] }
$router->get('/friends/requests', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    FriendRequestsController::class,
]);

// Accept/decline an incoming friend request — addressee only.
$router->post('/friends/{id}/accept', [
    CombinedAuthMiddleware::class,
    FriendAcceptController::class,
]);
$router->post('/friends/{id}/decline', [
    CombinedAuthMiddleware::class,
    FriendDeclineController::class,
]);

// In-app notification feed (friend requests/accepts, challenges): { items, unread }
$router->get('/notifications', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    NotificationController::class,
]);
$router->post('/notifications/read', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '300/1m'],
    NotificationReadController::class,
]);
$router->post('/notifications/read-all', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '300/1m'],
    NotificationReadAllController::class,
]);

// Directed, persistent challenges — bound to a specific opponent from
// creation (unlike the hub's ephemeral 6-char code link). GET splits pending,
// non-expired challenges by direction; DELETE is the challenger cancelling.
$router->post('/challenges', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '60/1m'],
    ChallengeController::class,
]);
$router->get('/challenges', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    ChallengeController::class,
]);
$router->delete('/challenges/{id}', [
    CombinedAuthMiddleware::class,
    ChallengeController::class,
]);

// Accept mints a hub join code and returns { code } (opponent only); decline
// notifies the challenger (opponent only).
$router->post('/challenges/{id}/accept', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '60/1m'],
    ChallengeAcceptController::class,
]);
$router->post('/challenges/{id}/decline', [
    CombinedAuthMiddleware::class,
    ChallengeDeclineController::class,
]);

// ================================
// Arena tournaments (Lichess-style) — SPEC Arena
// ================================
// Public list + detail (status is derived from starts_at/duration at read time,
// see Tournament::reconcileStatus()); create is admin-only (AdminGuard, checked
// inside TournamentController::post()); join/withdraw require an account.

$router->get('/tournaments', [
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    TournamentController::class,
]);
$router->post('/tournaments', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '60/1m'],
    TournamentController::class,
]);
$router->get('/tournaments/{id}', [
    RateLimitMiddleware::class => ['limit' => '600/1m'],
    TournamentController::class,
]);
$router->post('/tournaments/{id}/join', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '60/1m'],
    TournamentJoinController::class,
]);
$router->post('/tournaments/{id}/withdraw', [
    CombinedAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '60/1m'],
    TournamentWithdrawController::class,
]);

// Internal: the hub polls this to drive Arena pairing (secret-gated, no session)
$router->get('/internal/arenas/active', [ArenaInternalController::class]);

// ================================
// Development Only
// ================================

if (App::config('app.env') === 'local') {
    // OpenAPI schema for API documentation
    $router->get('/openapi.json', [OpenApiController::class]);

    $router->get('/stream', [
        RateLimitMiddleware::class => ['limit' => '10/1m'],
        StreamController::class,
    ]);
}

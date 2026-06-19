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
use App\Controllers\AnalyzeController;
use App\Controllers\EngineMatchController;
use App\Controllers\WsTicketController;
use App\Controllers\StatsController;
use App\Controllers\WatchController;
use App\Controllers\GameResultController;
use App\Controllers\GameController;
use App\Controllers\GameAnalysisController;
use App\Controllers\PuzzleController;
use BaseApi\Http\Middleware\RateLimitMiddleware;
use BaseApi\Http\SessionStartMiddleware;
use BaseApi\Permissions\PermissionsMiddleware;
use App\Middleware\CombinedAuthMiddleware;

$router = App::router();

// ================================
// Public Endpoints (No Auth)
// ================================

// Health check
$router->get('/health', [
    RateLimitMiddleware::class => ['limit' => '60/1m'],
    HealthController::class,
]);

// Benchmark endpoint (no middleware for performance testing)
$router->get('/benchmark', [BenchmarkController::class]);

// ================================
// VS-Bot (guest play, no auth) — SPEC §6
// ================================

// Create a new game vs the AI: { level?: 0..10, human_color?: "w"|"b" }
$router->post('/bot-games', [
    RateLimitMiddleware::class => ['limit' => '30/1m'],
    BotGameController::class,
]);

// Fetch a game's current state + legal moves
$router->get('/bot-games/{id}', [BotGameController::class]);

// Submit the human's move (UCI), get the bot's reply: { move: "e2e4" }
$router->post('/bot-games/{id}/move', [
    RateLimitMiddleware::class => ['limit' => '180/1m'],
    BotMoveController::class,
]);

// Take back the human's last move (and any bot reply since)
$router->post('/bot-games/{id}/undo', [
    RateLimitMiddleware::class => ['limit' => '180/1m'],
    BotUndoController::class,
]);

// Full-strength eval of a position (drives the eval bar): { fen }
$router->post('/analyze', [
    RateLimitMiddleware::class => ['limit' => '120/1m'],
    AnalyzeController::class,
]);

// Admin-only "engine vs engine" — one ply of gomachine(rating) vs Stockfish(elo).
// CombinedAuthMiddleware authenticates; the controller enforces role === 'admin'.
$router->post('/admin/engine-vs/move', [
    CombinedAuthMiddleware::class,
    EngineMatchController::class,
]);

// WebSocket ticket for the realtime hub. Session is optional: a logged-in user
// gets an account identity (rated play); anonymous callers get a casual ticket.
$router->get('/ws-ticket', [
    SessionStartMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '60/1m'],
    WsTicketController::class,
]);

// Live lobby counts (players online + active games) — proxies the realtime hub
$router->get('/stats', [
    RateLimitMiddleware::class => ['limit' => '120/1m'],
    StatsController::class,
]);

// Top live games for the Watch page — proxies the realtime hub
$router->get('/watch', [
    RateLimitMiddleware::class => ['limit' => '120/1m'],
    WatchController::class,
]);

// Internal: the realtime hub persists finished games here (secret-gated, no session)
$router->post('/internal/games', [GameResultController::class]);

// Fetch a finished live game by hub id (for the post-game analysis board)
$router->get('/games/{id}', [
    RateLimitMiddleware::class => ['limit' => '120/1m'],
    GameController::class,
]);

// Full-game engine analysis (per-ply eval, best move, blunders) — cached on first call
$router->get('/games/{id}/analysis', [
    RateLimitMiddleware::class => ['limit' => '30/1m'],
    GameAnalysisController::class,
]);

// ================================
// Puzzles — Lichess-style training (SPEC §Puzzles)
// ================================
// Session is OPTIONAL: a logged-in user gets rating-matched + de-duped puzzles
// and an isolated rating_puzzle update; anonymous still solves casually.

// Serve the next puzzle near the solver's rating (solution withheld): ?theme=
$router->get('/puzzles/next', [
    SessionStartMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '120/1m'],
    PuzzleController::class,
]);

// Submit one player move (UCI), validated against the hidden solution line:
//   { move: "e2e4", fen: "<current FEN>", ply: 1 }
$router->post('/puzzles/{id}/move', [
    SessionStartMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '240/1m'],
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

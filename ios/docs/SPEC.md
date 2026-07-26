# chessgo iOS — SPEC

Native SwiftUI client with full feature parity to the chessgo web app. Talks to the existing BaseAPI (`/analyze`, bot games, puzzles, stats, auth) over HTTPS and the gomachine hub over WebSocket for live play. The engine/hub is the rules authority; this client never generates legal moves or judges positions.

Reference material (read before building your wave): `docs/analysis/{rest-api,ws-protocol,ios-patterns,auth-decision,frontend-features}.md`.

## Non-negotiables
- **KISS.** Small files (<400 lines), one concern each. No libraries unless a wave truly needs one (default: none — hand-rolled URLSession + Keychain, like lairner).
- **Deployment target iOS 18.0.** Use Liquid Glass where available via `#available(iOS 26.0, *)` with a graceful pre-26 fallback (coalla's `.glassed()` pattern). Never hard-require 26 APIs unguarded.
- **Rules authority = server.** Client parses FEN for rendering, applies moves visually, filters/highlights from server `legalMoves`, and submits UCI. No client-side legality/check/mate/draw logic. (`frontend/src/lib/chess.ts` boundary.)
- **Env switch:** simulator → `http://127.0.0.1:6464` (API) / ws from ticket; device (Debug or Release) → `https://chessgo-api.timanthonyalexander.de`. Never hardcode the ws URL — read `wsUrl` from `/ws-ticket`.
- **Auth = bearer token in Keychain** (see auth-decision.md). Guest play works with no token.
- **State = `@Observable @MainActor`** stores (lycea style), injected once at the App root via `.environment(_:)`. No Combine.
- **Design/copy bar:** HUMANWRITING.md + VIBECODING.md. Constrained palette, whitespace over nested cards, SF Symbols not emoji, one typeface two weights, no purple→indigo gradients, plain confident copy.
- **Immutability:** value-type models, return new copies, never mutate shared state in place.

## Gotcha: don't construct `@Default`-wrapped models in code
Models in `Models/` use `@Default*` property wrappers (schema-drift safety on decode). Because the wrapped value is a generic associated type, Swift's synthesized **memberwise initializer demands the wrapper type, not the raw value** — so `SomeModel(field: 5)` fails to compile. For `#Preview`/test fixtures, either decode from a JSON string literal, use a provided `.mock`/`.preview` factory, or (for a small always-present leaf value type) it's declared as a plain `Codable` struct with default values. Do NOT hand-write memberwise constructions of `@Default` models. If you need one and it lacks an initializer, ask the orchestrator to add an explicit init rather than fighting the wrapper.

## Concurrency note (Xcode 26 project settings)
`SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor` + `SWIFT_APPROACHABLE_CONCURRENCY = YES`. Everything is MainActor-isolated by default. Network work is `async` (URLSession hops off main automatically). Mark pure background helpers `nonisolated` only if needed. Don't fight it.

## Project layout (all under `ios/chessgo/`, file-system-synchronized — just add files, no pbxproj edits)
```
chessgoApp.swift            App entry: build stores, inject, bootstrap
Core/
  APIConfig.swift           base URL switch
  APIClient.swift           singleton, generic send<T>, bearer header, decode diagnostics
  APIError.swift            enum
  Resilient.swift           @Default* property wrappers (schema-drift safety)
  KeychainHelper.swift      token + anonymousId
  Reachability.swift        NWPathMonitor @Observable
  Log.swift                 os.Logger wrapper
Models/                     Codable DTOs (User, Ratings, BotGame, GameMove, Puzzle, LiveGameState, Analysis, LeaderboardEntry, Profile, ...)
Services/                   stateless structs, `static let shared`, wrap APIClient:
  AuthService, BotService, PuzzleService, AnalysisService, ProfileService, StatsService, WsTicketService
State/                      @Observable stores: AuthStore, SocketStore (live game WS), SettingsStore, ThemeStore
Chess/                      ChessBoard (FEN parse + visual apply + 960 castling + ep/promo), Square, Piece, UCI, PremoveChain, variant move-format helpers
Theme/                      Theme (colors/spacing/type), LiquidGlass (.glassed / prominent button), PieceSet, BoardTheme
Views/
  Root/                     RootTabView, nav shell
  Auth/                     AuthSheet (login/signup)
  Board/                    BoardView, SquareView, PieceView, PromotionPicker, PocketView, EvalBar, MoveListView, Clock
  Home/                     Home lobby, QuickPairing, SearchingSheet, ChallengeSheet, widgets
  Live/                     LiveGameView (+ offers, chat, resume/disconnect UI)
  Bot/                      BotSetupView, BotGameView, VariantPicker
  Puzzles/                  PuzzlesView
  Analysis/                 AnalysisView (later)
  Profile/                  ProfileView, RatingsPanel, GamesPanel
  Spectate/                 WatchView, SpectateView (later)
  Settings/                 SettingsView, AppearanceView
  Components/               shared: Avatar, RatingBadge, ConfirmDialog, LoadingView, ErrorView
Sound/                      SoundEngine + baked assets (or AVAudioEngine synth)
Assets.xcassets            app icon, colors, piece SVGs/PDFs
Info.plist                 ATS localhost exception (NSAllowsLocalNetworking)
```

## Backend patches (BaseAPI, chessgo repo — do in Wave 0, follow baseapi conventions, no DDL)
1. **Port `OptionalAuthMiddleware`** from `~/lairner/app/Middleware/OptionalAuthMiddleware.php` → `chessgo/app/Middleware/OptionalAuthMiddleware.php` (same `ApiToken::findByToken`/`App::userProvider()` chessgo already uses). Add it to the `/ws-ticket` route in `routes/api.php` (after SessionStart, before RateLimit). Populates `$request->user` from bearer OR session; never 401s → anonymous casual play still works, logged-in bearer clients now get rated tickets.
2. **Mint token inline on auth:** in `LoginController` and `SignupController`, after success create an `ApiToken` and add `api_token` (one-time plaintext) to the JSON response (backward-compatible; web ignores it). Saves the client a round trip. If risky, skip — client falls back to `POST /api-tokens` using the login session cookie.
Verify: `php -l` clean; existing session/web flows untouched; no migration needed (ApiToken table exists).

## Waves

### Wave 0 — Foundation (orchestrator builds; everything depends on it)
Project config (deploy 18.0, iOS-only platforms, Info.plist ATS, bundle id), backend patches, `Core/*`, `Models/*` (from rest-api.md shapes), `Services/*` (thin), `Theme/*` + `LiquidGlass`, `Chess/*` board engine (FEN parse + visual apply + premove chain + variant move formats), `chessgoApp.swift` + `RootTabView` skeleton (tabs: Play, Puzzles, Watch, Profile). Compile clean (simulator). This is the shared contract — get it right before fan-out.

### Wave 1 — Board + Auth (parallel, after foundation compiles)
- **Board views** (`Views/Board/*`): BoardView (tap + drag, one commit path), promotion picker from server options, last-move/check/legal highlights, coordinates, animation, premove highlighting, EvalBar, Clock, MoveList, PocketView (Crazyhouse), Duck glyph. Driven by an abstract `BoardControl` protocol (fen, myTurn, legalMoves, submit, canPremove) so bot/live/puzzle reuse it.
- **Auth** (`Views/Auth/*` + `State/AuthStore`): login/signup sheet, guest mode, cold-launch `/me` validate, post-game `refresh()` poll pattern, logout (revoke token). AuthStore is the identity source for the socket.

### Wave 2 — Play modes (parallel; depend on Board + Auth + Services)
- **Bot games** (`Views/Bot/*`): setup (variant, strength 0/700-3500, color), stateless REST loop, all 8 variants incl. Duck two-phase + Crazyhouse drops, eval bar, undo, client-local resign/new-game.
- **Live game + socket** (`State/SocketStore` + `Views/Live/*`): full WS protocol (ws-protocol.md) — connect/ticket/reconnect-resume, queue/matched, move/state, clocks (local countdown + freeze first 2 plies), resign/draw/takeback, chat, opponentGone/Back, rating delta from GET /games/{id}, premoves.
- **Lobby/Home** (`Views/Home/*`): QuickPairing presets + variant pools, SearchingSheet (10s bot-backfill softening), ResumeBanner, ChallengeSheet (create code + join), stats poll, widgets (daily puzzle, recent games, leaderboard, live ticker).
- **Puzzles** (`Views/Puzzles/*`): theme + time-format, next/daily, move submit, multi-move continuation, solution reveal, session summary, rating refresh.

### Wave 3 — Secondary (parallel)
- **Profile/leaderboard/streak** (`Views/Profile/*`): read-only ratings panel, record, paginated games → analysis.
- **Settings/theming** (`Views/Settings/*` + SettingsStore/ThemeStore): prefs (instant-apply), board/piece themes, light/dark/palette, sound toggles.
- **Sound** (`Sound/*`): baked assets for move/capture/castle/promote/check(silence)/lowTime/success/end with the playForSan precedence; own-move-on-touch timing; AVAudioSession setup.
- **Analysis** (`Views/Analysis/*`): load by game id, move tree/variations, progressive-depth eval ladder, opening explorer, SF second opinion, eval bar (cp scale 0.5).
- **Spectate** (`Views/Spectate/*`): watch lobby poll + read-only spectate socket.

### Wave 4 — Integration & polish (orchestrator)
Wire RootTabView, resume banner, deep-link `/challenge/:code` equivalent, cross-screen nav, build-fix pass, simulator smoke test, screenshots.

## Build / verify
- Fans pinned 2400 RPM before any compile. Simulator build:
  `xcodebuild -project ios/ios.xcodeproj -scheme chessgo -sdk iphonesimulator -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 16 Pro' build`
- Each wave must compile clean before merge. Subagents own separate folders (no file conflicts under the synced group).
- Backend patches verified with `php -l` and a local curl against :6464.

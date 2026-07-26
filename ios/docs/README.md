# chessgo iOS — as-built

Native SwiftUI client for the chessgo platform. Full parity with the web app.

- **Design + plan:** `SPEC.md`
- **Contracts / research:** `analysis/rest-api.md`, `analysis/ws-protocol.md`,
  `analysis/auth-decision.md`, `analysis/ios-patterns.md`, `analysis/frontend-features.md`

## Build / run
- Open `ios/ios.xcodeproj` in **Xcode 27** (target/scheme `chessgo`, deployment **iOS 18**).
- Run on the **Simulator** → app talks to the local dev API at `http://127.0.0.1:6464`
  (and the hub via the `wsUrl` from `/ws-ticket`). Start the backend first (`chessgo-up`).
- Run on a **device** → app talks to production: `https://chessgo-api.timanthonyalexander.de`
  (set your signing team in Xcode).
- The env switch is a single `#if targetEnvironment(simulator)` in `Core/APIConfig.swift`.
- Files live in a file-system-synchronized group — adding a `.swift` file under
  `ios/chessgo/` needs no `project.pbxproj` edit.

## What's implemented
Auth (guest + login/signup), Home lobby + matchmaking (presets, variant pools,
challenges), live human games (full hub WS protocol: clocks, draw/takeback/resign,
reconnect+resume, chat, premoves), bot games (all 8 variants incl. Duck two-phase +
Crazyhouse drops), puzzles, analysis (game review + free-explore eval ladder, opening
explorer, SF second opinion), profile/leaderboard/streak, spectate, settings (17 prefs),
sound (synthesized tones).

## Architecture (one-liners)
- **Auth = bearer token** in Keychain (not cookies). `Core/APIClient` adds
  `Authorization: Bearer`; login/signup return `api_token` inline (backend patch).
- **`@Observable @MainActor` stores** injected at the app root: `AuthStore`,
  `SocketStore` (+`LiveGameDriver`), `SettingsStore`, `SpectateStore`.
- **Engine owns the rules.** The client renders `fen`/`legalMoves`/`status` from the
  server and submits UCI. `Chess/` is FEN parsing + visual move application + a
  permissive premove-target generator only.
- **`BoardControl`** protocol is the one abstraction every mode (bot/live/puzzle/
  analysis/spectate) drives the shared `BoardView` through.
- **Pieces:** cburnett vector set (GPLv2+) in `Assets.xcassets`, matching the web default.
- Schema-drift safety: `Core/Resilient.swift` `@Default*` wrappers. Gotcha: never
  memberwise-construct a `@Default`-wrapped model (decode fixtures instead).

## Backend changes this required (in the PHP app, kept)
- `app/Middleware/OptionalAuthMiddleware.php` — auth-if-present, never 401; added to the
  `/ws-ticket` route so a logged-in bearer client gets a **rated** ticket while anonymous
  play still works.
- `LoginController` / `SignupController` mint an `ApiToken` inline (`api_token` +
  `api_token_id` in the response; additive — the web SPA ignores it).

## Known gaps vs web (deliberate)
- One piece set (cburnett) + the built-in board colors — web has 16 boards / 6 piece sets.
- Locally-played analysis moves show UCI, not SAN (no client SAN generator; engine owns rules).
- Analysis is a linear mainline + one branch, not a full variation tree.
- Editor, Guess-the-Elo, and Admin screens were scoped out.
- No custom app icon yet.
- `chessgoApp.swift` has a DEBUG-only `-uitestBoard` launch arg (headless board screenshot); off in Release.

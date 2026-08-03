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
- **Board themes + piece sets:** `Theme/BoardTheme.swift` ports the web catalog 1:1 —
  16 board palettes (`BoardThemeID`) and 7 piece sets (`PieceSetID`), same labels, same
  colors, same picker order. Board colors are ABSOLUTE (a theme must not shift with
  light/dark), so they live in `BoardPalette`, not `Theme.Colors`. Selection is two
  `SettingsStore` fields (`boardTheme`, `pieceSet`); **iOS defaults to Amethyst + Neo**
  (web defaults to Cherry + Cburnett). `BoardView` and `PieceView` read the store from
  the environment as an OPTIONAL (`@Environment(SettingsStore.self) var: SettingsStore?`),
  so every board — game, analysis, puzzles, spectate, home mini-boards — follows the
  choice with no per-call-site wiring, and previews with no store fall back to the
  defaults. Pickers are in `Views/Settings/AppearanceView.swift`.
- **Piece artwork:** `Assets.xcassets` holds `<set>_<code>` imagesets (e.g. `neo_wK`) —
  the web's vector sets rasterized to 384px PNG (Xcode's asset-catalog SVG support does
  not cover the `<text>`/CSS-styled sets), plus Neo's own 300px sprites. Cherry's two
  wood textures are `board_wood_light` / `board_wood_cherry`. Credits per set are on
  `PieceSetID.credit` and shown in the picker.
- Schema-drift safety: `Core/Resilient.swift` `@Default*` wrappers. Gotcha: never
  memberwise-construct a `@Default`-wrapped model (decode fixtures instead).

## Backend changes this required (in the PHP app, kept)
- `app/Middleware/OptionalAuthMiddleware.php` — auth-if-present, never 401; added to the
  `/ws-ticket` route so a logged-in bearer client gets a **rated** ticket while anonymous
  play still works.
- `LoginController` / `SignupController` mint an `ApiToken` inline (`api_token` +
  `api_token_id` in the response; additive — the web SPA ignores it).

## Known gaps vs web (deliberate)
- Site palette (6 accent/neutral families), page backdrop and the 5 sound materials are
  web-only: the iOS chrome is the fixed brass palette in `Theme.Colors` and the sound is
  `Sound/ToneSynth` with no material presets.
- Locally-played analysis moves show UCI, not SAN (no client SAN generator; engine owns rules).
- Analysis is a linear mainline + one branch, not a full variation tree.
- Editor, Guess-the-Elo, and Admin screens were scoped out.
- No custom app icon yet.
- `chessgoApp.swift` has a DEBUG-only `-uitestBoard` launch arg (headless board screenshot); off in Release.

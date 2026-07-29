# chessgo frontend — feature inventory for iOS parity

Rules authority = the engine/hub. The client NEVER generates legal moves, detects check/mate/draws, or validates legality. It renders from server `legalMoves`/`status`/`fen` and submits UCI. Replicate this split exactly in Swift (`lib/chess.ts` boundary).

## Routes (web) → iOS screens
| web | screen | priority |
|---|---|---|
| `/` | Home/lobby (mobile layout is a real component swap, reordered widgets) | core |
| `/bot` | Bot game (8 variants, untimed, stateless REST) | core |
| `/puzzles` | Puzzles | core |
| `/game/:id` | Live human game (WS) | core (centerpiece) |
| `/challenge/:code` | Challenge join (auto-join) | core |
| `/watch`, `/watch/:id` | Spectate lobby + game (read-only WS) | later |
| `/analysis`, `/analysis/:id` | Analysis board | later (largest/heaviest) |
| `/editor` | FEN/board editor (no PGN anywhere) | low |
| `/@/:name` | Profile (read-only) | mid |
| `/guess-the-elo` | Guess-the-Elo | low |
| `/admin/*` | admin | skip |

## Board interaction (the substrate — build first)
`useBoardInteraction` parameterized by `BoardControl {fen, myTurn, legalMoves, submit, canPremove}`:
- gesture → optimistic overlay shown IMMEDIATELY (before network) → sound synchronously in-gesture → `submit(uci)` → overlay cleared by fen-change effect (normal) or promise settle (revert on fail).
- Not your turn + canPremove → append to a **premove CHAIN** (not single). Board rendered folded through chain. On your turn, match chain head against real legalMoves (ignore promo piece); mismatch collapses whole chain. Premoves are client-only, never sent until legal.
- Same hook for bot (REST submit), live (WS fire-and-forget submit + premoves), puzzles (REST, no premoves).
- Board: click-to-move AND drag share one commit path (gated by `prefs.moveMethod` both/click/drag). Promotion picker from server `promo.options`. Right-click arrows/circles local-only. Legal highlights from server list verbatim; premove-target highlights use a permissive client geometry generator (ignores pins/check, re-validated server-side).
- Layout invariant: board pinned to a FIXED frame; side panels (move list, eval bar) never resize/shift the board.

## Auth store
- `init()` → GET /me, 401 = normal guest steady-state (not error). Guest play fully supported (bot/puzzles/casual/watch); guests lose persisted profile/rating.
- login/signup → then `reidentify()` the socket (re-mint ws-ticket under new identity).
- logout → clear local user even if network fails, then reidentify.
- **`refresh()` after a rated game/puzzle**: server persists Elo async/fire-and-forget → immediate /me is stale. Poll /me at [0,500,1000,2000,3500]ms comparing summed `games_*` vs baseline; apply the instant count increments. iOS MUST replicate or post-game ratings show stale.

## Live game (`socket.ts` singleton, survives navigation)
- connect() mints fresh ws-ticket then opens `wsUrl?ticket=`. On open, replay pending lobby intent (queue/createChallenge/joinChallenge). Reconnect: exp backoff min(1000·2^n,10000)ms.
- Game never abandoned on disconnect; on reconnect wait 1.5s for `resume` before assuming ended.
- **LiveGameState**: id,color,rated,variant,pool,timeControl,opponent{name,rating,anon},fen,sideToMove,lastMove,check,duck,pocket,status,legalMoves,clock{w,b}+clockAt(local receipt timestamp for live countdown),moves,result,reason,ended,opponentOnline,messages,drawOffer/takebackOffer(`'mine'|'theirs'|null`).
- Clocks freeze first 2 plies (Lichess-style, server-mirrored). `Clock` self-ticks 200ms INSIDE the leaf so parent doesn't re-render; urgency tiers normal/amber<30s/red<10s; <10s shows tenths.
- Move submit handles standard UCI, Crazyhouse drop `"P@e4"`, Duck composite `"e2e4:d5"` all through one call.
- History scrubbing: `viewIndex` (null=live) browses past plies read-only, clocks keep running, reconstructed by replaying UCIs from captured start-FEN (handles 960 back rank).
- Resign (confirm dialog if pref), draw offer/accept/decline, takeback offer/accept/decline (disabled 0 moves) — each an OfferBanner (Accept/Decline) or "offered…/cancel" state.
- **Rating delta**: read authoritative `GET /games/{id}` white/black_rating_before/after (NOT client diff — fixed a bogus-negative bug). Poll up to 8× at 600ms (hub persists fire-and-forget).
- Sound: own move synchronous in-gesture (also unlocks AudioContext on web; on iOS use AVAudioSession); opponent move via effect on moves.length advancing. Low-time warning once when own clock crosses `min(60000,max(8000,base/10))`, re-arms if increment lifts back. One end sound.
- Zen mode hides ratings/clocks/mode-card while in progress. Disconnected overlay pill. Opening name strip via candidates(multipv:1) — ECO+name only, no eval/moves mid-game.
- Post-game: Analyse/Edit/Play-bot actions; Lobby / New game (requeue same pool).

## Lobby/matchmaking (Home)
- `useHome`: status==='matched' → navigate /game/:id; poll GET /stats every 10s.
- ResumeBanner at top if a live game exists — most urgent thing shown.
- SearchingDialog: modal while queued, mm:ss counter, only Cancel dismisses; after 10s softens ("computer opponent shortly" — hub backfills bot) + "Play the computer instead".
- QuickPairingPanel: 12 TC presets (Bullet/Blitz/Rapid/Classical) + variant pools (Duck 5+0, Crazyhouse 3+0, Antichess 3+0) + Guess-the-Elo. Each cell shows Elo-range hint [rating±100 rounded 50] when signed in.
- Widgets: DailyPuzzle, RecentGames (signed-in), SignUp (guest), Leaderboard (6-cat toggle), LiveTv ticker.
- Challenges: create invite (TC, color W/Random/B, variant, rated toggle off if logged out; pool 0-180, reject 0+0) → `challengeCreated{code}` → shareable 6-char code + link, "waiting…" spinner; closing dialog withdraws invite. Join by 6-char code. `/challenge/:code` auto-joins.

## Bot games (`/bot`, stateless REST — one round trip returns human move + bot reply)
- VariantPicker: standard, chess960, duck, crazyhouse, antichess, fading, glassjaw, doublemove.
- Strength 700-3500 step 50 + sub-floor "Unlosable" (rating 0, standard only). fading/glassjaw hide slider (server decays Elo, display 3500). Color W/B/Random. Untimed. Settings persisted local.
- In-game: optimistic move + "Bot is thinking…" spinner; eval bar progressive [4,8,12,16] (not Duck/CH/Antichess); resign & new-game are 100% client-local (no server call); undo = POST undo (full round; not Duck/doublemove).
- Crazyhouse drops: tap pocket to arm, tap empty highlighted square → `"P@e4"`, same move endpoint; dropTargets filtered client-side from server legal_moves.
- Duck: two phases in ONE submission — piece move (optimistic) then duck placement (sound+submit `"e2e4:d5"`); DUCK_REVEAL_MS 550 hold before applying bot reply.
- Chess960: no special code; `random960()` + castling is a normal king move via server legal_moves.

## Puzzles (`/puzzles`)
Phases loading/intro/solving/checking/solved/failed/empty.
- Theme dropdown (13 themes), time format Sprint60/Blitz180/Marathon300/Untimed, persisted.
- GET /puzzles/next?theme= → show pre-move → auto-play setup opponent move (480ms) → interactive. Move → POST /puzzles/{id}/move {move,fen,ply}. Correct+complete → success sound, rating refresh, auto-advance (2000ms untimed/650ms timed). Multi-move correct → play scripted continuation, stay solving. Wrong → reveal solution overlay, failure sound. No hint button. Skip = next without logging. Session clock + low-time sound ≤10s; summary screen.

## Settings/theming (all device-local, no server sync, instant-apply no Save)
- prefs blob: showLegalMoves, showCoordinates, highlightLastMove/Check, animationSpeed, boardBrightness, autoQueen, moveMethod, premoves, notation, confirmResign, autoFlip, zenMode, showOpponentRating, showEvalBar, showMoveList, soundVolume, soundLowTime. Sanitize on load (malformed/future keys never throw — mirror the @Default philosophy).
- Site theme: mode light/dark/system, 6 palettes, backdrop flat/atmosphere/grid.
- Board theme: 16 board themes + 6 piece SVG sets (72 SVGs to port/license).
- Sound: web is Web-Audio modal synthesis, NO files. Event catalog: move, capture, castle/promote(→move), check(SILENCE), lowTime, success(arpeggio), end(bell). Precedence in playForSan: game-over → O-O castle → x capture → = promote → else move (capturing promotion sounds like capture). iOS pragmatic choice: bake short audio-file assets, keep the event/precedence catalog + own-move-on-touch timing.
- Nav: mobile hamburger → drawer, 44pt rows (HIG). Footer/chrome hidden on board routes (max viewport).

## Analysis (later — heaviest)
GET /games/{id}/analysis (retry 5×/1200ms on 404 race). Lichess-style branching move tree. Engine eval = poll 11-rung depth ladder (6/1200ms → 30/35000ms), render progressively, abort on nav. SF second-opinion toggle (/sf-analyze) = translucent arrow. Eval bar win% sigmoid, GOMACHINE_CP_SCALE=0.5 (native cp runs ~2× hot). Opening explorer is fed by the SAME ladder — rungs through depth 16 request `multipv:5` and their `lines` drive the move list; deeper rungs drop to one line (N lines cost ~N root searches) and the panel keeps the last list it got. One search per position, not two. Auto-play/auto-best modes. Blunder Rewind = graded retry of each blunder ply.

## iOS build priority (core → peripheral)
1. Board + move interaction + rules-split (substrate)
2. Auth + session (bearer token — see auth-decision.md)
3. Live game + socket store (matchmaking, clocks, resign/draw/takeback, reconnect/resume, premoves)
4. Bot games (all 8 variants, Duck two-phase, Crazyhouse drops)
5. Puzzles
6. Lobby/matchmaking UX (Home, QuickPair, Challenge, Searching)
7. Sound (baked assets)
8. Settings/theming
9. Analysis
10. Profile/stats/leaderboard/streak
11. Spectating
12. Editor / GuessTheElo / Admin (skip for v1)
